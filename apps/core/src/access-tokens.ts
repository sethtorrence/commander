// The Core's way to borrow an Account's access token from the main process, which owns the
// keyring and refreshes tokens. Tokens are held only for the call that needs them: the Core never
// writes them to the database or logs them. Later Sources reuse this for their tokens and keys.
import {
  type AccessTokenFailure,
  type CoreAccessTokenRequest,
  coreAccessTokenReply,
} from '@commander/domain';
import { z } from 'zod';

export type AccessToken = { token: string; kind: 'oauth' | 'api-key' };

export class AccessTokenUnavailable extends Error {
  override name = 'AccessTokenUnavailable';
  constructor(
    readonly reason: AccessTokenFailure,
    message: string,
  ) {
    super(message);
  }
}

const envelope = z.object({ type: z.literal('access-token-reply'), id: z.number().int().positive() });

type Pending = {
  resolve: (token: AccessToken) => void;
  reject: (error: AccessTokenUnavailable) => void;
  timer: NodeJS.Timeout;
};

export function createAccessTokens(
  send: (message: CoreAccessTokenRequest) => void,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  return {
    // Rejects with AccessTokenUnavailable; 'needs-reconnect' means pause the Account's syncing.
    request(account: string): Promise<AccessToken> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AccessTokenUnavailable('unavailable', 'The main process did not answer in time'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ type: 'access-token-request', id, account });
      });
    },

    // A message from the main process. Returns true when it was an access token reply.
    settle(raw: unknown): boolean {
      const header = envelope.safeParse(raw);
      if (!header.success) return false;
      const waiting = pending.get(header.data.id);
      if (!waiting) return true;
      pending.delete(header.data.id);
      clearTimeout(waiting.timer);
      const parsed = coreAccessTokenReply.safeParse(raw);
      if (!parsed.success) {
        waiting.reject(new AccessTokenUnavailable('unavailable', 'Malformed access token reply'));
        return true;
      }
      const { response } = parsed.data;
      if (response.ok) waiting.resolve({ token: response.token, kind: response.kind });
      else waiting.reject(new AccessTokenUnavailable(response.reason, response.error));
      return true;
    },
  };
}

export type AccessTokens = ReturnType<typeof createAccessTokens>;
