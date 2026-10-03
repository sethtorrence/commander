// The Z.ai adapter: GLM-5.3-Flash over Z.ai's OpenAI-compatible chat completions API. Nothing here
// is Z.ai-only except the defaults and one error code, so any OpenAI-compatible server (a local
// llama-server later) works by changing a tier's base URL and model.
import type { ModelErrorKind } from '@commander/domain';
import { z } from 'zod';
import { ModelError } from './errors';
import type { ModelProviderAdapter, ProviderReply, ProviderRequest, TokenUsage } from './provider';

export type ZaiProviderOptions = {
  // Read for every call, so a new key takes effect at once. The key is used only in the
  // Authorization header: never logged, stored or put into a prompt.
  apiKey: () => Promise<string | null>;
  fetch?: typeof fetch;
  // How long one attempt may take; for a stream, the longest wait for the next piece. Default 2 min
  // (a Deep call at high thinking took 19 s in the evaluation).
  timeoutMs?: number;
  // Tries after the first on 429s, 5xx errors and dropped connections. Default 3.
  maxRetries?: number;
  // A Retry-After longer than this fails at once instead of waiting. Default 1 min.
  maxRetryAfterMs?: number;
  // The first back-off; it doubles with each retry, with jitter. Default 1 s.
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const usageShape = z
  .object({
    prompt_tokens: z.number().int().nonnegative().default(0),
    completion_tokens: z.number().int().nonnegative().default(0),
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().default(0) }).nullish(),
  })
  .nullish();

const completionShape = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
  usage: usageShape,
});

const chunkShape = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }).nullish() })).nullish(),
  usage: usageShape,
  error: z.object({ message: z.string().optional() }).nullish(),
});

const errorShape = z.object({
  error: z.object({ code: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }),
});

function toUsage(usage: z.infer<typeof usageShape>): TokenUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}

// Retry-After is either seconds or an HTTP date.
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

// Z.ai's code for an account out of credit, which it sends with HTTP 429.
const OUT_OF_CREDIT = '1113';

async function errorFor(response: Response, retryAfter: number | undefined): Promise<ModelError> {
  let code: string | undefined;
  let detail = '';
  try {
    const parsed = errorShape.safeParse(JSON.parse(await response.text()));
    if (parsed.success) {
      code = parsed.data.error.code === undefined ? undefined : String(parsed.data.error.code);
      detail = parsed.data.error.message?.slice(0, 300) ?? '';
    }
  } catch {
    // Not JSON: the status says enough.
  }
  const { status } = response;
  const said = detail ? ` It said: ${detail}` : '';
  const details = retryAfter === undefined ? { status } : { status, retryAfterMs: retryAfter };
  const fail = (kind: ModelErrorKind, message: string) => new ModelError(kind, `${message}${said}`, details);
  if (status === 401 || status === 403) return fail('auth', 'The model provider refused the API key.');
  if (status === 402 || code === OUT_OF_CREDIT)
    return fail('billing', 'The model provider account is out of credit.');
  if (status === 429) return fail('rate-limit', 'The model provider is rate limiting Commander.');
  if (status >= 500) return fail('unavailable', `The model provider is having trouble (HTTP ${status}).`);
  return fail('bad-request', `The model provider rejected the request (HTTP ${status}).`);
}

// Yields the JSON payload of each `data:` line of a server-sent event stream, until [DONE].
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        throw new ModelError('invalid-reply', 'The model sent a stream Commander could not read.');
      }
    }
  }
}

// One attempt's time limit, which also passes on the caller's cancellation. For streams, `extend`
// restarts the clock as each piece arrives.
function deadline(timeoutMs: number, outer: AbortSignal | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const extend = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const cancel = () => controller.abort();
  if (outer?.aborted) cancel();
  outer?.addEventListener('abort', cancel, { once: true });
  extend();
  return {
    signal: controller.signal,
    extend,
    // Why the attempt ended early, if it did.
    abortError: (): ModelError | null => {
      if (timedOut)
        return new ModelError('timeout', `The model did not answer within ${timeoutMs / 1000} s.`);
      if (outer?.aborted) return new ModelError('cancelled', 'The call was cancelled.');
      return null;
    },
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', cancel);
    },
  };
}

type Deadline = ReturnType<typeof deadline>;

export function createZaiProvider(options: ZaiProviderOptions): ModelProviderAdapter {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 3;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
  const backoffBaseMs = options.backoffBaseMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  const backoff = (retry: number) => backoffBaseMs * 2 ** retry * (0.5 + 0.5 * random());

  // Sends the request, retrying 429s, 5xx errors and dropped connections, then hands the
  // successful response to `read` while the attempt's deadline still runs.
  async function post(
    request: ProviderRequest,
    stream: boolean,
    read: (response: Response, attempt: Deadline) => Promise<ProviderReply>,
  ): Promise<ProviderReply> {
    let key: string | null;
    try {
      key = await options.apiKey();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ModelError('no-key', `Commander couldn't read the Z.ai API key: ${reason}`);
    }
    if (!key) throw new ModelError('no-key', 'No Z.ai API key is saved. Add one in Settings → Ares.');
    const body = JSON.stringify({
      model: request.setting.model,
      messages: request.messages,
      reasoning_effort: request.reasoningEffort,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    });

    for (let retry = 0; ; retry++) {
      const attempt = deadline(timeoutMs, request.signal);
      try {
        let response: Response;
        try {
          response = await fetchFn(endpoint(request.setting.baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body,
            signal: attempt.signal,
          });
        } catch {
          const aborted = attempt.abortError();
          if (aborted) throw aborted;
          if (retry < maxRetries) {
            await sleep(backoff(retry));
            continue;
          }
          throw new ModelError('unavailable', 'Commander could not reach the model provider.');
        }

        if (response.ok) {
          try {
            return await read(response, attempt);
          } catch (error) {
            throw attempt.abortError() ?? error;
          }
        }

        const wait = retryAfterMs(response.headers.get('retry-after'));
        const error = await errorFor(response, wait);
        const retryable = error.kind === 'rate-limit' || error.kind === 'unavailable';
        if (!retryable || retry >= maxRetries || (wait ?? 0) > maxRetryAfterMs) throw error;
        await sleep(wait ?? backoff(retry));
      } finally {
        attempt.clear();
      }
    }
  }

  return {
    send(request) {
      return post(request, false, async (response) => {
        let json: unknown = null;
        try {
          json = await response.json();
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw new ModelError('unavailable', 'The connection to the model provider dropped mid-reply.');
          }
        }
        const parsed = completionShape.safeParse(json);
        if (!parsed.success)
          throw new ModelError('invalid-reply', 'The model sent a reply Commander could not read.');
        const [choice] = parsed.data.choices;
        return { text: choice?.message.content ?? '', usage: toUsage(parsed.data.usage) };
      });
    },

    stream(request, onToken) {
      return post(request, true, async (response, attempt) => {
        if (!response.body) throw new ModelError('invalid-reply', 'The model sent an empty stream.');
        let text = '';
        let usage = toUsage(null);
        for await (const event of events(response.body)) {
          attempt.extend();
          const chunk = chunkShape.safeParse(event);
          if (!chunk.success) continue;
          if (chunk.data.error) {
            const reason = chunk.data.error.message ?? 'no reason given';
            throw new ModelError('unavailable', `The model stopped mid-reply: ${reason}`);
          }
          const token = chunk.data.choices?.[0]?.delta?.content;
          if (token) {
            text += token;
            onToken(token);
          }
          if (chunk.data.usage) usage = toUsage(chunk.data.usage);
        }
        return { text, usage };
      });
    },
  };
}
