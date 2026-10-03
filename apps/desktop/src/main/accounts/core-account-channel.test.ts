import { describe, expect, it, vi } from 'vitest';
import { AccessTokenError } from '../linear/linear-accounts';
import { createCoreAccountChannel } from './core-account-channel';

function channel(accessToken: (account: string) => Promise<{ token: string; kind: 'oauth' | 'api-key' }>) {
  const sent: unknown[] = [];
  const core = createCoreAccountChannel({
    send: (message) => sent.push(message),
    accessToken,
    timeoutMs: 50,
  });
  return { core, sent };
}

describe('access tokens the Core asks for', () => {
  it('answers with the Account’s current token', async () => {
    const accessToken = vi.fn(async () => ({ token: 'lin_oauth_abc', kind: 'oauth' as const }));
    const { core, sent } = channel(accessToken);

    expect(core.handle({ type: 'access-token-request', id: 3, account: 'linear:org-acme' })).toBe(true);

    await vi.waitFor(() =>
      expect(sent).toEqual([
        { type: 'access-token-reply', id: 3, response: { ok: true, token: 'lin_oauth_abc', kind: 'oauth' } },
      ]),
    );
    expect(accessToken).toHaveBeenCalledWith('linear:org-acme');
  });

  it('answers with the reason when there is no token', async () => {
    const { core, sent } = channel(async () => {
      throw new AccessTokenError('needs-reconnect', 'The Acme Linear Account needs reconnecting');
    });

    core.handle({ type: 'access-token-request', id: 4, account: 'linear:org-acme' });

    await vi.waitFor(() =>
      expect(sent).toEqual([
        {
          type: 'access-token-reply',
          id: 4,
          response: {
            ok: false,
            reason: 'needs-reconnect',
            error: 'The Acme Linear Account needs reconnecting',
          },
        },
      ]),
    );
  });

  it('answers an unexpected failure as a passing problem', async () => {
    const { core, sent } = channel(async () => {
      throw new Error('boom');
    });

    core.handle({ type: 'access-token-request', id: 5, account: 'linear:org-acme' });

    await vi.waitFor(() =>
      expect(sent).toMatchObject([{ id: 5, response: { ok: false, reason: 'unavailable' } }]),
    );
  });

  it('ignores a malformed request and messages meant for others', () => {
    const accessToken = vi.fn();
    const { core, sent } = channel(accessToken);

    expect(core.handle({ type: 'access-token-request', id: -1 })).toBe(true);
    expect(core.handle({ type: 'heartbeat', beats: 1, at: 1 })).toBe(false);
    expect(accessToken).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe('removing an Account’s Items', () => {
  it('asks the Core and resolves with how many it removed', async () => {
    const { core, sent } = channel(vi.fn());

    const removing = core.removeItems({ source: 'linear', account: 'linear:org-acme', name: 'Acme' });
    expect(sent).toEqual([
      { type: 'remove-account-items', id: 1, source: 'linear', account: 'linear:org-acme', name: 'Acme' },
    ]);
    core.handle({ type: 'remove-account-items-reply', id: 1, response: { ok: true, removed: 2 } });

    await expect(removing).resolves.toBe(2);
  });

  it('rejects with the Core’s reason', async () => {
    const { core } = channel(vi.fn());

    const removing = core.removeItems({ source: 'linear', account: 'linear:org-acme', name: 'Acme' });
    core.handle({ type: 'remove-account-items-reply', id: 1, response: { ok: false, error: 'disk full' } });

    await expect(removing).rejects.toThrow('disk full');
  });

  it('rejects when the Core does not answer in time', async () => {
    const { core } = channel(vi.fn());

    await expect(core.removeItems({ source: 'linear', account: 'linear:x', name: 'X' })).rejects.toThrow(
      /did not answer/,
    );
  });
});
