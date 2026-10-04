import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionContext,
  GitHubIssueDetail,
  GitHubReleaseDetail,
  Project,
  PullRequestDetail,
  ReviewRequestDetail,
  SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// GitHub's Items in the Item store (#114): pull requests, issues, review requests and releases, each
// saved with its detail from GitHub sync like any Source Item (ADR 0001), and found by
// `owner/repo#123` or the words of their bodies.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 9);
const repo = { nodeId: 'R_api', owner: 'acme', name: 'api' };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-github-'));
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
  const detail: PullRequestDetail = {
    kind: 'pull-request',
    repo,
    number: 12,
    url: 'https://github.com/acme/api/pull/12',
    nodeId: 'PR_12',
    author: 'priya',
    state: 'open',
    draft: false,
    baseBranch: 'main',
    headBranch: 'retry-webhooks',
    labels: [{ name: 'enhancement', color: 'a2eeef' }],
    assignees: ['priya'],
    requestedReviewers: [{ kind: 'user', login: 'octocat', requestedAt: T }],
    reviews: [],
    reviewDecision: 'review-required',
    checks: 'pending',
    closingIssues: [],
    additions: 120,
    deletions: 14,
    changedFiles: 6,
    body: 'Retries failed webhooks with exponential back-off.',
    createdAt: T,
    updatedAt: T,
    mergedAt: null,
    closedAt: null,
    ...changes,
  };
  return {
    externalId: 'R_api:pull/12',
    kind: 'pull-request',
    title: 'Retry webhooks with back-off',
    people: ['github:priya', 'priya@acme.test', 'github:octocat'],
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

const issue: SourceItem = {
  externalId: 'R_api:issue/30',
  kind: 'github-issue',
  title: 'Webhooks drop on 502',
  people: ['github:priya'],
  detail: {
    kind: 'github-issue',
    repo,
    number: 30,
    url: 'https://github.com/acme/api/issues/30',
    nodeId: 'I_30',
    author: 'priya',
    assignees: [],
    labels: [],
    milestone: { title: 'October', dueOn: null },
    state: 'open',
    stateReason: null,
    body: 'When the receiver answers 502 we drop the event.',
    commentCount: 2,
    createdAt: T,
    updatedAt: T,
    closedAt: null,
    parent: null,
    subIssues: { total: 3, completed: 1 },
  } satisfies GitHubIssueDetail,
};

const reviewRequest: SourceItem = {
  externalId: 'R_api:review-request/12',
  kind: 'review-request',
  title: 'Retry webhooks with back-off',
  people: ['github:priya'],
  detail: {
    kind: 'review-request',
    pullRequest: 'R_api:pull/12',
    pullRequestId: null,
    repo,
    number: 12,
    url: 'https://github.com/acme/api/pull/12',
    direct: true,
    teams: [],
    requestedAt: T,
  } satisfies ReviewRequestDetail,
};

const release: SourceItem = {
  externalId: 'R_api:release/RE_140',
  kind: 'github-release',
  title: 'api v1.4.0',
  people: ['github:priya'],
  status: 'done',
  detail: {
    kind: 'github-release',
    repo,
    tag: 'v1.4.0',
    name: null,
    url: 'https://github.com/acme/api/releases/tag/v1.4.0',
    author: 'priya',
    prerelease: false,
    publishedAt: T,
    notes: 'Faster lookups',
  } satisfies GitHubReleaseDetail,
};

const save = (items: SourceItem[], deleted: string[] = []) =>
  store.saveFromSource({ source: 'github', account: GITHUB, items, deleted });

describe('GitHub Items in the Item store', () => {
  it('keeps each kind with its detail, and saving them again unchanged adds no activity', () => {
    const first = save([pullRequest(), issue, reviewRequest, release]);
    const activity = store.activity();
    const again = save([pullRequest(), issue, reviewRequest, release]);

    expect(first.created).toHaveLength(4);
    expect(again).toMatchObject({ created: [], updated: [], unchanged: first.created });
    expect(store.activity()).toEqual(activity);
    const saved = (kind: SourceItem['kind']) => store.query({ kinds: [kind] })[0];
    expect(saved('pull-request')).toMatchObject({
      source: 'github',
      account: GITHUB,
      title: 'Retry webhooks with back-off',
      people: ['github:priya', 'priya@acme.test', 'github:octocat'],
      detail: pullRequest().detail,
    });
    expect(saved('github-issue')?.detail).toEqual(issue.detail);
    expect(saved('github-release')).toMatchObject({ status: 'done', detail: release.detail });
  });

  it('names the pull request a review request is about by its Item id', () => {
    const { created } = save([pullRequest(), reviewRequest]);
    const [pull] = created;
    const request = store.query({ kinds: ['review-request'] })[0];
    expect(request?.detail).toEqual({ ...reviewRequest.detail, pullRequestId: pull });
    // Saved again as GitHub sync hands it over (without the id): unchanged.
    expect(save([reviewRequest]).unchanged).toEqual([request?.id]);
  });

  it('keeps filing and Links made in Commander through later syncs', () => {
    const [id] = save([pullRequest()]).created;
    if (!id) throw new Error('no pull request');
    const project = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project as Project;
    store.record(
      { type: 'update', itemId: id, changes: { filing: { projectId: project.id, filedBy: 'user' } } },
      user,
    );
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Review the retries' } }, user);
    store.link({ from: todo.itemId, linkType: 'about', to: id }, user);

    save([pullRequest({ state: 'merged', mergedAt: T, closedAt: T })]);

    expect(store.get(id)).toMatchObject({
      item: { status: 'done', filing: { projectId: project.id, filedBy: 'user' } },
      backlinks: [{ type: 'about', from: { id: todo.itemId } }],
    });
  });

  it('turns a met review request into a tombstone', () => {
    const [, requestId] = save([pullRequest(), reviewRequest]).created;
    save([], ['R_api:review-request/12']);
    expect(store.query({ kinds: ['review-request'] })).toEqual([]);
    expect(store.get(requestId ?? '')?.item.deletedAt).toBe(T);
  });

  it('finds a pull request by owner/repo#123, by repo#123 and by words in its body', () => {
    save([pullRequest(), issue]);
    const titles = (text: string) => store.search.query({ text }).hits.map((hit) => hit.item.title);

    expect(titles('acme/api#12')).toEqual(['Retry webhooks with back-off']);
    expect(titles('api#12')[0]).toBe('Retry webhooks with back-off');
    expect(titles('exponential back-off')).toEqual(['Retry webhooks with back-off']);
    expect(titles('receiver answers')).toEqual(['Webhooks drop on 502']);
  });
});
