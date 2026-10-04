import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitHubIssueDetail, PullRequestDetail, SourceItem } from '@commander/domain';
import type { ReadWriterDetail } from '@commander/sources';
import { SignInRefused } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpGitHubOversight } from '.';

// The oversight summary in the Core (#119): finishes Links made after each GitHub sync, from a pull
// request's title, branch and body or from its closing issue, shown from both ends and never made
// again once removed; and the writer's detail fetched for the pull requests in a summary, kept until
// they change.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GITHUB = 'github:583231';
const LINEAR = 'linear:org-acme';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 4, 15);
const API = { nodeId: 'R_api', owner: 'acme', name: 'api' };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-oversight-core-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => NOW,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pullRequest(
  number: number,
  changes: Partial<PullRequestDetail> & { title?: string } = {},
): SourceItem {
  const { title = `Change ${number}`, ...detail } = changes;
  return {
    externalId: `R_api:pull/${number}`,
    kind: 'pull-request',
    title,
    status: detail.state && detail.state !== 'open' ? 'done' : 'open',
    detail: {
      kind: 'pull-request',
      repo: API,
      number,
      url: `https://github.com/acme/api/pull/${number}`,
      nodeId: `PR_${number}`,
      author: 'priya',
      state: 'open',
      draft: false,
      baseBranch: 'main',
      headBranch: `branch-${number}`,
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
      createdAt: NOW - 2 * HOUR,
      updatedAt: NOW - HOUR,
      mergedAt: null,
      closedAt: null,
      ...detail,
    },
  };
}

function githubIssue(
  number: number,
  changes: Partial<GitHubIssueDetail> & { title?: string } = {},
): SourceItem {
  const { title = `Issue ${number}`, ...detail } = changes;
  return {
    externalId: `R_api:issues/${number}`,
    kind: 'github-issue',
    title,
    detail: {
      kind: 'github-issue',
      repo: API,
      number,
      url: `https://github.com/acme/api/issues/${number}`,
      nodeId: `I_${number}`,
      author: 'omar',
      assignees: [],
      labels: [],
      milestone: null,
      state: 'open',
      stateReason: null,
      body: '',
      commentCount: 0,
      createdAt: NOW - 3 * DAY,
      updatedAt: NOW - DAY,
      closedAt: null,
      parent: null,
      subIssues: null,
      ...detail,
    },
  };
}

function linearIssue(identifier: string): SourceItem {
  return {
    externalId: `lin-${identifier}`,
    kind: 'linear-issue',
    title: `Linear ${identifier}`,
    detail: {
      kind: 'linear-issue',
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
      team: { id: 'team-eng', key: identifier.split('-')[0] ?? 'ENG', name: 'Engineering' },
      state: { id: 'st-1', name: 'In Progress', type: 'started', color: '#f2c94c' },
      priority: 2,
      assignee: null,
      creator: null,
      labels: [],
      cycle: null,
      linearProject: null,
      dueDate: null,
      estimate: null,
      description: null,
      comments: [],
      createdAt: NOW - 5 * DAY,
      updatedAt: NOW - DAY,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    },
  };
}

const idOf = (externalId: string) =>
  store.query({ includeDeleted: true }).find((item) => item.externalId === externalId)?.id ?? '';

function saveGitHub(...items: SourceItem[]): string[] {
  const saved = store.saveFromSource({ source: 'github', account: GITHUB, items });
  return [...saved.created, ...saved.updated];
}

function oversight(options: Partial<Parameters<typeof setUpGitHubOversight>[1]> = {}) {
  return setUpGitHubOversight(store, {
    accessTokens: { request: async () => ({ token: 'ghu_test', kind: 'oauth' as const }) },
    apiUrl: () => 'https://api.github.test',
    timeZone: 'UTC',
    now: () => NOW,
    read: async () => new Map(),
    log: () => {},
    ...options,
  });
}

const finishesFrom = (itemId: string) =>
  store
    .get(itemId)
    ?.links.filter((link) => link.type === 'finishes')
    .map((link) => link.to.id) ?? [];

describe('finishes Links', () => {
  beforeEach(() => {
    store.saveFromSource({
      source: 'linear',
      account: LINEAR,
      items: [linearIssue('ENG-412'), linearIssue('ENG-7'), linearIssue('OPS-3')],
    });
  });

  it('links a pull request to the Linear issues its title, branch or body names', () => {
    const changed = saveGitHub(
      pullRequest(1, { title: 'ENG-412: retry webhooks' }),
      pullRequest(2, { headBranch: 'priya/eng-7-cache-sessions' }),
      pullRequest(3, { body: 'Retries deliveries.\n\nFixes OPS-3' }),
      pullRequest(4, { body: 'Nothing to do with Linear' }),
    );
    const made = oversight().linkFinishes(changed);

    expect(finishesFrom(idOf('R_api:pull/1'))).toEqual([idOf('lin-ENG-412')]);
    expect(finishesFrom(idOf('R_api:pull/2'))).toEqual([idOf('lin-ENG-7')]);
    expect(finishesFrom(idOf('R_api:pull/3'))).toEqual([idOf('lin-OPS-3')]);
    expect(finishesFrom(idOf('R_api:pull/4'))).toEqual([]);
    expect(made.sort()).toEqual(
      [
        idOf('R_api:pull/1'),
        idOf('lin-ENG-412'),
        idOf('R_api:pull/2'),
        idOf('lin-ENG-7'),
        idOf('R_api:pull/3'),
        idOf('lin-OPS-3'),
      ].sort(),
    );
  });

  it('shows the Link from both ends, made by GitHub', () => {
    const changed = saveGitHub(pullRequest(1, { title: 'ENG-412: retry webhooks' }));
    oversight().linkFinishes(changed);
    const pull = idOf('R_api:pull/1');
    const issue = idOf('lin-ENG-412');
    expect(store.get(issue)?.backlinks.map((link) => [link.type, link.from.id])).toEqual([
      ['finishes', pull],
    ]);
    expect(store.activity({ itemId: pull })[0]).toMatchObject({
      action: 'link',
      by: { kind: 'source', source: 'github', account: GITHUB },
      otherItemId: issue,
      why: 'acme/api#1 names ENG-412',
    });
  });

  it('links through a closing issue that names a Linear issue, or is linked to one', () => {
    saveGitHub(
      githubIssue(30, { body: 'Tracked in https://linear.app/acme/issue/ENG-412/retry' }),
      githubIssue(31),
    );
    // An issue the User linked to a Linear issue by hand.
    store.link(
      { from: idOf('R_api:issues/31'), linkType: 'refers-to', to: idOf('lin-ENG-7') },
      { by: { kind: 'user' } },
    );
    const changed = saveGitHub(
      pullRequest(1, {
        closingIssues: [{ owner: 'acme', name: 'api', number: 30, title: 'Issue 30', url: '' }],
      }),
      // GitHub lists no closing issues for a pull request into another branch: the keyword counts.
      pullRequest(2, { baseBranch: 'release', body: 'Closes #31' }),
    );
    oversight().linkFinishes(changed);
    expect(finishesFrom(idOf('R_api:pull/1'))).toEqual([idOf('lin-ENG-412')]);
    expect(finishesFrom(idOf('R_api:pull/2'))).toEqual([idOf('lin-ENG-7')]);
    expect(store.activity({ itemId: idOf('R_api:pull/1') })[0]?.why).toBe(
      'acme/api#1 closes acme/api#30, which names ENG-412',
    );
  });

  it('makes no Link for an identifier no synced Linear issue has', () => {
    const changed = saveGitHub(
      pullRequest(1, { title: 'ENG-999: not in Commander', body: 'utf-8 everywhere' }),
    );
    expect(oversight().linkFinishes(changed)).toEqual([]);
    expect(finishesFrom(idOf('R_api:pull/1'))).toEqual([]);
  });

  it('never makes a Link twice, nor again once the User removed it', () => {
    const changed = saveGitHub(pullRequest(1, { title: 'ENG-412: retry webhooks' }));
    const service = oversight();
    service.linkFinishes(changed);
    expect(service.linkFinishes(changed)).toEqual([]);
    const pull = idOf('R_api:pull/1');
    const issue = idOf('lin-ENG-412');
    store.record({ type: 'unlink', from: pull, linkType: 'finishes', to: issue }, { by: { kind: 'user' } });

    const again = saveGitHub(pullRequest(1, { title: 'ENG-412: retry webhooks', updatedAt: NOW }));
    expect(service.linkFinishes(again)).toEqual([]);
    expect(finishesFrom(pull)).toEqual([]);
  });

  it('runs after each GitHub sync, and after a Linear sync brings new issues', async () => {
    const service = oversight();
    const changed = saveGitHub(pullRequest(1, { title: 'ENG-412 and OPS-9' }));
    await service.synced({ account: GITHUB, source: 'github', outcome: 'synced', itemIds: changed });
    expect(finishesFrom(idOf('R_api:pull/1'))).toEqual([idOf('lin-ENG-412')]);

    const saved = store.saveFromSource({ source: 'linear', account: LINEAR, items: [linearIssue('OPS-9')] });
    await service.synced({ account: LINEAR, source: 'linear', outcome: 'synced', itemIds: saved.created });
    expect(finishesFrom(idOf('R_api:pull/1'))).toEqual([idOf('lin-ENG-412'), idOf('lin-OPS-9')]);
  });
});

describe('the writer’s detail', () => {
  const read = (nodeIds: readonly string[]) =>
    new Map<string, ReadWriterDetail>(
      nodeIds.map((nodeId) => [
        nodeId,
        {
          description: `About ${nodeId}`,
          linkedIssues: [],
          reviews: [],
          reviewComments: [],
          comments: [],
          moreComments: false,
          changeOutline: { areas: [], files: 0, totalFiles: 0 },
        },
      ]),
    );

  it('is fetched after a GitHub sync for the pull requests in the summary, once until they change', async () => {
    const asked: string[][] = [];
    const service = oversight({
      read: async (_options, nodeIds) => {
        asked.push([...nodeIds]);
        return read(nodeIds);
      },
    });
    const changed = saveGitHub(
      pullRequest(1, { state: 'merged', mergedAt: NOW - HOUR, closedAt: NOW - HOUR }),
      // Not in the summary: opened long ago, quiet, and not stuck.
      pullRequest(2, { createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY }),
    );
    await service.synced({ account: GITHUB, source: 'github', outcome: 'synced', itemIds: changed });
    expect(asked).toEqual([['PR_1']]);
    expect(store.githubOversight.writerDetail(idOf('R_api:pull/1'))).toMatchObject({
      description: 'About PR_1',
      forUpdatedAt: NOW - HOUR,
      fetchedAt: NOW,
    });

    await service.synced({ account: GITHUB, source: 'github', outcome: 'synced', itemIds: [] });
    expect(asked).toHaveLength(1);

    saveGitHub(
      pullRequest(1, { state: 'merged', mergedAt: NOW - HOUR, closedAt: NOW - HOUR, updatedAt: NOW }),
    );
    await service.synced({ account: GITHUB, source: 'github', outcome: 'synced', itemIds: [] });
    expect(asked).toEqual([['PR_1'], ['PR_1']]);
  });

  it('leaves it for the next sync when GitHub refuses, and says so', async () => {
    const logged: string[] = [];
    const refused: string[] = [];
    const service = oversight({
      read: async () => {
        throw new SignInRefused('no');
      },
      log: (message) => logged.push(message),
      onSignInRefused: (account) => refused.push(account),
    });
    const changed = saveGitHub(pullRequest(1, { createdAt: NOW - HOUR }));
    await service.synced({ account: GITHUB, source: 'github', outcome: 'synced', itemIds: changed });
    expect(store.githubOversight.writerDetail(idOf('R_api:pull/1'))).toBeNull();
    expect(refused).toEqual([GITHUB]);
  });
});
