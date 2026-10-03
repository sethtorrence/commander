// The main process's side of the Account messages with the Core: it answers the Core's requests
// for access tokens (validated both ways, see account-messages.ts) and asks the Core to remove a
// removed Account's Items.
import {
  type CoreAccessTokenReply,
  type CoreRemoveAccountItems,
  coreAccessTokenRequest,
  coreRemoveAccountItemsReply,
  type Source,
} from '@commander/domain';
import { z } from 'zod';
import { type AccessToken, AccessTokenError } from '../linear/linear-accounts';

type Pending = { resolve: (removed: number) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const isAccessTokenRequest = z.object({ type: z.literal('access-token-request') });

export function createCoreAccountChannel({
  send,
  accessToken,
  timeoutMs = 30_000,
}: {
  send: (message: CoreAccessTokenReply | CoreRemoveAccountItems) => void;
  accessToken: (account: string) => Promise<AccessToken>;
  timeoutMs?: number;
}) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  async function answer(id: number, account: string) {
    let response: CoreAccessTokenReply['response'];
    try {
      response = { ok: true, ...(await accessToken(account)) };
    } catch (error) {
      response =
        error instanceof AccessTokenError
          ? { ok: false, reason: error.reason, error: error.message }
          : { ok: false, reason: 'unavailable', error: 'Commander could not get a token for this Account' };
    }
    send({ type: 'access-token-reply', id, response });
  }

  return {
    // A message from the Core. Returns true when it was one of the Account messages, handled here.
    handle(raw: unknown): boolean {
      if (isAccessTokenRequest.safeParse(raw).success) {
        const request = coreAccessTokenRequest.safeParse(raw);
        if (request.success) void answer(request.data.id, request.data.account);
        else console.warn('Rejected malformed access token request from the Core:', request.error.message);
        return true;
      }
      const reply = coreRemoveAccountItemsReply.safeParse(raw);
      if (!reply.success) return false;
      const waiting = pending.get(reply.data.id);
      if (!waiting) return true;
      pending.delete(reply.data.id);
      clearTimeout(waiting.timer);
      const { response } = reply.data;
      if (response.ok) waiting.resolve(response.removed);
      else waiting.reject(new Error(response.error));
      return true;
    },

    removeItems({
      source,
      account,
      name,
    }: {
      source: Source;
      account: string;
      name: string;
    }): Promise<number> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The Core did not answer in time, so the Account was not removed. Try again.'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ type: 'remove-account-items', id, source, account, name });
      });
    },
  };
}

export type CoreAccountChannel = ReturnType<typeof createCoreAccountChannel>;
