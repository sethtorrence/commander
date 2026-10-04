import { z } from 'zod';
import { githubAccess, githubRepoRef, githubWatch } from './github-watch';

/*
  Settings → GitHub (#113): the window asks the main process, which adds where GitHub's API lives
  and relays to the Core. The Core borrows the Account's token, lists what it can reach, and keeps
  the selection through the Item store. No token ever reaches the window.
*/

const requestId = z.number().int().positive();
const account = z.string().min(1).max(200);

// A GitHub user or organization login: letters, digits and single hyphens, up to 39 characters.
export const githubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'That isn’t a GitHub org name.');

// Window → main process.
export const githubWatchRequest = z.discriminatedUnion('op', [
  // What the Account can reach and what it watches. The first time, the selection starts as the
  // repos the User worked in over the last 90 days.
  z.object({ op: z.literal('load'), account }),
  // Saves the selection. When it stops watching repos that have Items in Commander, nothing is saved
  // until it comes again `confirmed`: the answer says how many Items would go.
  z.object({ op: z.literal('save'), account, watch: githubWatch, confirmed: z.boolean().default(false) }),
  // An org GitHub's lists didn't show (orgs without the app, say), added by name.
  z.object({ op: z.literal('add-org'), account, login: githubLogin }),
]);
export type GitHubWatchRequest = z.input<typeof githubWatchRequest>;

export const githubWatchView = z.object({
  account,
  // What the Account can reach, as GitHub last listed it; null before it ever could be.
  access: githubAccess.nullable(),
  watch: githubWatch,
  // The selection is still the one Commander started with (the repos worked in lately).
  fromDefault: z.boolean(),
  // Why GitHub couldn't be asked just now (offline, a sign-in to reconnect), for the User; what
  // shows is then the last listing.
  problem: z.string().nullable(),
});
export type GitHubWatchView = z.infer<typeof githubWatchView>;

// Unwatching asks first: how many Items would be removed, from which repos.
export const githubUnwatchConfirm = z.object({
  items: z.number().int().positive(),
  repos: z.array(githubRepoRef),
});
export type GitHubUnwatchConfirm = z.infer<typeof githubUnwatchConfirm>;

export const githubWatchResponse = z.union([
  z.object({ ok: z.literal(true), view: githubWatchView, confirm: githubUnwatchConfirm.optional() }),
  z.object({ ok: z.literal(false), error: z.string(), view: githubWatchView.nullable() }),
]);
export type GitHubWatchResponse = z.infer<typeof githubWatchResponse>;

// Main process → Core: the window's request, with where GitHub's REST API lives (GraphQL is
// <apiUrl>/graphql).
export const coreGitHubWatchRequest = z.object({
  type: z.literal('github-watch-request'),
  id: requestId,
  apiUrl: z.url(),
  request: githubWatchRequest,
});
export type CoreGitHubWatchRequest = z.input<typeof coreGitHubWatchRequest>;

export const coreGitHubWatchReply = z.object({
  type: z.literal('github-watch-reply'),
  id: requestId,
  response: githubWatchResponse,
});
export type CoreGitHubWatchReply = z.infer<typeof coreGitHubWatchReply>;

// Main process → Core, for the end-to-end tests only (COMMANDER_TEST_HOOKS=1; the Core ignores it
// otherwise): saves pull requests as GitHub sync will, so unwatching has Items to remove.
export const coreGitHubTestItems = z.object({
  type: z.literal('github-test-items'),
  account,
  items: z
    .array(
      z.object({ repoNodeId: z.string().min(1), number: z.number().int().positive(), title: z.string() }),
    )
    .max(100),
});
export type CoreGitHubTestItems = z.infer<typeof coreGitHubTestItems>;
