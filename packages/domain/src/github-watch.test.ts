import { describe, expect, it } from 'vitest';
import {
  defaultWatch,
  type GitHubAccess,
  type GitHubRepo,
  type GitHubWatch,
  githubExternalId,
  githubRepoOfExternalId,
  isWatched,
  knownRepos,
  noWatch,
  orgWatchedWhole,
  setOrgWatched,
  setRepoWatched,
  stoppedWatching,
  unreachableWatched,
  watchedRepos,
  watchSummary,
} from './github-watch';

// What a GitHub Account watches: whole orgs (with the repos made there later), chosen repos, and
// repos left out of a whole org; and what that means against what the Account can reach.

const repo = (owner: string, name: string, changes: Partial<GitHubRepo> = {}): GitHubRepo => ({
  nodeId: `R_${owner}_${name}`,
  owner,
  name,
  visibility: 'private',
  pushedAt: Date.UTC(2026, 8, 30),
  ...changes,
});

const api = repo('acme', 'api');
const web = repo('acme', 'web');
const infra = repo('acme', 'infra');
const site = repo('globex', 'site', { visibility: 'public' });
const dotfiles = repo('octocat', 'dotfiles', { visibility: 'public' });
const later = repo('acme', 'made-later');

const acme = { login: 'acme', id: 1, reach: 'installed' as const, addedByName: false, problem: null };

const access = (changes: Partial<GitHubAccess> = {}): GitHubAccess => ({
  via: 'app',
  login: 'octocat',
  orgs: [
    { ...acme, repos: [api, web, infra] },
    { login: 'globex', id: 2, reach: 'installed', repos: [site], addedByName: false, problem: null },
    { login: 'initech', id: 3, reach: 'not-installed', repos: [], addedByName: false, problem: null },
  ],
  personal: [dotfiles],
  fetchedAt: Date.UTC(2026, 9, 3),
  ...changes,
});

const ref = ({ nodeId, owner, name }: GitHubRepo) => ({ nodeId, owner, name });

describe('the selection model', () => {
  it('starts with nothing watched', () => {
    expect(watchedRepos(noWatch(), access())).toEqual([]);
    expect(watchSummary(noWatch(), access())).toBe('Not watching any repos yet.');
  });

  it('watches chosen repos one by one, and unwatches them', () => {
    let watch = setRepoWatched(noWatch(), api, true);
    watch = setRepoWatched(watch, dotfiles, true);
    expect(watch.repos).toEqual([ref(api), ref(dotfiles)]);
    expect(isWatched(watch, api)).toBe(true);
    expect(isWatched(watch, web)).toBe(false);

    watch = setRepoWatched(watch, api, false);
    expect(watch.repos).toEqual([ref(dotfiles)]);
    // Watching twice keeps one.
    expect(setRepoWatched(watch, dotfiles, true).repos).toHaveLength(1);
  });

  it('watches a whole org, repos made there later included, folding in repos chosen there before', () => {
    let watch = setRepoWatched(noWatch(), api, true);
    watch = setRepoWatched(watch, site, true);
    watch = setOrgWatched(watch, 'acme', true);

    expect(watch).toEqual({ orgs: [{ login: 'acme', except: [] }], repos: [ref(site)] });
    expect(orgWatchedWhole(watch, 'acme')).toBe(true);
    expect(watchedRepos(watch, access()).map((r) => r.name)).toEqual(['api', 'web', 'infra', 'site']);
    // A repo created in the org afterwards is watched without anything saved changing.
    const grown = access({
      orgs: [{ ...acme, repos: [api, web, infra, later] }, ...access().orgs.slice(1)],
    });
    expect(isWatched(watch, later)).toBe(true);
    expect(watchedRepos(watch, grown).map((r) => r.name)).toContain('made-later');
  });

  it('leaves single repos out of a whole org, and brings them back', () => {
    let watch = setOrgWatched(noWatch(), 'acme', true);
    watch = setRepoWatched(watch, web, false);

    expect(watch.orgs).toEqual([{ login: 'acme', except: [ref(web)] }]);
    expect(isWatched(watch, web)).toBe(false);
    expect(orgWatchedWhole(watch, 'acme')).toBe(true);
    expect(watchedRepos(watch, access()).map((r) => r.name)).toEqual(['api', 'infra']);

    watch = setRepoWatched(watch, web, true);
    expect(watch.orgs).toEqual([{ login: 'acme', except: [] }]);
    expect(watch.repos).toEqual([]);
  });

  it('unwatching a whole org unwatches every repo in it', () => {
    let watch = setOrgWatched(noWatch(), 'acme', true);
    watch = setRepoWatched(watch, site, true);
    watch = setOrgWatched(watch, 'acme', false);
    expect(watch).toEqual({ orgs: [], repos: [ref(site)] });
    expect(isWatched(watch, api)).toBe(false);
  });

  it('matches org logins whatever their case, as GitHub does', () => {
    const watch = setOrgWatched(noWatch(), 'ACME', true);
    expect(isWatched(watch, api)).toBe(true);
    expect(setOrgWatched(watch, 'acme', false).orgs).toEqual([]);
  });
});

describe('the summary line', () => {
  it('counts the repos watched and the orgs they are in', () => {
    let watch = setOrgWatched(noWatch(), 'acme', true);
    watch = setRepoWatched(watch, site, true);
    expect(watchSummary(watch, access())).toBe('Watching 4 repos in 2 orgs.');
    expect(watchSummary(setRepoWatched(noWatch(), api, true), access())).toBe('Watching 1 repo in 1 org.');
  });

  it('counts personal repos apart', () => {
    let watch = setOrgWatched(noWatch(), 'acme', true);
    watch = setRepoWatched(watch, dotfiles, true);
    expect(watchSummary(watch, access())).toBe('Watching 4 repos: 3 in 1 org and 1 personal.');
    expect(watchSummary(setRepoWatched(noWatch(), dotfiles, true), access())).toBe(
      'Watching 1 personal repo.',
    );
  });
});

describe('the default selection', () => {
  it('checks the repos the User worked in, among those the Account can reach', () => {
    const watch = defaultWatch(access(), [api.nodeId, dotfiles.nodeId, 'R_elsewhere_unreachable']);
    expect(watch).toEqual({ orgs: [], repos: [ref(api), ref(dotfiles)] });
  });
});

describe('losing access', () => {
  it('keeps watched repos the Account can no longer reach, and names them, without counting them', () => {
    let watch = setRepoWatched(noWatch(), site, true);
    watch = setOrgWatched(watch, 'acme', true);
    // The app was uninstalled from globex, and from acme: acme is now a membership without the app.
    const lost = access({
      orgs: [{ login: 'acme', id: 1, reach: 'not-installed', repos: [], addedByName: false, problem: null }],
    });

    expect(watchedRepos(watch, lost)).toEqual([]);
    expect(unreachableWatched(watch, lost)).toEqual({ repos: [ref(site)], orgs: ['acme'] });
    expect(watchSummary(watch, lost)).toBe('Not watching any repos yet.');
    expect(unreachableWatched(watch, access())).toEqual({ repos: [], orgs: [] });
  });
});

describe('what unwatching removes', () => {
  const known = knownRepos(access(), []);

  it('names the repos no longer watched after a change', () => {
    const before = setOrgWatched(setRepoWatched(noWatch(), site, true), 'acme', true);
    expect(stoppedWatching(before, setRepoWatched(before, web, false), known)).toEqual([ref(web)]);
    expect(stoppedWatching(before, setOrgWatched(before, 'acme', false), known)).toEqual([
      ref(api),
      ref(web),
      ref(infra),
    ]);
    expect(stoppedWatching(before, setRepoWatched(before, dotfiles, true), known)).toEqual([]);
  });

  it('includes repos of a whole org that are no longer listed but were seen before', () => {
    const gone = repo('acme', 'retired');
    const before: GitHubWatch = { orgs: [{ login: 'acme', except: [] }], repos: [] };
    const seen = knownRepos(access(), [ref(gone)]);
    expect(stoppedWatching(before, noWatch(), seen).map((r) => r.name)).toEqual([
      'api',
      'web',
      'infra',
      'retired',
    ]);
  });
});

describe('GitHub Items and their repos', () => {
  it('keys a GitHub Item by its repo’s node id first, so unwatching a repo finds its Items', () => {
    const id = githubExternalId(api.nodeId, 'pr/42');
    expect(id).toBe('R_acme_api:pr/42');
    expect(githubRepoOfExternalId(id)).toBe(api.nodeId);
    expect(githubRepoOfExternalId('no-repo')).toBeNull();
  });
});
