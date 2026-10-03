// The one model interface. Callers say which tier and job a call is for; the client picks the
// provider and model from the User's settings, applies the thinking level, enforces the monthly
// cap, and logs every call's tokens and cost to the usage ledger.
import type {
  ModelCall,
  ModelProvider,
  ModelSettings,
  ModelTier,
  ReasoningEffort,
  TierSetting,
} from '@commander/domain';
import { type ZodType, z } from 'zod';
import { ModelError } from './errors';
import type { UsageLedger } from './ledger';
import { costOf } from './prices';
import type { ChatMessage, ModelProviderAdapter, ProviderReply, TokenUsage } from './provider';

const NO_TOKENS: TokenUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };

export type CompleteRequest = {
  tier: ModelTier;
  // Which Agent job is calling, e.g. 'sort-email'. Logged with the call; per-job overrides key on it.
  job: string;
  messages: ChatMessage[];
  // Overrides the tier's thinking level for this call (a per-job override in settings wins over it).
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
};

// A JSON reply: with a schema it is validated, retried once with the validation error, and
// otherwise fails with ModelError 'invalid-reply'.
export type JsonRequest<T> = CompleteRequest &
  ({ schema: ZodType<T>; json?: true } | { json: true; schema?: never });

// A streamed reply: tokens as they arrive (Conversations need them), then the whole Completion.
export type StreamRequest = CompleteRequest & { stream: true; json?: never; schema?: never };
export type ModelStream = AsyncIterable<string> & { done: Promise<Completion> };

export type Usage = {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  latencyMs: number;
  // null when the model has no known price.
  costUsd: number | null;
};

export type Completion = {
  text: string;
  usage: Usage;
  tier: ModelTier;
  provider: ModelProvider;
  model: string;
};

export type ModelClient = {
  complete(request: StreamRequest): ModelStream;
  complete<T = unknown>(request: JsonRequest<T>): Promise<Completion & { json: T }>;
  complete(request: CompleteRequest): Promise<Completion>;
};

export type ModelClientOptions = {
  // Read for every call, so changes in Settings take effect at once.
  settings: () => ModelSettings | Promise<ModelSettings>;
  providers: Record<ModelProvider, ModelProviderAdapter>;
  ledger: UsageLedger;
  // The clock, in epoch milliseconds.
  now?: () => number;
};

type Route = { setting: TierSetting; reasoningEffort: ReasoningEffort; cap: number | null };

// Ares mentions the cap in an Update once the month's spend reaches this share of it.
const CAP_WARNING_SHARE = 0.8;

// Months run on the User's local calendar.
const monthStart = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
};
const monthKey = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

// Models in JSON mode sometimes still wrap the object in a Markdown fence.
function unfence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return fenced?.[1] ?? text;
}

// What's wrong with a reply, or the value it carries.
function readJson<T>(
  text: string,
  schema: ZodType<T> | undefined,
): { ok: true; value: T } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(unfence(text));
  } catch {
    return { ok: false, problem: 'it was not valid JSON' };
  }
  if (!schema) return { ok: true, value: value as T };
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, problem: `it did not match the expected shape:\n${z.prettifyError(result.error)}` };
}

// Turns a call that reports tokens through a callback into an async iterable of them.
function streamOf(run: (onToken: (token: string) => void) => Promise<Completion>): ModelStream {
  const queue: string[] = [];
  let finished = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const done = run((token) => {
    queue.push(token);
    notify();
  });
  done.then(
    () => {
      finished = true;
      notify();
    },
    (error: unknown) => {
      failure = error;
      finished = true;
      notify();
    },
  );
  return {
    done,
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  latencyMs: a.latencyMs + b.latencyMs,
  costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
});

export function createModelClient(options: ModelClientOptions): ModelClient {
  const now = options.now ?? Date.now;

  // Picks the model for a call. At the monthly cap, Deep calls go to the fallback model, or stop.
  async function route(settings: ModelSettings, request: CompleteRequest): Promise<Route> {
    let setting = settings.tiers[request.tier];
    const cap = settings.monthlyCapUsd;
    if (cap !== null && request.tier === 'deep') {
      const spent = await options.ledger.spentSince(monthStart(now()));
      if (spent >= cap) {
        if (!settings.deepFallback) {
          throw new ModelError(
            'over-cap',
            `This month's model spend ($${spent.toFixed(2)}) has reached the $${cap.toFixed(2)} cap, so Deep calls wait until next month.`,
          );
        }
        setting = settings.deepFallback;
      }
    }
    // The User's per-job choice wins over the caller's, which wins over the tier's.
    const reasoningEffort =
      settings.jobOverrides[request.job]?.reasoningEffort ??
      request.reasoningEffort ??
      setting.reasoningEffort;
    return { setting, reasoningEffort, cap };
  }

  // Records the month's warning once spend reaches 80% of the cap (the ledger keeps one per month).
  async function checkCap(cap: number | null) {
    if (cap === null) return;
    const at = now();
    const spentUsd = await options.ledger.spentSince(monthStart(at));
    if (spentUsd >= CAP_WARNING_SHARE * cap) {
      await options.ledger.recordCapWarning({ month: monthKey(at), at, spentUsd, capUsd: cap });
    }
  }

  // One request to a provider, logged to the ledger.
  async function call(
    request: CompleteRequest,
    { setting, reasoningEffort, cap }: Route,
    messages: ChatMessage[],
    json: boolean,
    onToken?: (token: string) => void,
  ): Promise<{ text: string; usage: Usage }> {
    const started = now();
    const provider = options.providers[setting.provider];
    const providerRequest = { setting, messages, reasoningEffort, json, signal: request.signal };
    const log = async (tokens: TokenUsage, outcome: ModelCall['outcome']): Promise<Usage> => {
      const usage = {
        ...tokens,
        latencyMs: Math.max(0, now() - started),
        costUsd: costOf(setting.provider, setting.model, tokens),
      };
      await options.ledger.record({
        at: started,
        job: request.job,
        tier: request.tier,
        provider: setting.provider,
        model: setting.model,
        ...usage,
        outcome,
      });
      await checkCap(cap);
      return usage;
    };

    let reply: ProviderReply;
    try {
      reply = onToken
        ? await provider.stream(providerRequest, onToken)
        : await provider.send(providerRequest);
    } catch (thrown) {
      const error =
        thrown instanceof ModelError
          ? thrown
          : new ModelError(
              'unavailable',
              `The model call failed: ${thrown instanceof Error ? thrown.message : thrown}`,
            );
      // With no key nothing was sent, so there is no call to log.
      if (error.kind !== 'no-key') await log(NO_TOKENS, error.kind);
      throw error;
    }
    return { text: reply.text, usage: await log(reply.usage, 'ok') };
  }

  async function streamed(request: StreamRequest, onToken: (token: string) => void): Promise<Completion> {
    const settings = await options.settings();
    const chosen = await route(settings, request);
    const reply = await call(request, chosen, request.messages, false, onToken);
    return { tier: request.tier, provider: chosen.setting.provider, model: chosen.setting.model, ...reply };
  }

  async function completed<T>(request: CompleteRequest & { json?: boolean; schema?: ZodType<T> }) {
    const settings = await options.settings();
    const chosen = await route(settings, request);
    const meta = { tier: request.tier, provider: chosen.setting.provider, model: chosen.setting.model };
    const wantsJson = request.json === true || request.schema !== undefined;

    const first = await call(request, chosen, request.messages, wantsJson);
    if (!wantsJson) return { ...meta, ...first };

    const firstRead = readJson(first.text, request.schema);
    if (firstRead.ok) return { ...meta, ...first, json: firstRead.value };

    // One more try, showing the model its reply and what was wrong with it.
    const retryMessages: ChatMessage[] = [
      ...request.messages,
      { role: 'assistant', content: first.text },
      {
        role: 'user',
        content: `That reply could not be used because ${firstRead.problem}\nReply again with only the corrected JSON object.`,
      },
    ];
    const second = await call(request, chosen, retryMessages, true);
    const secondRead = readJson(second.text, request.schema);
    if (!secondRead.ok) {
      throw new ModelError(
        'invalid-reply',
        `The model's JSON reply could not be used twice: ${secondRead.problem}`,
      );
    }
    return { ...meta, text: second.text, usage: addUsage(first.usage, second.usage), json: secondRead.value };
  }

  function complete(request: CompleteRequest & { stream?: boolean; json?: boolean; schema?: ZodType }) {
    if (request.stream) return streamOf((onToken) => streamed(request as StreamRequest, onToken));
    return completed(request);
  }

  return { complete } as ModelClient;
}
