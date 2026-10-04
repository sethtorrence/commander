import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubDiscussionResponse, PullRequestDetail, SourceItem } from '@commander/domain';
import { type ReadDiscussion, SignInRefused, SourceUnavailable } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTokenUnavailable } from '../access-tokens';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpGitHubDiscussion } from '.';

// A pull request's discussion, fetched by the Core when the GitHub Section opens it (#115): once per
// version of the Item (kept beside its detail until GitHub's updated time moves), with the Account's
// token borrowed for the request. GitHub itself is stood in for here; packages/sources tests the query.

const ACCOUNT = 'github:583231';
const API = 'https://api.github.test';
const T = Date.UTC(2026, 9, 3, 9);

let dir: string;
let store: ItemStore;
let sent: unknown[];
let read: ReturnType<typeof vi.fn>;
let token: ReturnType<typeof vi.fn>;

const found: ReadDiscussion = {
  entries: [
    {
      id: 'IC_1',
      kind: 'comment',
      author: 'omar',
      body: 'Looks close.',
      at: T,
      url: 'https://github.test/acme/api/pull/12#issuecomment-1',
      state: null,
      path: null,
      line: null,
    },
  ],
  more: false,
  checks: [{ name: 'test', state: 'success', url: null }],
};

function pullRequest(changes: Partial<PullRequestDetail> = {}): SourceItem {
  return {
    externalId: 'R_api:pull/12',
    kind: 'pull-request',
    title: 'Retry webhooks with back-off',
    detail: {
      kind: 'pull-request',
      repo: { nodeId: 'R_api', owner: 'acme', name: 'api' },
      number: 12,
      url: 'https://github.test/acme/api/pull/12',
      nodeId: 'PR_12',
      author: 'priya',
      state: 'open',
      draft: false,
      baseBranch: 'main',
      headBranch: 'retry-webhooks',
      labels: [],
      assignees: [],
      requestedReviewers: [],
      reviews: [],
      reviewDecision: null,
      checks: 'success',
      closingIssues: [],
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      body: '',
      createdAt: T,
      updatedAt: T,
      mergedAt: null,
      closedAt: null,
      ...changes,
    },
  };
}

const save = (item: SourceItem) =>
  store.saveFromSource({ source: 'github', account: ACCOUNT, items: [item] });

const discussions = () =>
  setUpGitHubDiscussion(store, {
    send: (message) => sent.push(message),
    accessTokens: { request: token as never },
    read: read as never,
    now: () => T + 5_000,
    log: () => {},
  });

// Asks as the main process would, and waits for the answer.
async function ask(handler: ReturnType<typeof discussions>, itemId: string, id = 1) {
  expect(handler.handle({ type: 'github-discussion-request', id, apiUrl: API, request: { itemId } })).toBe(
    true,
  );
  await vi.waitFor(() => expect(sent.some((message) => (message as { id?: number }).id === id)).toBe(true));
  const reply = sent.find((message) => (message as { id?: number }).id === id) as {
    type: string;
    response: GitHubDiscussionResponse;
  };
  expect(reply.type).toBe('github-discussion-reply');
  return reply.response;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-discussion-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => T,
  });
  sent = [];
  read = vi.fn(async () => found);
  token = vi.fn(async () => ({ token: 'ghu_borrowed', kind: 'oauth' }));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fetching a discussion on demand', () => {
  it('asks GitHub with the Account’s token and keeps the answer for this version of the Item', async () => {
    const [id] = save(pullRequest()).created;
    if (!id) throw new Error('not saved');
    const response = await ask(discussions(), id);

    expect(token).toHaveBeenCalledWith(ACCOUNT);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, token: { token: 'ghu_borrowed', kind: 'oauth' } }),
      { kind: 'pull-request', nodeId: 'PR_12' },
    );
    expect(response).toEqual({ ok: true, discussion: { ...found, forUpdatedAt: T, fetchedAt: T + 5_000 } });
    expect(store.githubDiscussions.read(id)?.entries).toEqual(found.entries);
  });

  it('answers from what it kept while the Item is unchanged, and fetches again once it changes', async () => {
    const [id] = save(pullRequest()).created;
    if (!id) throw new Error('not saved');
    const handler = discussions();
    await ask(handler, id, 1);
    await ask(handler, id, 2);
    expect(read).toHaveBeenCalledTimes(1);

    save(pullRequest({ updatedAt: T + 60_000 }));
    const response = await ask(handler, id, 3);
    expect(read).toHaveBeenCalledTimes(2);
    expect(response.ok && response.discussion.forUpdatedAt).toBe(T + 60_000);
  });

  it('asks GitHub once when the same discussion is asked for twice at once', async () => {
    const [id] = save(pullRequest()).created;
    if (!id) throw new Error('not saved');
    const handler = discussions();
    await Promise.all([ask(handler, id, 1), ask(handler, id, 2)]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('says what went wrong, in words the User can read', async () => {
    const [id] = save(pullRequest()).created;
    if (!id) throw new Error('not saved');

    read.mockRejectedValueOnce(new SourceUnavailable('Commander couldn’t reach GitHub.'));
    expect(await ask(discussions(), id, 1)).toEqual({ ok: false, error: 'Commander couldn’t reach GitHub.' });

    // A refused sign-in also goes to the main process, which may mark the Account Reconnect.
    read.mockRejectedValueOnce(new SignInRefused('GitHub refused the sign-in: Bad credentials'));
    const refused = await ask(discussions(), id, 2);
    expect(refused).toEqual({
      ok: false,
      error: 'GitHub refused this Account’s sign-in. Reconnect it in Settings → Accounts.',
    });
    expect(sent).toContainEqual({ type: 'account-refused', account: ACCOUNT });

    token.mockRejectedValueOnce(new AccessTokenUnavailable('needs-reconnect', 'gone'));
    expect(await ask(discussions(), id, 3)).toEqual({
      ok: false,
      error: 'GitHub refused this Account’s sign-in. Reconnect it in Settings → Accounts.',
    });
    expect(store.githubDiscussions.read(id)).toBeNull();
  });

  it('refuses Items that aren’t pull requests or issues, and malformed requests', async () => {
    expect(await ask(discussions(), 'no-such-item')).toEqual({
      ok: false,
      error: 'Commander has no such pull request or issue.',
    });
    const handler = discussions();
    expect(handler.handle({ type: 'github-discussion-request', id: 9, apiUrl: 'nope', request: {} })).toBe(
      true,
    );
    expect(sent.at(-1)).toMatchObject({ type: 'github-discussion-reply', id: 9, response: { ok: false } });
    expect(handler.handle({ type: 'something-else' })).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
