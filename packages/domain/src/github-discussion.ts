import { z } from 'zod';

/*
  A pull request's or issue's discussion, fetched on demand (#115): GitHub sync doesn't keep comment
  threads (they're expensive to fetch for every repo), so opening one in the GitHub Section asks
  GitHub for them with one GraphQL query. What comes back is kept beside the Item's detail until the
  Item next changes (GitHub's updated time moves), when opening it fetches again.

  - `entries`: the conversation comments, reviews (with a body or a verdict) and review comments on
    lines of code, oldest first: the latest 50 of each. `more`: GitHub had older ones left out.
  - `checks`: a pull request's head commit checks, each with its name, state and page (the check run
    or status's own link); null for an issue.

  Every body is Markdown written by other people: untrusted Source content, shown read-only.

  The window asks the main process, which adds where GitHub's API lives and relays to the Core. The
  Core borrows the Account's token, asks GitHub and keeps the answer through the Item store. No token
  ever reaches the window.
*/

const timestamp = z.number().int().nonnegative();

export const githubDiscussionEntry = z.object({
  id: z.string().min(1),
  kind: z.enum(['comment', 'review', 'review-comment']),
  // null for a deleted GitHub user ("ghost").
  author: z.string().min(1).nullable(),
  body: z.string(),
  at: timestamp,
  url: z.string(),
  // A review's verdict.
  state: z.enum(['approved', 'changes-requested', 'commented', 'dismissed', 'pending']).nullable(),
  // A review comment's file and line.
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
});
export type GitHubDiscussionEntry = z.infer<typeof githubDiscussionEntry>;

// One check on a pull request's head commit: a check run (by its conclusion, or its status while it
// runs) or a commit status, lower-cased.
export const githubCheckRunStates = [
  'success',
  'failure',
  'pending',
  'neutral',
  'skipped',
  'cancelled',
  'timed-out',
  'action-required',
  'stale',
  'error',
] as const;
export const githubCheck = z.object({
  name: z.string(),
  state: z.enum(githubCheckRunStates),
  // The check's page on GitHub (or wherever the status points); null when it has none.
  url: z.string().nullable(),
});
export type GitHubCheck = z.infer<typeof githubCheck>;

export const githubDiscussion = z.object({
  // The Item's detail `updatedAt` it was fetched for: once the Item changes, it is fetched again.
  forUpdatedAt: timestamp,
  fetchedAt: timestamp,
  entries: z.array(githubDiscussionEntry),
  more: z.boolean(),
  checks: z.array(githubCheck).nullable(),
});
export type GitHubDiscussion = z.infer<typeof githubDiscussion>;

// The latest entries of each kind fetched.
export const GITHUB_DISCUSSION_LATEST = 50;

const requestId = z.number().int().positive();
const itemId = z.string().min(1).max(500);

// Window → main process: the discussion of a pull request's or issue's Item.
export const githubDiscussionRequest = z.object({ itemId });
export type GitHubDiscussionRequest = z.input<typeof githubDiscussionRequest>;

export const githubDiscussionResponse = z.union([
  z.object({ ok: z.literal(true), discussion: githubDiscussion }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type GitHubDiscussionResponse = z.infer<typeof githubDiscussionResponse>;

// Main process → Core: the window's request, with where GitHub's REST API lives (GraphQL is
// <apiUrl>/graphql).
export const coreGitHubDiscussionRequest = z.object({
  type: z.literal('github-discussion-request'),
  id: requestId,
  apiUrl: z.url(),
  request: githubDiscussionRequest,
});
export type CoreGitHubDiscussionRequest = z.input<typeof coreGitHubDiscussionRequest>;

export const coreGitHubDiscussionReply = z.object({
  type: z.literal('github-discussion-reply'),
  id: requestId,
  response: githubDiscussionResponse,
});
export type CoreGitHubDiscussionReply = z.infer<typeof coreGitHubDiscussionReply>;
