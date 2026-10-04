// Fixture GitHub work for the GitHub summary's tests (#121): pull requests, issues and a repo's health
// as GitHub sync saves them, a Linear issue a pull request finishes, and the writer's detail.
import type {
  GitHubIssueDetail,
  GitHubRepoHealth,
  GitHubWriterDetail,
  PullRequestDetail,
  SourceItem,
} from '@commander/domain';
import type { ItemStore } from '../../item-store';

export const GITHUB = 'github:583231';
export const API = { nodeId: 'R_api', owner: 'acme', name: 'titanlink-api' };
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function pullRequest(
  now: number,
  number: number,
  title: string,
  changes: Partial<PullRequestDetail> = {},
): SourceItem {
  return {
    externalId: `R_api:pull/${number}`,
    kind: 'pull-request',
    title,
    status: changes.state && changes.state !== 'open' ? 'done' : 'open',
    detail: {
      kind: 'pull-request',
      repo: API,
      number,
      url: `https://github.com/acme/titanlink-api/pull/${number}`,
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
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      body: '',
      createdAt: now - 3 * DAY,
      updatedAt: now - 2 * HOUR,
      mergedAt: null,
      closedAt: null,
      ...changes,
    },
  };
}

/** A pull request merged `hoursAgo`. */
export const merged = (
  now: number,
  number: number,
  title: string,
  hoursAgo: number,
  changes: Partial<PullRequestDetail> = {},
) =>
  pullRequest(now, number, title, {
    state: 'merged',
    mergedAt: now - hoursAgo * HOUR,
    closedAt: now - hoursAgo * HOUR,
    updatedAt: now - hoursAgo * HOUR,
    ...changes,
  });

export function issue(
  now: number,
  number: number,
  title: string,
  changes: Partial<GitHubIssueDetail> = {},
): SourceItem {
  return {
    externalId: `R_api:issue/${number}`,
    kind: 'github-issue',
    title,
    status: changes.state === 'closed' ? 'done' : 'open',
    detail: {
      kind: 'github-issue',
      repo: API,
      number,
      url: `https://github.com/acme/titanlink-api/issues/${number}`,
      nodeId: `I_${number}`,
      author: 'priya',
      assignees: [],
      labels: [],
      milestone: null,
      state: 'open',
      stateReason: null,
      body: '',
      commentCount: 0,
      createdAt: now - 20 * DAY,
      updatedAt: now - 2 * HOUR,
      closedAt: null,
      parent: null,
      subIssues: null,
      ...changes,
    },
  };
}

export function syncGitHub(store: ItemStore, items: SourceItem[]) {
  store.saveFromSource({ source: 'github', account: GITHUB, items });
}

export function repoHealth(store: ItemStore, now: number, changes: Partial<GitHubRepoHealth> = {}) {
  store.syncState.saveCatalog(
    GITHUB,
    'github',
    {
      kind: 'github',
      repos: [
        {
          repo: API,
          defaultBranch: 'main',
          head: { oid: 'abc1234', checks: 'success', committedAt: now - HOUR },
          commits: [],
          checkedAt: now - HOUR,
          ...changes,
        },
      ],
    },
    now,
  );
}

export const idOf = (store: ItemStore, title: string) => {
  const found = store.query({ titleContains: title, limit: 5 }).find((item) => item.title === title);
  if (!found) throw new Error(`No Item titled ${title}`);
  return found.id;
};

/** A Linear issue the pull request finishes (a finishes Link, made by GitHub as sync makes them). */
export function finishes(store: ItemStore, pullRequestId: string, identifier: string): string {
  store.saveFromSource({
    source: 'linear',
    account: 'linear:1',
    items: [
      {
        externalId: identifier,
        kind: 'linear-issue',
        title: `Linear ${identifier}`,
        detail: {
          kind: 'linear-issue',
          identifier,
          url: `https://linear.app/acme/issue/${identifier}`,
          team: { id: 'team-eng', key: identifier.split('-')[0] ?? 'ENG', name: 'Engineering' },
          state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' },
          priority: 2,
          assignee: null,
          creator: null,
          labels: [],
          linearProject: null,
          cycle: null,
          dueDate: null,
          estimate: null,
          description: null,
          comments: [],
          createdAt: 0,
          updatedAt: 0,
          startedAt: null,
          completedAt: null,
          canceledAt: null,
        },
      },
    ],
  });
  const linearId = idOf(store, `Linear ${identifier}`);
  store.link(
    { from: pullRequestId, linkType: 'finishes', to: linearId },
    { by: { kind: 'source', source: 'github', account: GITHUB }, why: `names ${identifier}` },
  );
  return linearId;
}

export function writerDetail(
  updatedAt: number,
  changes: Partial<GitHubWriterDetail> = {},
): GitHubWriterDetail {
  return {
    forUpdatedAt: updatedAt,
    fetchedAt: updatedAt,
    description: '',
    linkedIssues: [],
    reviews: [],
    reviewComments: [],
    comments: [],
    moreComments: false,
    changeOutline: { areas: [], files: 0, totalFiles: 0 },
    ...changes,
  };
}
