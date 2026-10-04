import type { CoreGitHubWatchRequest, GitHubWatchView } from '@commander/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubWatchChannel } from './github-watch-channel';

// Settings → GitHub in the main process: requests from the window are checked, given where GitHub's
// API lives, and relayed to the Core; only replies that fit the contract reach the window.

const API = 'http://127.0.0.1:4321/api';

const view: GitHubWatchView = {
  account: 'github:583231',
  access: null,
  watch: { orgs: [], repos: [] },
  fromDefault: false,
  problem: null,
};

function channel() {
  const sent: CoreGitHubWatchRequest[] = [];
  const watch = createGitHubWatchChannel({ apiUrl: API, send: (message) => sent.push(message) });
  return { watch, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the Settings → GitHub channel', () => {
  it('relays a request with where GitHub lives, and resolves with the Core’s answer', async () => {
    const { watch, sent } = channel();
    const reply = watch.request({ op: 'load', account: 'github:583231' });

    expect(sent).toEqual([
      { type: 'github-watch-request', id: 1, apiUrl: API, request: { op: 'load', account: 'github:583231' } },
    ]);
    expect(watch.settle({ type: 'github-watch-reply', id: 1, response: { ok: true, view } })).toBe(true);
    await expect(reply).resolves.toEqual({ ok: true, view });
  });

  it('refuses a request outside the contract without bothering the Core', async () => {
    const { watch, sent } = channel();
    await expect(
      watch.request({ op: 'add-org', account: 'github:1', login: 'not an org!' }),
    ).resolves.toMatchObject({
      ok: false,
      view: null,
    });
    await expect(watch.request({ op: 'token', account: 'github:1' })).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it('rejects a reply that doesn’t fit', async () => {
    const { watch } = channel();
    const reply = watch.request({ op: 'load', account: 'github:583231' });
    expect(
      watch.settle({ type: 'github-watch-reply', id: 1, response: { ok: true, view: { account: 7 } } }),
    ).toBe(true);
    await expect(reply).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('malformed'),
      view: null,
    });
    expect(watch.settle({ type: 'models-reply', id: 1 })).toBe(false);
  });

  it('gives GitHub time to list a large Account, but not forever', async () => {
    vi.useFakeTimers();
    const { watch } = channel();
    const reply = watch.request({ op: 'load', account: 'github:583231' });
    await vi.advanceTimersByTimeAsync(60_000);
    watch.settle({ type: 'github-watch-reply', id: 99, response: { ok: true, view } });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await expect(reply).resolves.toEqual({ ok: false, error: 'The Core did not answer in time', view: null });
  });
});
