import {
  GITHUB_HEALTH_COMMITS,
  GITHUB_HEALTH_DAYS,
  type GitHubCatalog,
  type GitHubRepoHealth,
  type GitHubRepoRef,
  type GitHubWatch,
  githubRepoOfExternalId,
  isWatched,
  noWatch,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import { type Cadence, RateLimited, type SourceAdapter, type SyncRequest, type SyncWatch } from '../source';
import { connectGitHub, type GitHubClient, GitHubRefused, GraphQLTimeout, githubLimit } from './client';
import {
  NODES,
  OPEN_WORK,
  OPEN_WORK_PAGE,
  OPEN_WORK_SEARCHES,
  type OpenWorkSearch,
  REPOS,
  SEARCH,
  SEARCH_COUNT,
  SWEEP,
} from './graphql';
import {
  checkState,
  issueId,
  type LightNode,
  lightSearchData,
  nodesData,
  openWorkData,
  pullRequestId,
  type RepoNode,
  type RestRepo,
  reposData,
  restRepo,
  restTeam,
  type SearchNode,
  searchCountData,
  searchData,
  sweepData,
  toCommit,
  toIssueItem,
  toPullRequestItem,
  toReleaseItem,
  toReviewRequestItem,
} from './shapes';

/*
  GitHub as a Source (#114): pull requests, issues, review requests and releases from the repos the
  Account watches (Settings → GitHub, #113), every 15 minutes, as cheaply as GitHub allows. GitHub
  can't push to a desktop app, so Commander polls, gated by ETags (decision #5):

  - Open work, every sync: one light GraphQL request with four searches (the User's open pull
    requests, reviews asked of them directly and through their teams, issues assigned to them: ids and
    update times only, about a point), so open work and review requests stay exact; those new or
    changed since are fetched whole. A review request no longer asked (given or withdrawn) is
    tombstoned at the end of the sync, after its pull request is saved again where the searches below
    found it changed.
  - Gates, per watched owner: GET /orgs/{org}/repos?sort=pushed and GET /orgs/{org}/issues?filter=all
    (state=all, sort=updated) with If-None-Match; for personal repos, GET /user/repos?sort=pushed and
    each watched repo's issues. A 304 costs nothing, and all 304s end the owner's sync there.
  - When a gate changed: a GraphQL search over the owner's pull requests and issues updated since the
    cursor (split into smaller time windows while a window would pass GitHub's 1,000 results), kept
    only for watched repos; then batched GraphQL over the repos pushed to since (about 25 per query,
    halved on a timeout or 502) for their default branch's head commit and checks, its commits since,
    and releases.
  - First sync (of each owner, or after more repos are watched there): open pull requests and issues,
    those closed or merged in the last 30 days, and releases from the last 30 days.
  - Once a day, the open pull requests and issues held are looked up by node id: one GitHub deleted,
    or moved out of its repo, is tombstoned.
  - Limits: every request counts towards the sync's cost (REST requests charged, GraphQL points). The
    adapter leaves a reserve of each hourly limit for the User's other tools: with less than that left
    it stops before the next owner, and the next sync waits for the reset (RateLimited). Each sync
    spends at most about 400 points before leaving the rest of the owners to the next. GitHub's own
    refusals (403 or 429, primary or secondary) reject with RateLimited, honouring Retry-After.
  - A watched org or repo GitHub won't show any more (the app uninstalled, access ended) is skipped;
    its Items stay until the User unwatches it.

  Repo health (each watched repo's default branch, its head commit's check state and the last week's
  commits, reverts flagged) goes in the Account's catalog, updated for the repos queried.
*/

export const GITHUB_CADENCE: Cadence = { defaultMinutes: 15, choices: [15] };
export const GITHUB_HOURLY_LIMITS = { requests: 5_000, complexity: 5_000 };

export type GitHubBudget = {
  // Left for the User's other tools: below this, Commander stops until the limit resets.
  reservePoints: number;
  reserveRequests: number;
  // The most GraphQL points one sync spends before leaving the remaining owners to the next sync.
  pointsPerSync: number;
};
const DEFAULT_BUDGET: GitHubBudget = { reservePoints: 500, reserveRequests: 500, pointsPerSync: 400 };

export type GitHubSourceOptions = {
  // The REST API's base; read per sync, so the end-to-end tests can point it at a fake.
  apiUrl: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  budget?: Partial<GitHubBudget>;
};

const DAY_MS = 24 * 60 * 60_000;
const FIRST_SYNC_DAYS = 30;
// The next search starts a little before this one did, so a clock ahead of GitHub's misses nothing.
const CLOCK_MARGIN_MS = 5 * 60_000;
// GitHub's search gives at most 1,000 results per query; windows narrower than this aren't split.
const SEARCH_CAP = 1_000;
const MIN_WINDOW_MS = 60_000;
const PAGE_SIZE = 100;
const REPOS_PER_QUERY = 25;
// Searches over open work and created dates start here (GitHub opened in 2008).
const EPOCH = Date.UTC(2008, 0, 1);
const LIST_PAGES = 50;
// Pull requests and issues looked up per query in the daily sweep, and fetched whole per query.
const SWEEP_SIZE = 100;
const NODES_PER_QUERY = 25;

const scopeShape = z.object({ whole: z.boolean(), ids: z.array(z.string()) });
type Scope = z.infer<typeof scopeShape>;

const ownerCursor = z.object({
  kind: z.enum(['org', 'user']),
  reposEtag: z.string().nullable(),
  issuesEtag: z.string().nullable(),
  // false: GitHub won't list the org's issues to this User, so every sync searches it.
  issuesGate: z.boolean(),
  // The next search covers what was updated from here on.
  since: z.iso.datetime(),
  // What was watched there at the last first sync (or since): more watched means a first sync again.
  scope: scopeShape,
});
type OwnerCursor = z.infer<typeof ownerCursor>;

const githubCursor = z.object({
  version: z.literal(1),
  login: z.string().nullable(),
  owners: z.record(z.string(), ownerCursor),
  // The /user/repos gate, shared by every personal owner, and each watched personal repo's issues gate.
  personalEtag: z.string().nullable(),
  repoIssues: z.record(z.string(), z.string()),
  // Every repo listed, by node id: its last push, to tell which were pushed to since.
  repos: z.record(
    z.string(),
    z.object({ owner: z.string(), name: z.string(), pushedAt: z.string().nullable() }),
  ),
  // The User's teams ("org/slug", lower-case), and the ETag of GitHub's list; null when GitHub won't say.
  teams: z.object({ etag: z.string().nullable(), slugs: z.array(z.string()) }).nullable(),
  // When GitHub last refused to list them (a GitHub App's token may not read teams): asked again daily.
  teamsRefusedAt: z.number().nullable().default(null),
  // The review requests open after the last sync, by external id.
  reviewRequests: z.array(z.string()),
  // Open work as last listed: each pull request's or issue's node id → when it was last updated.
  openWork: z.record(z.string(), z.string()).default({}),
  // Open pull requests and issues held, by node id → external id, for the daily sweep.
  open: z.record(z.string(), z.string()),
  sweptAt: z.number().nullable(),
  limits: z.object({ rest: githubLimit.optional(), graphql: githubLimit.optional() }),
});
export type GitHubCursor = z.infer<typeof githubCursor>;

type Owner = { login: string; kind: 'org' | 'user' };

const iso = (time: number) => new Date(time).toISOString();
// Whole seconds, as GitHub's search qualifiers take them.
const searchTime = (time: number) => iso(time).replace(/\.\d{3}Z$/, 'Z');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : Date.parse(b) > Date.parse(a) ? b : a;

// The orgs and users whose repos the Account watches.
function ownersOf(watch: SyncWatch): Owner[] {
  const owners: Owner[] = [];
  const isOrg = (login: string) =>
    watch.selection.orgs.some((org) => same(org.login, login)) || watch.orgs.some((org) => same(org, login));
  const add = (login: string) => {
    if (!owners.some((each) => same(each.login, login)))
      owners.push({ login, kind: isOrg(login) ? 'org' : 'user' });
  };
  for (const org of watch.selection.orgs) add(org.login);
  for (const repo of watch.selection.repos) add(repo.owner);
  return owners;
}

// What is watched under one owner: the whole org less some repos, or single repos (node ids, sorted).
function scopeOf(selection: GitHubWatch, login: string): Scope {
  const whole = selection.orgs.find((org) => same(org.login, login));
  if (whole) return { whole: true, ids: whole.except.map((repo) => repo.nodeId).sort() };
  return {
    whole: false,
    ids: selection.repos
      .filter((repo) => same(repo.owner, login))
      .map((repo) => repo.nodeId)
      .sort(),
  };
}

// Whether everything watched now was already watched before (nothing new needs a first sync).
function covered(before: Scope, now: Scope): boolean {
  if (now.whole) return before.whole && before.ids.every((id) => now.ids.includes(id));
  if (before.whole) return now.ids.every((id) => !before.ids.includes(id));
  return now.ids.every((id) => before.ids.includes(id));
}

const freshCursor = (now: number): GitHubCursor => ({
  version: 1,
  login: null,
  owners: {},
  personalEtag: null,
  repoIssues: {},
  repos: {},
  teams: null,
  teamsRefusedAt: null,
  reviewRequests: [],
  openWork: {},
  open: {},
  sweptAt: now,
  limits: {},
});

// The order Items are handed over in: a review request after the pull request it is about.
const SAVE_ORDER: Record<string, number> = {
  'pull-request': 0,
  'github-issue': 1,
  'github-release': 2,
  'review-request': 3,
};

export function createGitHubSource({
  apiUrl,
  fetch = globalThis.fetch,
  now = Date.now,
  budget: budgetOverrides = {},
}: GitHubSourceOptions): SourceAdapter {
  const budget = { ...DEFAULT_BUDGET, ...budgetOverrides };

  return {
    source: 'github',
    cadence: GITHUB_CADENCE,
    hourlyLimits: GITHUB_HOURLY_LIMITS,

    async sync(request: SyncRequest) {
      const gh = connectGitHub({
        apiUrl: apiUrl(),
        fetch,
        now,
        accessToken: request.accessToken,
        signal: request.signal,
      });
      const started = now();
      const previous = githubCursor.safeParse(request.cursor);
      const cursor: GitHubCursor = previous.success ? structuredClone(previous.data) : freshCursor(started);
      const watch = request.watch ?? null;
      // Nothing chosen to watch yet: nothing to fetch.
      if (!watch) return { cursor, cost: gh.cost };
      const selection = watch.selection ?? noWatch();
      const watched = (repo: GitHubRepoRef) => isWatched(selection, repo);
      const nodeWatched = (node: SearchNode) =>
        watched({
          nodeId: node.repository.id,
          owner: node.repository.owner.login,
          name: node.repository.name,
        });

      // The limit GitHub last reported (this sync, else the last), and whether it is down to the reserve.
      const lowOn = () => {
        const graphql = gh.limits.graphql ?? cursor.limits.graphql;
        const rest = gh.limits.rest ?? cursor.limits.rest;
        const low = [
          graphql && graphql.remaining < budget.reservePoints ? graphql : null,
          rest && rest.remaining < budget.reserveRequests ? rest : null,
        ].filter((limit) => limit !== null && limit.resetAt > now());
        return low.length ? Math.max(...low.map((limit) => limit?.resetAt ?? 0)) : null;
      };
      const reset = lowOn();
      if (reset !== null) {
        throw new RateLimited(
          'Commander paused to leave GitHub’s hourly limit for your other tools.',
          Math.max(0, reset - now()),
          gh.cost,
        );
      }
      const canSpend = () => lowOn() === null && (gh.cost.complexity ?? 0) < budget.pointsPerSync;

      // Hands Items over, a review request after its pull request, noting open pull requests and issues
      // for the sweep (and tombstoning the old one of any that moved repo).
      function save(items: SourceItem[], deleted: string[] = []) {
        const gone = [...deleted];
        for (const item of items) {
          const detail = item.detail;
          if (detail?.kind !== 'pull-request' && detail?.kind !== 'github-issue') continue;
          const was = cursor.open[detail.nodeId];
          if (was && was !== item.externalId) gone.push(was);
          if (item.status === 'open') cursor.open[detail.nodeId] = item.externalId;
          else delete cursor.open[detail.nodeId];
        }
        if (items.length === 0 && gone.length === 0) return;
        const sorted = [...items].sort((a, b) => (SAVE_ORDER[a.kind] ?? 9) - (SAVE_ORDER[b.kind] ?? 9));
        request.save({ items: sorted, deleted: gone });
      }

      const toItem = (node: SearchNode) =>
        node.__typename === 'PullRequest' ? toPullRequestItem(node) : toIssueItem(node);

      // Every page of a search (at most GitHub's 1,000 results).
      async function searchPages(
        query: string,
        count: number,
        after: string | null = null,
      ): Promise<SearchNode[]> {
        const found: SearchNode[] = [];
        let next = after;
        do {
          const first = Math.max(1, Math.min(PAGE_SIZE, count - found.length));
          const data = await gh.graphql(SEARCH, 'CommanderSearch', { query, first, after: next }, searchData);
          found.push(...data.search.nodes);
          next = data.search.pageInfo?.hasNextPage ? (data.search.pageInfo.endCursor ?? null) : null;
        } while (next !== null && found.length < Math.min(SEARCH_CAP, count));
        return found;
      }

      // A search over a time window on `field` (null ends: open), split while it would pass 1,000.
      async function search(
        base: string,
        field: 'created' | 'closed' | 'updated',
        from: number | null,
        to: number | null,
      ): Promise<SearchNode[]> {
        const window =
          from === null && to === null
            ? ''
            : to === null
              ? ` ${field}:>=${searchTime(from ?? EPOCH)}`
              : ` ${field}:${searchTime(from ?? EPOCH)}..${searchTime(to)}`;
        const query = `${base}${window}`;
        const counted = await gh.graphql(SEARCH_COUNT, 'CommanderSearchCount', { query }, searchCountData);
        const count = counted.search.issueCount;
        if (count === 0) return [];
        const start = from ?? EPOCH;
        const end = to ?? started;
        if (count > SEARCH_CAP && end - start > MIN_WINDOW_MS) {
          const middle = start + Math.floor((end - start) / 2);
          return [
            ...(await search(base, field, start, middle)),
            ...(await search(base, field, middle + 1000, end)),
          ];
        }
        return searchPages(query, count);
      }

      // ------------------------------------------------------------------------------------------
      // The User's teams, for which team a review was asked through (free when unchanged).
      let myTeams: string[] | null = cursor.teams?.slugs ?? null;
      if (cursor.teamsRefusedAt === null || started - cursor.teamsRefusedAt >= DAY_MS) {
        try {
          const answer = await gh.rest('/user/teams?per_page=100', cursor.teams?.etag ?? null);
          cursor.teamsRefusedAt = null;
          if (answer.status === 200) {
            const teams = z.array(restTeam).catch([]).parse(answer.body);
            myTeams = teams.map((team) => `${team.organization.login}/${team.slug}`.toLowerCase());
            cursor.teams = { etag: answer.etag, slugs: myTeams };
          }
        } catch (error) {
          if (!(error instanceof GitHubRefused)) throw error;
          myTeams = null;
          cursor.teams = null;
          cursor.teamsRefusedAt = started;
        }
      }

      // Open work, exact every sync: listed lightly, and fetched whole only where new or changed.
      const work = await gh.graphql(OPEN_WORK, 'CommanderOpenWork', { first: PAGE_SIZE }, openWorkData);
      const me = work.viewer.login;
      cursor.login = me;
      const lightWatched = (node: LightNode) =>
        watched({
          nodeId: node.repository.id,
          owner: node.repository.owner.login,
          name: node.repository.name,
        });
      const externalIdOf = (node: LightNode) =>
        node.__typename === 'PullRequest'
          ? pullRequestId(node.repository.id, node.number)
          : issueId(node.repository.id, node.number);
      const listed = async (alias: OpenWorkSearch) => {
        const found = [...work[alias].nodes];
        let page = work[alias].pageInfo;
        while (page?.hasNextPage && page.endCursor && found.length < SEARCH_CAP) {
          const more = await gh.graphql(
            OPEN_WORK_PAGE,
            'CommanderOpenWorkPage',
            { query: OPEN_WORK_SEARCHES[alias], first: PAGE_SIZE, after: page.endCursor },
            lightSearchData,
          );
          found.push(...more.search.nodes);
          page = more.search.pageInfo;
        }
        return found.filter(lightWatched);
      };
      const lists = {
        mine: await listed('mine'),
        direct: await listed('direct'),
        team: await listed('team'),
        assigned: await listed('assigned'),
      };
      const open = new Map<string, LightNode>();
      for (const node of [...lists.mine, ...lists.direct, ...lists.team, ...lists.assigned])
        open.set(node.id, node);
      // What Commander holds of them already, and which are new or changed since.
      const held = new Map<string, SourceItem>();
      for (const item of request.stored?.([...open.values()].map(externalIdOf)) ?? []) {
        if (item.detail?.kind === 'pull-request' || item.detail?.kind === 'github-issue')
          held.set(item.externalId, { ...item, kind: item.detail.kind });
      }
      const stale = [...open.values()].filter(
        (node) => cursor.openWork[node.id] !== node.updatedAt || !held.has(externalIdOf(node)),
      );
      const fetched: SourceItem[] = [];
      for (let i = 0; i < stale.length; i += NODES_PER_QUERY) {
        const ids = stale.slice(i, i + NODES_PER_QUERY).map((node) => node.id);
        const data = await gh.graphql(NODES, 'CommanderNodes', { ids }, nodesData, { allowNotFound: true });
        for (const node of data.nodes.filter(nodeWatched)) {
          const item = toItem(node);
          fetched.push(item);
          held.set(item.externalId, item);
        }
      }
      const directIds = new Set(lists.direct.map(externalIdOf));
      const teamIds = new Set(lists.team.map(externalIdOf));
      const requests: SourceItem[] = [];
      for (const externalId of new Set([...directIds, ...teamIds])) {
        const pull = held.get(externalId);
        if (pull?.detail?.kind !== 'pull-request') continue;
        const asked = pull.detail.requestedReviewers.flatMap((each) =>
          each.kind === 'team' ? [each.team] : [],
        );
        const theirs = myTeams ? asked.filter((each) => myTeams?.includes(each.toLowerCase())) : asked;
        const teams = teamIds.has(externalId) ? (theirs.length ? theirs : asked) : [];
        const item = toReviewRequestItem(pull, directIds.has(externalId), teams, me);
        if (item) requests.push(item);
      }
      const asking = new Set(requests.map((item) => item.externalId));
      save([...fetched, ...requests]);
      // Review requests no longer asked are tombstoned at the end, once the searches below have saved
      // their pull requests as they are now (so a review given can be told from a request withdrawn).
      const ended = cursor.reviewRequests.filter((externalId) => !asking.has(externalId));
      cursor.reviewRequests = [...asking];
      cursor.openWork = Object.fromEntries([...open.values()].map((node) => [node.id, node.updatedAt]));

      // The daily sweep: open pull requests and issues GitHub deleted, or moved to another repo.
      if ((cursor.sweptAt === null || started - cursor.sweptAt >= DAY_MS) && canSpend()) {
        const entries = Object.entries(cursor.open);
        const deleted: string[] = [];
        for (let i = 0; i < entries.length; i += SWEEP_SIZE) {
          const chunk = entries.slice(i, i + SWEEP_SIZE);
          const repoIds = [
            ...new Set(chunk.map(([, externalId]) => githubRepoOfExternalId(externalId) ?? '')),
          ];
          const data = await gh.graphql(
            SWEEP,
            'CommanderSweep',
            { ids: chunk.map(([nodeId]) => nodeId), repos: repoIds },
            sweepData,
            { allowNotFound: true },
          );
          const reachable = new Set(data.repos.flatMap((repo) => (repo?.id ? [repo.id] : [])));
          chunk.forEach(([nodeId, externalId], index) => {
            const node = data.items[index];
            const repo = githubRepoOfExternalId(externalId);
            const gone = !node?.id ? repo !== null && reachable.has(repo) : node.repository?.id !== repo;
            if (gone) {
              deleted.push(externalId);
              delete cursor.open[nodeId];
            }
          });
        }
        save([], deleted);
        cursor.sweptAt = started;
      }

      // ------------------------------------------------------------------------------------------
      // Gates, searches and repo health, owner by owner, within the budget.
      const owners = ownersOf(watch);
      const health = new Map<string, GitHubRepoHealth>(
        (request.catalog?.kind === 'github' ? request.catalog.repos : []).map((repo) => [
          repo.repo.nodeId,
          repo,
        ]),
      );
      const unsettled = (nodeId: string) => {
        const checks = health.get(nodeId)?.head?.checks;
        return checks === 'pending' || checks === 'expected';
      };

      // Every page of a repo list, from the first (already fetched); `enough` stops paging early.
      async function listRepos(path: string, firstPage: unknown, enough: (page: RestRepo[]) => boolean) {
        const repos: RestRepo[] = [];
        let page = z.array(restRepo).catch([]).parse(firstPage);
        for (let number = 1; ; number++) {
          repos.push(...page);
          if (page.length < PAGE_SIZE || enough(page) || number >= LIST_PAGES) break;
          const answer = await gh.rest(`${path}&page=${number + 1}`);
          page = answer.status === 200 ? z.array(restRepo).catch([]).parse(answer.body) : [];
        }
        return repos;
      }

      // Notes each listed repo's last push; returns the watched ones pushed to since last noted.
      function pushedSince(listed: RestRepo[]): RestRepo[] {
        const pushed: RestRepo[] = [];
        for (const repo of listed) {
          const ref = { nodeId: repo.node_id, owner: repo.owner.login, name: repo.name };
          const before = cursor.repos[repo.node_id]?.pushedAt ?? null;
          if (!repo.archived && watched(ref) && (before === null || later(before, repo.pushed_at) !== before))
            pushed.push(repo);
          cursor.repos[repo.node_id] = { owner: ref.owner, name: ref.name, pushedAt: repo.pushed_at };
        }
        return pushed;
      }

      // Each repo's default branch and its checks and commits since, and releases since: in batches of
      // about 25, halved when GitHub times out.
      async function queryRepos(nodeIds: string[], commitsSince: number, releasesSince: number) {
        let size = REPOS_PER_QUERY;
        const releases: SourceItem[] = [];
        for (let i = 0; i < nodeIds.length; ) {
          const batch = nodeIds.slice(i, i + size);
          let data: z.infer<typeof reposData>;
          try {
            data = await gh.graphql(
              REPOS,
              'CommanderRepos',
              { ids: batch, since: iso(commitsSince) },
              reposData,
              {
                allowNotFound: true,
              },
            );
          } catch (error) {
            if (error instanceof GraphQLTimeout && size > 1) {
              size = Math.max(1, Math.floor(size / 2));
              continue;
            }
            throw error;
          }
          for (const repo of data.nodes) {
            if (!repo) continue;
            health.set(repo.id, healthOf(repo, health.get(repo.id) ?? null, started));
            const ref = { nodeId: repo.id, owner: repo.owner.login, name: repo.name };
            for (const release of repo.releases) {
              const published = release.publishedAt ? Date.parse(release.publishedAt) : null;
              if (!release.isDraft && published !== null && published >= releasesSince)
                releases.push(toReleaseItem(ref, release));
            }
          }
          i += batch.length;
        }
        save(releases);
      }

      // The personal repos gate, shared by every personal owner (fetched once, when one is reached).
      let personal: { changed: boolean; listed: RestRepo[] | null } | null = null;
      async function personalGate(first: boolean) {
        if (personal && !first) return personal;
        const path = '/user/repos?sort=pushed&affiliation=owner,collaborator&per_page=100';
        const answer = await gh.rest(path, first ? null : cursor.personalEtag);
        if (answer.status === 304) {
          personal = personal ?? { changed: false, listed: null };
          return personal;
        }
        cursor.personalEtag = answer.etag;
        const sinceAll = Math.min(
          ...Object.values(cursor.owners).map((each) => Date.parse(each.since)),
          started,
        );
        const listed = await listRepos(path, answer.body, (page) =>
          first ? false : page.every((repo) => !repo.pushed_at || Date.parse(repo.pushed_at) < sinceAll),
        );
        personal = { changed: true, listed };
        return personal;
      }

      async function syncOwner(owner: Owner) {
        const key = owner.login.toLowerCase();
        const before: OwnerCursor | undefined = cursor.owners[key];
        const scope = scopeOf(selection, owner.login);
        const first = !before || before.kind !== owner.kind || !covered(before.scope, scope);
        const since = first ? null : Date.parse(before.since);
        const name = encodeURIComponent(owner.login);
        let reposEtag = first ? null : before.reposEtag;
        let issuesEtag = first ? null : before.issuesEtag;
        let issuesGate = first ? true : before.issuesGate;
        let changed = first;
        let listed: RestRepo[] | null = null;

        if (owner.kind === 'org') {
          const path = `/orgs/${name}/repos?sort=pushed&per_page=100`;
          let answer: Awaited<ReturnType<GitHubClient['rest']>>;
          try {
            answer = await gh.rest(path, reposEtag);
          } catch (error) {
            // Out of reach (the app uninstalled, access ended): skipped, its Items kept.
            if (error instanceof GitHubRefused) return;
            throw error;
          }
          if (answer.status === 200) {
            changed = true;
            reposEtag = answer.etag;
            listed = await listRepos(path, answer.body, (page) =>
              first || since === null
                ? false
                : page.every((repo) => !repo.pushed_at || Date.parse(repo.pushed_at) < since),
            );
          }
          if (issuesGate) {
            try {
              const issues = await gh.rest(
                `/orgs/${name}/issues?filter=all&state=all&sort=updated&per_page=1`,
                issuesEtag,
              );
              if (issues.status === 200) {
                changed = true;
                issuesEtag = issues.etag;
              }
            } catch (error) {
              if (!(error instanceof GitHubRefused)) throw error;
              issuesGate = false;
              issuesEtag = null;
            }
          }
          // Without the issues gate, every sync searches.
          if (!issuesGate) changed = true;
        } else {
          const gate = await personalGate(first);
          if (gate.changed) changed = true;
          listed = gate.listed?.filter((repo) => same(repo.owner.login, owner.login)) ?? null;
          for (const ref of selection.repos.filter((repo) => same(repo.owner, owner.login))) {
            const known = cursor.repos[ref.nodeId] ?? ref;
            try {
              const path = `/repos/${encodeURIComponent(known.owner)}/${encodeURIComponent(known.name)}/issues?state=all&sort=updated&per_page=1`;
              const issues = await gh.rest(path, first ? null : (cursor.repoIssues[ref.nodeId] ?? null));
              if (issues.status === 200) {
                changed = true;
                if (issues.etag) cursor.repoIssues[ref.nodeId] = issues.etag;
              }
            } catch (error) {
              if (!(error instanceof GitHubRefused)) throw error;
            }
          }
        }

        const qualifier = `${owner.kind === 'org' ? 'org' : 'user'}:${owner.login}`;
        if (changed) {
          const found = first
            ? [
                ...(await search(`${qualifier} is:open`, 'created', null, null)),
                ...(await search(
                  `${qualifier} is:closed`,
                  'closed',
                  started - FIRST_SYNC_DAYS * DAY_MS,
                  null,
                )),
              ]
            : await search(qualifier, 'updated', since, null);
          save(found.filter(nodeWatched).map(toItem));
        }

        const pushed = listed ? pushedSince(listed) : [];
        const ofOwner = (nodeId: string) => {
          const repo = cursor.repos[nodeId];
          return repo !== undefined && same(repo.owner, owner.login);
        };
        const recheck = [...health.keys()].filter((nodeId) => ofOwner(nodeId) && unsettled(nodeId));
        const toQuery = [...new Set([...pushed.map((repo) => repo.node_id), ...recheck])];
        if (toQuery.length) {
          const commitsSince = first || since === null ? started - GITHUB_HEALTH_DAYS * DAY_MS : since;
          const releasesSince = first || since === null ? started - FIRST_SYNC_DAYS * DAY_MS : since;
          await queryRepos(toQuery, commitsSince, releasesSince);
        }

        cursor.owners[key] = {
          kind: owner.kind,
          reposEtag,
          issuesEtag,
          issuesGate,
          since: changed ? iso(started - CLOCK_MARGIN_MS) : (before?.since ?? iso(started - CLOCK_MARGIN_MS)),
          scope,
        };
      }

      const keep = new Set(owners.map((owner) => owner.login.toLowerCase()));
      for (const key of Object.keys(cursor.owners)) if (!keep.has(key)) delete cursor.owners[key];
      for (const owner of owners) {
        if (!canSpend()) break;
        await syncOwner(owner);
      }
      save([], ended);

      // Repo health: watched repos only, the last week of commits.
      const catalog: GitHubCatalog = {
        kind: 'github',
        repos: [...health.values()]
          .filter((each) => watched(each.repo))
          .map((each) => ({ ...each, commits: recent(each.commits, started) }))
          .sort((a, b) => `${a.repo.owner}/${a.repo.name}`.localeCompare(`${b.repo.owner}/${b.repo.name}`)),
      };
      request.saveCatalog?.(catalog);

      cursor.limits = {
        ...((gh.limits.rest ?? cursor.limits.rest) ? { rest: gh.limits.rest ?? cursor.limits.rest } : {}),
        ...((gh.limits.graphql ?? cursor.limits.graphql)
          ? { graphql: gh.limits.graphql ?? cursor.limits.graphql }
          : {}),
      };
      return { cursor, cost: gh.cost };
    },
  };
}

// The last week's commits, newest first, at most GITHUB_HEALTH_COMMITS.
function recent(commits: GitHubRepoHealth['commits'], now: number) {
  return commits
    .filter((commit) => commit.committedAt >= now - GITHUB_HEALTH_DAYS * DAY_MS)
    .sort((a, b) => b.committedAt - a.committedAt)
    .slice(0, GITHUB_HEALTH_COMMITS);
}

// A repo's health from GitHub's answer, keeping commits seen before.
function healthOf(node: RepoNode, before: GitHubRepoHealth | null, now: number): GitHubRepoHealth {
  const branch = node.defaultBranchRef;
  const head = branch?.target ?? null;
  const fresh = (head?.history ?? []).map(toCommit);
  const seen = new Set(fresh.map((commit) => commit.oid));
  return {
    repo: { nodeId: node.id, owner: node.owner.login, name: node.name },
    defaultBranch: branch?.name ?? null,
    head: head
      ? {
          oid: head.oid,
          checks: checkState(head.statusCheckRollup),
          committedAt: Date.parse(head.committedDate),
        }
      : null,
    commits: recent([...fresh, ...(before?.commits ?? []).filter((commit) => !seen.has(commit.oid))], now),
    checkedAt: now,
  };
}
