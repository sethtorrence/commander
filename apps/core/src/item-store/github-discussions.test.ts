import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubDiscussion, PullRequestDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// A pull request's discussion, fetched on demand by the GitHub Section (#115), kept beside its detail
// in the Item store. It is not part of the Item: keeping it records nothing in the activity log and
// changes no view.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const T = Date.UTC(2026, 9, 3, 9);

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-discussion-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pullRequest(changes: Partial<PullRequestDetail> = {}): SourceItem {
  return {
    externalId: 'R_api:pull/12',
    kind: 'pull-request',
    title: 'Retry webhooks with back-off',
    detail: {
      kind: 'pull-request',
      repo: { nodeId: 'R_api', owner: 'acme', name: 'api' },
      number: 12,
      url: 'https://github.com/acme/api/pull/12',
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
      checks: null,
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

const discussion: GitHubDiscussion = {
  forUpdatedAt: T,
  fetchedAt: T + 1000,
  entries: [
    {
      id: 'IC_1',
      kind: 'comment',
      author: 'omar',
      body: 'Looks close.',
      at: T,
      url: 'https://github.com/acme/api/pull/12#issuecomment-1',
      state: null,
      path: null,
      line: null,
    },
  ],
  more: false,
  checks: [{ name: 'test', state: 'failure', url: null }],
};

const save = (item: SourceItem) => store.saveFromSource({ source: 'github', account: GITHUB, items: [item] });

describe('keeping a discussion beside a GitHub Item’s detail', () => {
  it('keeps it until asked again, without an activity entry', () => {
    const [id] = save(pullRequest()).created;
    if (!id) throw new Error('not saved');
    expect(store.githubDiscussions.read(id)).toBeNull();
    const before = store.activity({ itemId: id }).length;

    store.githubDiscussions.save(id, discussion);

    expect(store.githubDiscussions.read(id)).toEqual(discussion);
    expect(store.activity({ itemId: id })).toHaveLength(before);
  });

  it('stays through a sync that saves the Item again, for the Section to judge by its updated time', () => {
    const [id] = save(pullRequest()).created;
    if (!id) throw new Error('not saved');
    store.githubDiscussions.save(id, discussion);

    save(pullRequest({ updatedAt: T + 60_000 }));

    expect(store.githubDiscussions.read(id)?.forUpdatedAt).toBe(T);
  });

  it('keeps nothing for an Item that isn’t a pull request or issue', () => {
    const [id] = store.saveFromSource({
      source: 'github',
      account: GITHUB,
      items: [{ externalId: 'R_api:release/1', kind: 'github-release', title: 'v1', detail: null }],
    }).created;
    if (!id) throw new Error('not saved');
    store.githubDiscussions.save(id, discussion);
    expect(store.githubDiscussions.read(id)).toBeNull();
    expect(store.githubDiscussions.read('no-such-item')).toBeNull();
  });
});
