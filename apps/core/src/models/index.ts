// Ares's voice box in the Core: the model client, wired to the Item store's usage ledger and
// settings, with the API key borrowed from the main process for each call and held in memory only.
// Also answers Settings → Ares (settings, Test, Usage) for the window.
import {
  type CoreModelsReply,
  coreModelsRequest,
  type ModelProvider,
  modelKeyAccount,
  type modelsRequest,
} from '@commander/domain';
import { createModelClient, createZaiProvider, type ModelClient, ModelError } from '@commander/models';
import { z } from 'zod';
import { type AccessTokens, AccessTokenUnavailable } from '../access-tokens';
import type { ItemStore } from '../item-store';

// What Test asks for: short, so it costs a fraction of a cent.
const TEST_PROMPT = 'Reply with one short, friendly sentence to confirm you can hear me.';

async function answer(
  store: ItemStore,
  client: ModelClient,
  request: z.output<typeof modelsRequest>,
): Promise<CoreModelsReply['response']> {
  switch (request.op) {
    case 'settings':
      return { ok: true, result: store.models.settings() };
    case 'save-settings':
      return { ok: true, result: store.models.saveSettings(request.settings) };
    case 'usage':
      return { ok: true, result: store.models.usageSummary() };
    case 'test': {
      const result = await client.complete({
        tier: 'quick',
        job: 'settings-test',
        messages: [{ role: 'user', content: TEST_PROMPT }],
      });
      return {
        ok: true,
        result: {
          reply: result.text.trim(),
          provider: result.provider,
          model: result.model,
          latencyMs: result.usage.latencyMs,
          costUsd: result.usage.costUsd,
        },
      };
    }
  }
}

const envelope = z.object({ type: z.literal('models-request'), id: z.number().int().positive() });

// Borrows a provider's API key from the main process with the Accounts' access token request.
// Resolves null when no key is saved.
function apiKeyFrom(accessTokens: Pick<AccessTokens, 'request'>, provider: ModelProvider) {
  return () =>
    accessTokens.request(modelKeyAccount(provider)).then(
      ({ token }) => token,
      (error: unknown) => {
        if (error instanceof AccessTokenUnavailable && error.reason === 'unknown-account') return null;
        throw error;
      },
    );
}

export function setUpModels(
  store: ItemStore,
  {
    send,
    accessTokens,
  }: { send: (message: CoreModelsReply) => void; accessTokens: Pick<AccessTokens, 'request'> },
) {
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai: createZaiProvider({ apiKey: apiKeyFrom(accessTokens, 'zai') }) },
    ledger: store.models,
  });

  async function reply(id: number, raw: unknown) {
    let response: CoreModelsReply['response'];
    const parsed = coreModelsRequest.safeParse(raw);
    if (!parsed.success) {
      response = { ok: false, error: `Malformed models request: ${parsed.error.message}` };
    } else {
      try {
        response = await answer(store, client, parsed.data.request);
      } catch (error) {
        response =
          error instanceof ModelError
            ? { ok: false, error: error.message, kind: error.kind }
            : { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    send({ type: 'models-reply', id, response } satisfies CoreModelsReply);
  }

  return {
    // For the Agent's jobs (the job runner, ../agent).
    client,
    // A message from the main process. Returns true when it was for the models side.
    handle(raw: unknown): boolean {
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) return false;
      void reply(parsed.data.id, raw);
      return true;
    },
  };
}
