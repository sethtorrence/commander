// Model API keys (Z.ai now) live only in the keyring, through the secrets module. The window can
// save, replace or remove a key and learn whether one is saved, never read it back. The Core
// borrows the key over its private port when it makes a call, with the access token request
// Accounts use (account-messages.ts), naming the provider's reserved id (modelKeyAccount).
import {
  type CoreAccessTokenReply,
  coreAccessTokenRequest,
  type ModelKeyStatus,
  type ModelProvider,
  modelKeyProvider,
  modelProvider,
  type SaveModelKeyResult,
} from '@commander/domain';
import { z } from 'zod';
import type { Secrets } from './secrets';

const keyName = (provider: ModelProvider) => `model-api-key:${provider}`;

// One unbroken run of printable characters: what every provider's keys look like.
const apiKey = z
  .string()
  .trim()
  .min(8, 'That is too short to be an API key.')
  .max(512, 'That is too long to be an API key.')
  .regex(/^[\x21-\x7e]+$/, 'An API key has no spaces or unusual characters.');

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createModelKeys(secrets: Secrets) {
  return {
    async status(provider: ModelProvider): Promise<ModelKeyStatus> {
      const parsed = modelProvider.safeParse(provider);
      if (!parsed.success) return { saved: false };
      try {
        return { saved: (await secrets.read(keyName(parsed.data))) !== null };
      } catch {
        return { saved: false };
      }
    },

    async save(provider: ModelProvider, key: unknown): Promise<SaveModelKeyResult> {
      const parsedProvider = modelProvider.safeParse(provider);
      if (!parsedProvider.success)
        return { ok: false, error: 'Commander does not know that model provider.' };
      const parsedKey = apiKey.safeParse(key);
      if (!parsedKey.success)
        return { ok: false, error: parsedKey.error.issues[0]?.message ?? 'Not an API key.' };
      try {
        await secrets.save(keyName(parsedProvider.data), parsedKey.data);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      }
    },

    async clear(provider: ModelProvider): Promise<void> {
      const parsed = modelProvider.safeParse(provider);
      if (parsed.success) await secrets.delete(keyName(parsed.data));
    },
  };
}

export type ModelKeys = ReturnType<typeof createModelKeys>;

// Answers the Core's access token request when it names a model provider's key, or returns null
// to leave the message to Accounts (or whoever else handles it).
export function answerModelKeyRequest(secrets: Secrets, raw: unknown): Promise<CoreAccessTokenReply> | null {
  const request = coreAccessTokenRequest.safeParse(raw);
  if (!request.success) return null;
  const provider = modelKeyProvider(request.data.account);
  if (!provider) return null;
  const { id } = request.data;
  const reply = (response: CoreAccessTokenReply['response']): CoreAccessTokenReply => ({
    type: 'access-token-reply',
    id,
    response,
  });
  return secrets.read(keyName(provider)).then(
    (key) =>
      reply(
        key === null
          ? {
              ok: false,
              reason: 'unknown-account',
              error: 'No Z.ai API key is saved. Add one in Settings → Ares.',
            }
          : { ok: true, token: key, kind: 'api-key' },
      ),
    (error) => reply({ ok: false, reason: 'unavailable', error: message(error) }),
  );
}
