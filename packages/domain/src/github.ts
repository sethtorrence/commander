import { z } from 'zod';

/*
  What GitHub sync (#114) keeps: the detail of its four Item kinds, and each watched repo's health.

  - `pull-request` and `github-issue`: the pull request or issue as GitHub reported it. Bodies are
    Markdown written by other people: untrusted Source content, kept as data and shown read-only.
  - `review-request`: one per open pull request where review is asked of the User, directly or from
    one of their teams. It is tombstoned once the review is given or the request withdrawn.
  - `github-release`: a published release.

  GitHub users are kept as handles (`github:<login>`, and email addresses where GitHub gives them),
  which belong to People (people.ts). Every Item's external id starts with its repo's node id
  (`githubExternalId`), so unwatching a repo finds its Items.

  Repo health is not Items: per watched repo, its default branch, the head commit's check state and
  the commits since lately (reverts flagged), kept in the Account's catalog for the oversight summary.
*/

const timestamp = z.number().int().nonnegative();
const login = z.string().min(1);

// A repo as an Item names it: by node id, with its owner and name as GitHub last reported them.
export const githubRepoName = z.object({ nodeId: z.string().min(1), owner: login, name: z.string().min(1) });
export type GitHubRepoName = z.infer<typeof githubRepoName>;

export const githubLabel = z.object({ name: z.string(), color: z.string() });

// The combined state of a commit's checks and statuses (GitHub's StatusState), lower-cased.
export const githubCheckStates = ['success', 'failure', 'error', 'pending', 'expected'] as const;
export const githubCheckState = z.enum(githubCheckStates);
export type GitHubCheckState = z.infer<typeof githubCheckState>;

// Someone asked to review: a GitHub user, or a team ("org/slug"), and when they were last asked
// (null when GitHub's timeline didn't say).
export const githubRequestedReviewer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), login, requestedAt: timestamp.nullable() }),
  z.object({ kind: z.literal('team'), team: z.string().min(1), requestedAt: timestamp.nullable() }),
]);
export type GitHubRequestedReviewer = z.infer<typeof githubRequestedReviewer>;

// The latest review from one reviewer.
export const githubReviewStates = [
  'approved',
  'changes-requested',
  'commented',
  'dismissed',
  'pending',
] as const;
export const githubReview = z.object({
  login,
  state: z.enum(githubReviewStates),
  submittedAt: timestamp.nullable(),
});
export type GitHubReview = z.infer<typeof githubReview>;

// An issue a pull request closes when merged, or an issue's parent.
export const githubIssueRef = z.object({
  owner: login,
  name: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
});
export type GitHubIssueRef = z.infer<typeof githubIssueRef>;

export const pullRequestDetail = z.object({
  kind: z.literal('pull-request'),
  repo: githubRepoName,
  number: z.number().int().positive(),
  url: z.string(),
  // GitHub's node id for the pull request (kept to notice it moving or being deleted).
  nodeId: z.string().min(1),
  // null for a deleted GitHub user ("ghost").
  author: login.nullable(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  baseBranch: z.string(),
  headBranch: z.string(),
  labels: z.array(githubLabel),
  assignees: z.array(login),
  requestedReviewers: z.array(githubRequestedReviewer),
  // The latest review per reviewer, and GitHub's overall review decision.
  reviews: z.array(githubReview),
  reviewDecision: z.enum(['approved', 'changes-requested', 'review-required']).nullable(),
  // The head commit's check rollup; null when it has no checks.
  checks: githubCheckState.nullable(),
  closingIssues: z.array(githubIssueRef),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  // Markdown, read-only.
  body: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  mergedAt: timestamp.nullable(),
  closedAt: timestamp.nullable(),
});
export type PullRequestDetail = z.infer<typeof pullRequestDetail>;

export const githubIssueDetail = z.object({
  kind: z.literal('github-issue'),
  repo: githubRepoName,
  number: z.number().int().positive(),
  url: z.string(),
  nodeId: z.string().min(1),
  author: login.nullable(),
  assignees: z.array(login),
  labels: z.array(githubLabel),
  milestone: z.object({ title: z.string(), dueOn: timestamp.nullable() }).nullable(),
  state: z.enum(['open', 'closed']),
  // Why it was closed (or that it was reopened), as GitHub says; null when it doesn't.
  stateReason: z.enum(['completed', 'not-planned', 'reopened', 'duplicate']).nullable(),
  // Markdown, read-only.
  body: z.string(),
  commentCount: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
  closedAt: timestamp.nullable(),
  // Sub-issues, where GitHub gives them: the parent, and how many sub-issues are done.
  parent: githubIssueRef.nullable(),
  subIssues: z
    .object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() })
    .nullable(),
});
export type GitHubIssueDetail = z.infer<typeof githubIssueDetail>;

export const reviewRequestDetail = z.object({
  kind: z.literal('review-request'),
  // The pull request's Item in the same Account: its external id, and its Item id (filled in by the
  // Item store when it saves the request; null until the pull request is saved).
  pullRequest: z.string().min(1),
  pullRequestId: z.string().min(1).nullable(),
  repo: githubRepoName,
  number: z.number().int().positive(),
  url: z.string(),
  // Asked of the User directly, and/or through these teams of theirs ("org/slug").
  direct: z.boolean(),
  teams: z.array(z.string().min(1)),
  // When review was last asked of the User (or their team); null when GitHub's timeline didn't say.
  requestedAt: timestamp.nullable(),
});
export type ReviewRequestDetail = z.infer<typeof reviewRequestDetail>;

export const githubReleaseDetail = z.object({
  kind: z.literal('github-release'),
  repo: githubRepoName,
  tag: z.string(),
  name: z.string().nullable(),
  url: z.string(),
  author: login.nullable(),
  prerelease: z.boolean(),
  publishedAt: timestamp.nullable(),
  // Markdown, read-only.
  notes: z.string(),
});
export type GitHubReleaseDetail = z.infer<typeof githubReleaseDetail>;

// One commit on a repo's default branch, for repo health. `revert`: it reverts another commit.
export const githubCommit = z.object({
  oid: z.string().min(1),
  headline: z.string(),
  author: z.object({ login: login.nullable(), name: z.string().nullable(), email: z.string().nullable() }),
  committedAt: timestamp,
  revert: z.boolean(),
});
export type GitHubCommit = z.infer<typeof githubCommit>;

// A watched repo's health, as GitHub sync last saw it.
export const githubRepoHealth = z.object({
  repo: githubRepoName,
  // null for an empty repo.
  defaultBranch: z.string().nullable(),
  head: z
    .object({ oid: z.string().min(1), checks: githubCheckState.nullable(), committedAt: timestamp })
    .nullable(),
  // Default-branch commits from the last week (newest first, at most GITHUB_HEALTH_COMMITS).
  commits: z.array(githubCommit),
  checkedAt: timestamp,
});
export type GitHubRepoHealth = z.infer<typeof githubRepoHealth>;

// A GitHub Account's catalog: each watched repo's health.
export const githubCatalog = z.object({ kind: z.literal('github'), repos: z.array(githubRepoHealth) });
export type GitHubCatalog = z.infer<typeof githubCatalog>;

export const GITHUB_HEALTH_DAYS = 7;
export const GITHUB_HEALTH_COMMITS = 50;

// Whether a commit reverts another: GitHub's and git's own wording ('Revert "…"', "This reverts
// commit <sha>").
export function isRevert(message: string): boolean {
  return /^revert\b/i.test(message.trim()) || /this reverts commit [0-9a-f]{7,40}/i.test(message);
}

// What people search for a pull request or issue by: "owner/name#123".
export function githubIdentifier(repo: Pick<GitHubRepoName, 'owner' | 'name'>, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`;
}

// The detail of any of GitHub's four Item kinds.
export type GitHubItemDetail =
  | PullRequestDetail
  | GitHubIssueDetail
  | ReviewRequestDetail
  | GitHubReleaseDetail;
export const GITHUB_ITEM_KINDS = [
  'pull-request',
  'github-issue',
  'review-request',
  'github-release',
] as const;

export function isGitHubItemDetail(detail: { kind: string } | null | undefined): detail is GitHubItemDetail {
  return !!detail && (GITHUB_ITEM_KINDS as readonly string[]).includes(detail.kind);
}
