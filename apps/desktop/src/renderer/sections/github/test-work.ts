import type {
  GitHubIssueDetail,
  PullRequestDetail,
  ReviewRequestDetail,
  SourceItem,
} from '@commander/domain';

// For tests only: pull requests and issues as GitHub sync hands them to the Item store
// (saveFromSource), with everything not under test filled in.

export const GITHUB = 'github:583231';
export const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;

export const API = { nodeId: 'R_api', owner: 'acme', name: 'api' };
export const WEB = { nodeId: 'R_web', owner: 'acme', name: 'web' };
export const DOTFILES = { nodeId: 'R_dotfiles', owner: 'octocat', name: 'dotfiles' };

export type PullInput = Partial<PullRequestDetail> & { number: number; title?: string };

/** A `pull-request` Item as GitHub sync hands it over. */
export function pull({ title, ...changes }: PullInput): SourceItem {
  const repo = changes.repo ?? API;
  const detail: PullRequestDetail = {
    kind: 'pull-request',
    repo,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${changes.number}`,
    nodeId: `PR_${repo.name}_${changes.number}`,
    author: 'priya',
    state: 'open',
    draft: false,
    baseBranch: 'main',
    headBranch: `branch-${changes.number}`,
    labels: [],
    assignees: [],
    requestedReviewers: [],
    reviews: [],
    reviewDecision: null,
    checks: null,
    closingIssues: [],
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    body: '',
    createdAt: NOW - 48 * HOUR,
    updatedAt: NOW - HOUR,
    mergedAt: null,
    closedAt: null,
    ...changes,
  };
  return {
    externalId: `${repo.nodeId}:pull/${changes.number}`,
    kind: 'pull-request',
    title: title ?? `Pull request ${changes.number}`,
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

export type IssueInput = Partial<GitHubIssueDetail> & { number: number; title?: string };

/** A `github-issue` Item as GitHub sync hands it over. */
export function issue({ title, ...changes }: IssueInput): SourceItem {
  const repo = changes.repo ?? API;
  const detail: GitHubIssueDetail = {
    kind: 'github-issue',
    repo,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${changes.number}`,
    nodeId: `I_${repo.name}_${changes.number}`,
    author: 'priya',
    assignees: [],
    labels: [],
    milestone: null,
    state: 'open',
    stateReason: null,
    body: '',
    commentCount: 0,
    createdAt: NOW - 72 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    closedAt: null,
    parent: null,
    subIssues: null,
    ...changes,
  };
  return {
    externalId: `${repo.nodeId}:issue/${changes.number}`,
    kind: 'github-issue',
    title: title ?? `Issue ${changes.number}`,
    status: detail.state === 'open' ? 'open' : 'done',
    detail,
  };
}

/** A review asked of the User on a pull request (by its external id). */
export function reviewRequest(number: number, repo = API): SourceItem {
  const detail: ReviewRequestDetail = {
    kind: 'review-request',
    pullRequest: `${repo.nodeId}:pull/${number}`,
    pullRequestId: null,
    repo,
    number,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
    direct: true,
    teams: [],
    requestedAt: NOW - HOUR,
  };
  return {
    externalId: `${repo.nodeId}:review-request/${number}`,
    kind: 'review-request',
    title: `Review ${number}`,
    detail,
  };
}
