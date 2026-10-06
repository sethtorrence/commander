// Ares's voice box in the Core: the model client, wired to the Item store's usage ledger and
// settings, with the API key borrowed from the main process for each call and held in memory only,
// and to the local embedding model (search by meaning, #73) once it is loaded. Also answers
// Settings → Ares (settings, Test, Usage, search by meaning) and the palette's search with meaning.
import {
  type CoreModelsReply,
  coreModelsRequest,
  type ModelProvider,
  modelKeyAccount,
  type modelsRequest,
} from '@commander/domain';
import {
  createModelClient,
  createZaiProvider,
  type ModelClient,
  ModelError,
  type ModelProviderAdapter,
  type ProviderRequest,
} from '@commander/models';
import { z } from 'zod';
import { type AccessTokens, AccessTokenUnavailable } from '../access-tokens';
import type { ItemStore } from '../item-store';
import type { Meaning } from '../meaning';
import type { KnownSecrets } from '../safety/known-secrets';

type MeaningSide = Pick<Meaning, 'status' | 'setOn' | 'queryVector' | 'adapter'>;

// What Test asks for: short, so it costs a fraction of a cent.
const TEST_PROMPT = 'Reply with one short, friendly sentence to confirm you can hear me.';

async function answer(
  store: ItemStore,
  client: ModelClient,
  meaning: MeaningSide | undefined,
  request: z.output<typeof modelsRequest>,
): Promise<CoreModelsReply['response']> {
  switch (request.op) {
    case 'meaning-status':
      if (!meaning) return { ok: false, error: 'Search by meaning isn’t set up' };
      return { ok: true, result: meaning.status() };
    case 'set-meaning':
      if (!meaning) return { ok: false, error: 'Search by meaning isn’t set up' };
      return { ok: true, result: meaning.setOn(request.on) };
    case 'search-meaning': {
      // Null while the model isn't ready: the window keeps the word results it already has.
      const vector = await meaning?.queryVector(request.query.text);
      return { ok: true, result: vector ? store.search.query(request.query, vector) : null };
    }
    case 'settings':
      return { ok: true, result: store.models.settings() };
    case 'save-settings': {
      // Search by meaning is switched on its own (set-meaning), and each Gmail Account's answer about
      // the cloud on its own too (set-cloud-mail), which a form loaded before can't undo.
      const { searchByMeaning, cloudMail } = store.models.settings();
      return {
        ok: true,
        result: store.models.saveSettings({ ...request.settings, searchByMeaning, cloudMail }),
      };
    }
    case 'set-cloud-mail': {
      const settings = store.models.settings();
      const cloudMail = { ...settings.cloudMail, [request.account]: request.answer };
      return { ok: true, result: store.models.saveSettings({ ...settings, cloudMail }) };
    }
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

// A provider that borrows the API key before anything is sent, then checks the messages against
// every token and key the Core now knows (the key just borrowed included), so a prompt built before
// a key was first borrowed still can't carry it (#69). The provider reuses the key borrowed for the
// call, so it is borrowed once.
function refusingSecrets(
  borrow: () => Promise<string | null>,
  make: (apiKey: () => Promise<string | null>) => ModelProviderAdapter,
  secrets: Pick<KnownSecrets, 'foundIn'> | undefined,
): ModelProviderAdapter {
  let current: Promise<string | null> | null = null;
  const provider = make(() => current ?? borrow());
  async function guarded<T>(request: ProviderRequest, call: () => Promise<T>): Promise<T> {
    const key = borrow();
    current = key;
    try {
      await key.catch(() => null);
      if (secrets?.foundIn(request.messages.map((message) => message.content).join('\n'))) {
        throw new ModelError(
          'bad-request',
          'The prompt held one of your sign-in tokens or keys, so nothing was sent.',
        );
      }
      return await call();
    } finally {
      if (current === key) current = null;
    }
  }
  return {
    send: (request) => guarded(request, () => provider.send(request)),
    stream: (request, onToken) => guarded(request, () => provider.stream(request, onToken)),
  };
}

export function setUpModels(
  store: ItemStore,
  {
    send,
    accessTokens,
    secrets,
    meaning,
  }: {
    send: (message: CoreModelsReply) => void;
    accessTokens: Pick<AccessTokens, 'request'>;
    // The tokens and keys the Core holds (fed by accessTokens): no message to a model may carry one.
    secrets?: Pick<KnownSecrets, 'foundIn'>;
    // Search by meaning (../meaning), set up after the client it embeds through.
    meaning?: () => MeaningSide | undefined;
  },
) {
  const zai = refusingSecrets(
    apiKeyFrom(accessTokens, 'zai'),
    (apiKey) => createZaiProvider({ apiKey }),
    secrets,
  );
  const client = createModelClient({
    settings: () => store.models.settings(),
    providers: { zai },
    ledger: store.models,
    embedding: () => meaning?.()?.adapter() ?? null,
  });

  async function reply(id: number, raw: unknown) {
    let response: CoreModelsReply['response'];
    const parsed = coreModelsRequest.safeParse(raw);
    if (!parsed.success) {
      response = { ok: false, error: `Malformed models request: ${parsed.error.message}` };
    } else {
      try {
        response = await answer(store, client, meaning?.(), parsed.data.request);
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
