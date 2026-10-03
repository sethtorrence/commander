import type { CoreAccessTokenReply, CoreAccessTokenRequest } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { AccessTokenUnavailable, createAccessTokens } from './access-tokens';

// The main process, as the Core sees it: answers each request it is sent.
function connect(answer: (request: CoreAccessTokenRequest) => unknown, options?: { timeoutMs?: number }) {
  const sent: CoreAccessTokenRequest[] = [];
  const tokens = createAccessTokens((message) => {
    sent.push(message);
    const reply = answer(message);
    if (reply !== undefined) queueMicrotask(() => tokens.settle(reply));
  }, options);
  return { tokens, sent };
}

const ok = (request: CoreAccessTokenRequest, token = 'tok'): CoreAccessTokenReply => ({
  type: 'access-token-reply',
  id: request.id,
  response: { ok: true, token, kind: 'oauth' },
});

describe('asking the main process for an access token', () => {
  it('sends a validated request naming the Account and resolves with the token', async () => {
    const { tokens, sent } = connect((request) => ok(request, 'lin_oauth_abc'));

    await expect(tokens.request('linear:org-acme')).resolves.toEqual({
      token: 'lin_oauth_abc',
      kind: 'oauth',
    });
    expect(sent).toEqual([{ type: 'access-token-request', id: 1, account: 'linear:org-acme' }]);
  });

  it('matches replies to their requests', async () => {
    const { tokens } = connect((request) => ok(request, `token-for-${request.account}`));

    const [a, b] = await Promise.all([tokens.request('linear:a'), tokens.request('linear:b')]);

    expect(a.token).toBe('token-for-linear:a');
    expect(b.token).toBe('token-for-linear:b');
  });

  it('rejects with the reason when the Account needs reconnecting, so its syncing can pause', async () => {
    const { tokens } = connect((request) => ({
      type: 'access-token-reply',
      id: request.id,
      response: { ok: false, reason: 'needs-reconnect', error: 'The Acme Linear Account needs reconnecting' },
    }));

    const asking = tokens.request('linear:org-acme');

    await expect(asking).rejects.toBeInstanceOf(AccessTokenUnavailable);
    await expect(asking).rejects.toMatchObject({ reason: 'needs-reconnect' });
  });

  it('treats a malformed reply as a passing problem', async () => {
    const { tokens } = connect((request) => ({
      type: 'access-token-reply',
      id: request.id,
      response: { ok: true },
    }));

    await expect(tokens.request('linear:org-acme')).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('gives up when the main process does not answer', async () => {
    const { tokens } = connect(() => undefined, { timeoutMs: 20 });

    await expect(tokens.request('linear:org-acme')).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('leaves other messages to other handlers', () => {
    const { tokens } = connect(() => undefined);

    expect(tokens.settle({ type: 'item-store-request', id: 1, request: { op: 'query' } })).toBe(false);
  });
});
