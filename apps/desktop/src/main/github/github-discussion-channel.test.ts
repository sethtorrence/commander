import type { CoreGitHubDiscussionRequest, GitHubDiscussion } from '@commander/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubDiscussionChannel } from './github-discussion-channel';

// The GitHub Section's discussions in the main process: requests from the window are checked, given
// where GitHub's API lives, and relayed to the Core; only replies that fit the contract reach the window.

const API = 'http://127.0.0.1:4321/api';

const discussion: GitHubDiscussion = {
  forUpdatedAt: 1,
  fetchedAt: 2,
  entries: [],
  more: false,
  checks: null,
};

function channel() {
  const sent: CoreGitHubDiscussionRequest[] = [];
  const discussions = createGitHubDiscussionChannel({ apiUrl: API, send: (message) => sent.push(message) });
  return { discussions, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the GitHub discussion channel', () => {
  it('relays a request with where GitHub lives, and resolves with the Core’s answer', async () => {
    const { discussions, sent } = channel();
    const reply = discussions.request({ itemId: 'item-1' });

    expect(sent).toEqual([
      { type: 'github-discussion-request', id: 1, apiUrl: API, request: { itemId: 'item-1' } },
    ]);
    expect(
      discussions.settle({ type: 'github-discussion-reply', id: 1, response: { ok: true, discussion } }),
    ).toBe(true);
    await expect(reply).resolves.toEqual({ ok: true, discussion });
  });

  it('refuses a request outside the contract without bothering the Core', async () => {
    const { discussions, sent } = channel();
    await expect(discussions.request({ itemId: '' })).resolves.toMatchObject({ ok: false });
    await expect(discussions.request('item-1')).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it('passes on only replies that fit the contract, and leaves other messages alone', async () => {
    const { discussions } = channel();
    const reply = discussions.request({ itemId: 'item-1' });
    expect(discussions.settle({ type: 'github-watch-reply', id: 1 })).toBe(false);
    expect(
      discussions.settle({
        type: 'github-discussion-reply',
        id: 1,
        response: { ok: true, discussion: '<b>html</b>' },
      }),
    ).toBe(true);
    await expect(reply).resolves.toMatchObject({ ok: false });
  });

  it('gives up when the Core doesn’t answer', async () => {
    vi.useFakeTimers();
    const { discussions } = channel();
    const reply = discussions.request({ itemId: 'item-1' });
    vi.advanceTimersByTime(60_000);
    await expect(reply).resolves.toEqual({ ok: false, error: 'The Core did not answer in time' });
  });
});
