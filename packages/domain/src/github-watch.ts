import { z } from 'zod';

/*
  What a GitHub Account watches (#113), and what that means against what the Account can reach.

  The User picks, per Account, in Settings → GitHub:
  - whole orgs: every repo in the org, those made there later included, less any repos left out;
  - single repos, by node id (with owner and name for display), in orgs not watched whole and among
    their personal repos.

  The selection is saved as those rules, never as a resolved list, so a repo made in a watched org
  is picked up by the next listing (and by GitHub sync, #114) with nothing saved changing. Only
  repos the Account can reach are ever watched in effect (`watchedRepos`): a watched repo the
  Account can no longer reach (the app uninstalled, access ended, the repo archived) stays in the
  selection, named by `unreachableWatched`, until the User unwatches it or access comes back.
*/

const login = z.string().min(1).max(100);
const timestamp = z.number().int().nonnegative();

// A repository as Settings → GitHub lists it. Archived repos are never listed.
export const githubRepo = z.object({
  // GitHub's global node id (REST `node_id`, GraphQL `id`): stable across renames and transfers.
  nodeId: z.string().min(1).max(200),
  owner: login,
  name: z.string().min(1).max(100),
  visibility: z.enum(['public', 'private', 'internal']),
  // When something was last pushed to it; null for an empty repo.
  pushedAt: timestamp.nullable(),
});
export type GitHubRepo = z.infer<typeof githubRepo>;

// A repo as the selection keeps it: by node id, with owner and name for display.
export const githubRepoRef = githubRepo.pick({ nodeId: true, owner: true, name: true });
export type GitHubRepoRef = z.infer<typeof githubRepoRef>;

// An organization the Account can see, and how Commander reaches its repos.
export const githubOrgAccess = z.object({
  login,
  // GitHub's numeric id, for "Install or request…" on that org; null when GitHub didn't say.
  id: z.number().int().positive().nullable(),
  // 'installed': Commander's GitHub App is installed there (its repos are those the install
  // covers). 'not-installed': the User is a member but the app isn't installed, so no repos show.
  // 'token': a token Account, which reaches whatever the User can.
  reach: z.enum(['installed', 'not-installed', 'token']),
  repos: z.array(githubRepo),
  // Added by name in Settings → GitHub, where GitHub's lists didn't show it.
  addedByName: z.boolean(),
  // Why its repos couldn't be listed (SAML SSO not authorised, say), for the User.
  problem: z.string().nullable(),
});
export type GitHubOrgAccess = z.infer<typeof githubOrgAccess>;

// Everything one GitHub Account can reach, as GitHub last listed it.
export const githubAccess = z.object({
  // 'app': Commander's GitHub App (installations and their repos). 'token': a classic token or gh's
  // sign-in (the User's own lists).
  via: z.enum(['app', 'token']),
  // The GitHub user signed in.
  login,
  orgs: z.array(githubOrgAccess),
  // Repos owned by user accounts: the User's own, and others' they collaborate on.
  personal: z.array(githubRepo),
  fetchedAt: timestamp,
});
export type GitHubAccess = z.infer<typeof githubAccess>;

// What an Account watches.
export const githubWatch = z.object({
  // Orgs watched whole, with any repos left out.
  orgs: z.array(z.object({ login, except: z.array(githubRepoRef).max(5000) })).max(1000),
  // Repos watched one by one (never ones in an org watched whole).
  repos: z.array(githubRepoRef).max(5000),
});
export type GitHubWatch = z.infer<typeof githubWatch>;

export const noWatch = (): GitHubWatch => ({ orgs: [], repos: [] });

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const refOf = ({ nodeId, owner, name }: GitHubRepoRef): GitHubRepoRef => ({ nodeId, owner, name });
const without = (refs: GitHubRepoRef[], nodeId: string) => refs.filter((each) => each.nodeId !== nodeId);

const wholeOrg = (watch: GitHubWatch, owner: string) => watch.orgs.find((org) => same(org.login, owner));

export function orgWatchedWhole(watch: GitHubWatch, org: string): boolean {
  return wholeOrg(watch, org) !== undefined;
}

export function isWatched(watch: GitHubWatch, repo: GitHubRepoRef): boolean {
  const org = wholeOrg(watch, repo.owner);
  if (org) return !org.except.some((each) => each.nodeId === repo.nodeId);
  return watch.repos.some((each) => each.nodeId === repo.nodeId);
}

export function setRepoWatched(watch: GitHubWatch, repo: GitHubRepoRef, watched: boolean): GitHubWatch {
  const org = wholeOrg(watch, repo.owner);
  if (org) {
    const except = watched
      ? without(org.except, repo.nodeId)
      : [...without(org.except, repo.nodeId), refOf(repo)];
    return { ...watch, orgs: watch.orgs.map((each) => (each === org ? { ...org, except } : each)) };
  }
  const repos = without(watch.repos, repo.nodeId);
  return { ...watch, repos: watched ? [...repos, refOf(repo)] : repos };
}

// Watching an org whole takes in the repos chosen there one by one; unwatching it unwatches all.
export function setOrgWatched(watch: GitHubWatch, org: string, watched: boolean): GitHubWatch {
  const orgs = watch.orgs.filter((each) => !same(each.login, org));
  const repos = watch.repos.filter((each) => !same(each.owner, org));
  return { orgs: watched ? [...orgs, { login: org, except: [] }] : orgs, repos };
}

// Every repo the Account can reach, orgs first (in GitHub's order), then personal ones.
export function reachableRepos(access: GitHubAccess): GitHubRepo[] {
  return [...access.orgs.flatMap((org) => org.repos), ...access.personal];
}

// The repos watched in effect: watched, and reachable. What GitHub sync reads.
export function watchedRepos(watch: GitHubWatch, access: GitHubAccess): GitHubRepo[] {
  return reachableRepos(access).filter((repo) => isWatched(watch, repo));
}

// What the selection names that the Account can't reach now: single repos (and repos left out of a
// whole org don't count), and orgs watched whole that it can't list repos of.
export function unreachableWatched(
  watch: GitHubWatch,
  access: GitHubAccess,
): { repos: GitHubRepoRef[]; orgs: string[] } {
  const reachable = new Set(reachableRepos(access).map((repo) => repo.nodeId));
  const listed = (login: string) =>
    access.orgs.find((org) => same(org.login, login) && org.reach !== 'not-installed');
  return {
    repos: watch.repos.filter((repo) => !reachable.has(repo.nodeId)),
    orgs: watch.orgs.filter((org) => !listed(org.login)).map((org) => org.login),
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// "Watching 23 repos in 3 orgs."
export function watchSummary(watch: GitHubWatch, access: GitHubAccess): string {
  const watched = new Set(watchedRepos(watch, access).map((repo) => repo.nodeId));
  const inOrgs = access.orgs.map((org) => org.repos.filter((repo) => watched.has(repo.nodeId)).length);
  const orgRepos = inOrgs.reduce((sum, count) => sum + count, 0);
  const orgs = inOrgs.filter((count) => count > 0).length;
  const personal = access.personal.filter((repo) => watched.has(repo.nodeId)).length;
  const total = orgRepos + personal;
  if (total === 0) return 'Not watching any repos yet.';
  if (personal === 0) return `Watching ${plural(total, 'repo')} in ${plural(orgs, 'org')}.`;
  if (orgRepos === 0) return `Watching ${personal} personal ${personal === 1 ? 'repo' : 'repos'}.`;
  return `Watching ${plural(total, 'repo')}: ${orgRepos} in ${plural(orgs, 'org')} and ${personal} personal.`;
}

// The first selection for an Account: the repos the User pushed to, opened pull requests in or
// reviewed lately (`worked`: their node ids), as checked repos rather than a hidden rule.
export function defaultWatch(access: GitHubAccess, worked: readonly string[]): GitHubWatch {
  const ids = new Set(worked);
  return {
    orgs: [],
    repos: reachableRepos(access)
      .filter((repo) => ids.has(repo.nodeId))
      .map(refOf),
  };
}

// Every repo the Account is known to have: those listed now, and those seen before (`seen`).
export function knownRepos(access: GitHubAccess | null, seen: readonly GitHubRepoRef[]): GitHubRepoRef[] {
  const known = new Map<string, GitHubRepoRef>();
  for (const repo of [...(access ? reachableRepos(access) : []), ...seen])
    if (!known.has(repo.nodeId)) known.set(repo.nodeId, refOf(repo));
  return [...known.values()];
}

// The repos a change stops watching, whose Items go: among the known repos and those the old
// selection names.
export function stoppedWatching(
  before: GitHubWatch,
  after: GitHubWatch,
  known: readonly GitHubRepoRef[],
): GitHubRepoRef[] {
  return knownRepos(null, [...known, ...before.repos]).filter(
    (repo) => isWatched(before, repo) && !isWatched(after, repo),
  );
}

// A GitHub Item's external id starts with its repo's node id ("<repo node id>:<the rest>"), so
// unwatching a repo finds its Items. GitHub sync (#114) keys every Item this way.
export function githubExternalId(repoNodeId: string, rest: string): string {
  return `${repoNodeId}:${rest}`;
}

export function githubRepoOfExternalId(externalId: string): string | null {
  const at = externalId.indexOf(':');
  return at > 0 ? externalId.slice(0, at) : null;
}
