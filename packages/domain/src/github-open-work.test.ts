import { describe, expect, it } from 'vitest';
import type { GitHubIssueDetail, PullRequestDetail, ReviewRequestDetail } from './github';
import {
  changesRequestedBy,
  checksFailing,
  githubIssueTodoFate,
  githubTabCount,
  isTheirs,
  reviewEndedWhy,
  reviewTodoTitle,
  waitingOn,
  waitingSince,
} from './github-open-work';
import type { Item } from './items';

// The User's open work on GitHub (#116): which pull requests are theirs, what they wait on, why a
// review request ended, when an assigned issue is a Todo, and what the GitHub tab counts.

const T = Date.UTC(2026, 9, 3, 9);
const HOUR = 3_600_000;
const repo = { nodeId: 'R_api', owner: 'acme', name: 'api' };

function pull(changes: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    kind: 'pull-request',
    repo,
    number: 12,
    url: 'https://github.com/acme/api/pull/12',
    nodeId: 'PR_12',
    author: 'octocat',
    state: 'open',
    draft: false,
    baseBranch: 'main',
    headBranch: 'retry',
    labels: [],
    assignees: [],
    requestedReviewers: [],
    reviews: [],
    reviewDecision: 'review-required',
    checks: 'success',
    closingIssues: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    body: '',
    createdAt: T - 72 * HOUR,
    updatedAt: T,
    mergedAt: null,
    closedAt: null,
    ...changes,
  };
}

function issue(changes: Partial<GitHubIssueDetail> = {}): GitHubIssueDetail {
  return {
    kind: 'github-issue',
    repo,
    number: 30,
    url: 'https://github.com/acme/api/issues/30',
    nodeId: 'I_30',
    author: 'priya',
    assignees: ['octocat'],
    labels: [],
    milestone: null,
    state: 'open',
    stateReason: null,
    body: '',
    commentCount: 0,
    createdAt: T,
    updatedAt: T,
    closedAt: null,
    parent: null,
    subIssues: null,
    ...changes,
  };
}

const item = (detail: Item['detail'], changes: Partial<Item> = {}): Item => ({
  id: `item-${Math.random()}`,
  kind: (detail?.kind ?? 'todo') as Item['kind'],
  source: 'github',
  account: 'github:1',
  externalId: 'x',
  title: 'A title',
  people: [],
  filing: null,
  status: 'open',
  createdAt: T,
  updatedAt: T,
  deletedAt: null,
  detail,
  ...changes,
});

function request(changes: Partial<ReviewRequestDetail> = {}): ReviewRequestDetail {
  return {
    kind: 'review-request',
    pullRequest: 'R_api:pull/12',
    pullRequestId: 'pr',
    repo,
    number: 12,
    url: 'https://github.com/acme/api/pull/12',
    direct: true,
    teams: [],
    requestedAt: T - 48 * HOUR,
    ...changes,
  };
}

describe('the User’s pull requests', () => {
  it('are the ones they opened, whatever the case of the login', () => {
    expect(isTheirs(pull({ author: 'OctoCat' }), 'octocat')).toBe(true);
    expect(isTheirs(pull({ author: 'priya' }), 'octocat')).toBe(false);
    expect(isTheirs(pull({ author: null }), 'octocat')).toBe(false);
    expect(isTheirs(pull(), null)).toBe(false);
  });

  it('fail their checks on a failure or an error', () => {
    expect(checksFailing(pull({ checks: 'failure' }))).toBe(true);
    expect(checksFailing(pull({ checks: 'error' }))).toBe(true);
    expect(checksFailing(pull({ checks: 'pending' }))).toBe(false);
    expect(checksFailing(pull({ checks: null }))).toBe(false);
  });

  it('name who requested changes, by their latest review', () => {
    const detail = pull({
      reviews: [
        { login: 'omar', state: 'changes-requested', submittedAt: T },
        { login: 'dana', state: 'approved', submittedAt: T },
      ],
      reviewDecision: 'changes-requested',
    });
    expect(changesRequestedBy(detail)).toEqual(['omar']);
  });

  it('wait on the people and teams still asked to review, since they were last asked', () => {
    const detail = pull({
      requestedReviewers: [
        { kind: 'user', login: 'omar', requestedAt: T - 3 * 24 * HOUR },
        { kind: 'team', team: 'acme/backend', requestedAt: T - 24 * HOUR },
      ],
    });
    expect(waitingOn(detail)).toEqual(['omar', '@acme/backend']);
    expect(waitingSince(detail)).toBe(T - 24 * HOUR);
    expect(waitingSince(pull())).toBe(T - 72 * HOUR);
  });
});

describe('a review request’s Todo', () => {
  it('is titled after the pull request', () => {
    expect(reviewTodoTitle('Retry webhooks')).toBe('Review: Retry webhooks');
  });

  it('says why it went: merged, closed, the review given, or the request withdrawn', () => {
    const asked = T - 48 * HOUR;
    expect(reviewEndedWhy(pull({ state: 'merged' }), 'octocat', asked)).toBe('acme/api#12 was merged');
    expect(reviewEndedWhy(pull({ state: 'closed' }), 'octocat', asked)).toBe('acme/api#12 was closed');
    const reviewed = pull({ reviews: [{ login: 'OctoCat', state: 'approved', submittedAt: T }] });
    expect(reviewEndedWhy(reviewed, 'octocat', asked)).toBe('Review submitted');
    // A review from before the request was made again doesn't count.
    const old = pull({ reviews: [{ login: 'octocat', state: 'commented', submittedAt: asked - HOUR }] });
    expect(reviewEndedWhy(old, 'octocat', asked)).toBe('Review request withdrawn');
    expect(reviewEndedWhy(pull(), 'octocat', asked)).toBe('Review request withdrawn');
    expect(reviewEndedWhy(null, 'octocat', asked)).toBe('Review request withdrawn');
  });
});

describe('an assigned issue’s Todo', () => {
  it('is open while the issue is open and assigned to the User', () => {
    expect(githubIssueTodoFate(issue(), 'octocat')).toEqual({ todo: 'open' });
    expect(githubIssueTodoFate(issue({ assignees: ['priya', 'OctoCat'] }), 'octocat')).toEqual({
      todo: 'open',
    });
  });

  it('goes when the issue closes or is reassigned or unassigned, saying why', () => {
    expect(githubIssueTodoFate(issue({ state: 'closed' }), 'octocat')).toEqual({
      todo: 'none',
      why: 'acme/api#30 was closed',
    });
    expect(githubIssueTodoFate(issue({ assignees: ['priya'] }), 'octocat')).toEqual({
      todo: 'none',
      why: 'Reassigned to priya',
    });
    expect(githubIssueTodoFate(issue({ assignees: ['priya', 'omar'] }), 'octocat')).toEqual({
      todo: 'none',
      why: 'Reassigned to priya and omar',
    });
    expect(githubIssueTodoFate(issue({ assignees: [] }), 'octocat')).toEqual({
      todo: 'none',
      why: 'acme/api#30 was unassigned',
    });
  });

  it('is judged by state alone while who the User is isn’t known', () => {
    expect(githubIssueTodoFate(issue({ assignees: ['priya'] }), null)).toEqual({ todo: 'unknown' });
    expect(githubIssueTodoFate(issue({ state: 'closed' }), null)).toEqual({
      todo: 'none',
      why: 'acme/api#30 was closed',
    });
  });
});

describe('the GitHub tab', () => {
  it('counts direct review requests and the User’s pull requests failing checks or with changes requested', () => {
    const users = { 'github:1': 'octocat' };
    const items = [
      item(request()),
      item(request({ direct: false, teams: ['acme/backend'] })),
      item(request(), { deletedAt: T }),
      item(pull({ checks: 'failure' })),
      item(pull({ reviewDecision: 'changes-requested' })),
      item(pull({ checks: 'failure', author: 'priya' })),
      item(pull({ checks: 'failure', state: 'merged' }), { status: 'done' }),
      item(pull()),
      item(issue()),
    ];
    expect(githubTabCount(items, users)).toBe(3);
  });
});
