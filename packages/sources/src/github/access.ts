import type { GitHubAccess, GitHubOrgAccess, GitHubRepo } from '@commander/domain';
import { z } from 'zod';
import { type AccessToken, RateLimited, retryAfterMs, SignInRefused, SourceUnavailable } from '../source';

/*
  What a GitHub Account can reach (#113), for Settings → GitHub and for GitHub sync (#114).

  - With Commander's GitHub App (an OAuth user token): the app's installations the User can see
    (GET /user/installations) and each one's repos (GET /user/installations/{id}/repositories), so
    only repos the install covers and the User can access appear. Orgs the User belongs to without
    the app come from GET /user/memberships/orgs, which may refuse an app's token, and from the
    User's public memberships (GET /users/{login}/orgs), which any token may read; they are listed
    as not installed, with no repos.
  - With a classic token or gh's sign-in: the User's orgs (GET /user/orgs), their repos (GET
    /user/repos) and each org's repos (GET /orgs/{org}/repos).
  - Orgs the User added by name are looked up (GET /orgs/{org}) and listed too.

  Archived repos never appear. Errors are the Source errors the sync engine knows: a refused token is
  SignInRefused, a rate limit RateLimited, anything else SourceUnavailable. Nothing here keeps the
  token; every request carries it as "Bearer <token>".
*/

export type GitHubApiOptions = {
  // The REST API's base, like https://api.github.com (GraphQL is <apiUrl>/graphql).
  apiUrl: string;
  token: AccessToken;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  signal?: AbortSignal;
};

const PER_PAGE = 100;
// A stop in case GitHub keeps answering: 5,000 of anything.
const MAX_PAGES = 50;
const WORKED_DAYS = 90;

const restRepo = z.object({
  node_id: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1), id: z.number().int().positive().optional(), type: z.string() }),
  private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  archived: z.boolean().default(false),
  pushed_at: z.string().nullable().optional(),
});
type RestRepo = z.infer<typeof restRepo>;

const restOrg = z.object({ login: z.string().min(1), id: z.number().int().positive() });
const installation = z.object({
  id: z.number().int().positive(),
  account: z
    .object({ login: z.string().min(1), id: z.number().int().positive().optional(), type: z.string() })
    .nullable(),
});
const membership = z.object({ state: z.string().optional(), organization: restOrg });

// GitHub answered, but not with a success: passing, as far as the sync engine is concerned.
// `said` is GitHub's own message.
class Refused extends SourceUnavailable {
  constructor(
    readonly status: number,
    readonly said: string,
  ) {
    super(`GitHub couldn’t answer just now (${said}).`);
  }
}

function connect({ apiUrl, token, fetch = globalThis.fetch, now = Date.now, signal }: GitHubApiOptions) {
  const headers = {
    authorization: `Bearer ${token.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Commander',
  };

  async function send(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach GitHub.');
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return body;
    const said = (body as { message?: unknown } | null)?.message;
    const message = typeof said === 'string' ? said : `HTTP ${response.status}`;
    if (response.status === 401) throw new SignInRefused(`GitHub refused the sign-in: ${message}`);
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter !== null))) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const wait =
        retryAfterMs(retryAfter, now()) ??
        (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now()) : null);
      throw new RateLimited('GitHub asked Commander to slow down.', wait);
    }
    throw new Refused(response.status, message);
  }

  // Every page of a list, until a short page. `pick` finds the list in GitHub's answer.
  async function all<T>(path: string, item: z.ZodType<T>, pick: (body: unknown) => unknown = (b) => b) {
    const found: T[] = [];
    const joiner = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await send(`${path}${joiner}per_page=${PER_PAGE}&page=${page}`);
      const parsed = z.array(item).safeParse(pick(body));
      if (!parsed.success) throw new SourceUnavailable('GitHub answered in a way Commander didn’t expect.');
      found.push(...parsed.data);
      if (parsed.data.length < PER_PAGE) break;
    }
    return found;
  }

  return { send, all };
}

type Api = ReturnType<typeof connect>;

const passing = (error: unknown) =>
  error instanceof SignInRefused || error instanceof RateLimited || (error as Error)?.name === 'AbortError';

function toRepo(repo: RestRepo): GitHubRepo {
  const pushed = repo.pushed_at ? Date.parse(repo.pushed_at) : Number.NaN;
  return {
    nodeId: repo.node_id,
    owner: repo.owner.login,
    name: repo.name,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    pushedAt: Number.isFinite(pushed) ? pushed : null,
  };
}

// Newest push first, empty repos last; unarchived only; each repo once.
function tidy(repos: RestRepo[]): GitHubRepo[] {
  const seen = new Set<string>();
  return repos
    .filter((repo) => !repo.archived && !seen.has(repo.node_id) && seen.add(repo.node_id))
    .map(toRepo)
    .sort((a, b) => (b.pushedAt ?? -1) - (a.pushedAt ?? -1));
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const org = (
  login: string,
  id: number | null,
  reach: GitHubOrgAccess['reach'],
  repos: GitHubRepo[] = [],
): GitHubOrgAccess => ({ login, id, reach, repos, addedByName: false, problem: null });

async function readLogin(api: Api): Promise<string> {
  const parsed = z.object({ login: z.string().min(1) }).safeParse(await api.send('/user'));
  if (!parsed.success) throw new SourceUnavailable('GitHub didn’t say who is signed in.');
  return parsed.data.login;
}

// The orgs the User belongs to, as far as this token may be told: their memberships, where GitHub
// lists them for the token, and their public memberships, which anyone may read.
async function readMemberships(api: Api, login: string): Promise<{ login: string; id: number }[]> {
  const found: { login: string; id: number }[] = [];
  const add = (each: { login: string; id: number }) => {
    if (!found.some((known) => same(known.login, each.login))) found.push(each);
  };
  try {
    const memberships = await api.all('/user/memberships/orgs?state=active', membership);
    for (const each of memberships) if (each.state !== 'pending') add(each.organization);
  } catch (error) {
    if (passing(error)) throw error;
  }
  try {
    for (const each of await api.all(`/users/${encodeURIComponent(login)}/orgs`, restOrg)) add(each);
  } catch (error) {
    if (passing(error)) throw error;
  }
  return found;
}

async function readThroughApp(api: Api, login: string): Promise<Pick<GitHubAccess, 'orgs' | 'personal'>> {
  const installations = await api.all(
    '/user/installations',
    installation,
    (body) => (body as { installations?: unknown })?.installations,
  );
  const orgs: GitHubOrgAccess[] = [];
  const personal: RestRepo[] = [];
  for (const { id, account } of installations) {
    if (!account) continue;
    const repos = await api.all(
      `/user/installations/${id}/repositories`,
      restRepo,
      (body) => (body as { repositories?: unknown })?.repositories,
    );
    if (account.type === 'Organization')
      orgs.push(org(account.login, account.id ?? null, 'installed', tidy(repos)));
    else personal.push(...repos);
  }
  for (const each of await readMemberships(api, login))
    if (!orgs.some((known) => same(known.login, each.login)))
      orgs.push(org(each.login, each.id, 'not-installed'));
  return { orgs, personal: tidy(personal) };
}

// An org's repos for a token Account, or why they can't be listed (SAML SSO, an OAuth app policy).
async function orgRepos(api: Api, entry: GitHubOrgAccess, already: RestRepo[]): Promise<GitHubOrgAccess> {
  try {
    const repos = await api.all(
      `/orgs/${encodeURIComponent(entry.login)}/repos?type=all&sort=pushed`,
      restRepo,
    );
    return { ...entry, repos: tidy([...repos, ...already]) };
  } catch (error) {
    if (passing(error) || !(error instanceof Refused)) throw error;
    return { ...entry, repos: tidy(already), problem: `GitHub wouldn’t list its repos: ${error.said}` };
  }
}

async function readThroughToken(api: Api): Promise<Pick<GitHubAccess, 'orgs' | 'personal'>> {
  const memberOf = await api.all('/user/orgs', restOrg);
  const repos = await api.all(
    `/user/repos?affiliation=${encodeURIComponent('owner,collaborator,organization_member')}&sort=pushed`,
    restRepo,
  );
  const owners: GitHubOrgAccess[] = memberOf.map((each) => org(each.login, each.id, 'token'));
  // Orgs the User reaches repos in without being a member (an outside collaborator).
  for (const repo of repos) {
    if (repo.owner.type !== 'Organization' || owners.some((known) => same(known.login, repo.owner.login)))
      continue;
    owners.push(org(repo.owner.login, repo.owner.id ?? null, 'token'));
  }
  const orgs: GitHubOrgAccess[] = [];
  for (const entry of owners) {
    const theirs = repos.filter((repo) => same(repo.owner.login, entry.login));
    const member = memberOf.some((each) => same(each.login, entry.login));
    orgs.push(member ? await orgRepos(api, entry, theirs) : { ...entry, repos: tidy(theirs) });
  }
  return { orgs, personal: tidy(repos.filter((repo) => repo.owner.type !== 'Organization')) };
}

// An organization by its login, or null when GitHub has none by that name.
export async function readGitHubOrg(
  options: GitHubApiOptions,
  login: string,
): Promise<{ login: string; id: number } | null> {
  const api = connect(options);
  try {
    const parsed = restOrg.safeParse(await api.send(`/orgs/${encodeURIComponent(login)}`));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Refused && error.status === 404) return null;
    throw error;
  }
}

export async function readGitHubAccess(
  options: GitHubApiOptions & { addedOrgs?: readonly string[] },
): Promise<GitHubAccess> {
  const api = connect(options);
  const now = options.now ?? Date.now;
  const via = options.token.kind === 'oauth' ? 'app' : 'token';
  const login = await readLogin(api);
  const { orgs, personal } = via === 'app' ? await readThroughApp(api, login) : await readThroughToken(api);
  for (const name of options.addedOrgs ?? []) {
    if (orgs.some((known) => same(known.login, name))) continue;
    const found = await readGitHubOrg(options, name);
    if (!found || orgs.some((known) => same(known.login, found.login))) continue;
    const entry = {
      ...org(found.login, found.id, via === 'app' ? 'not-installed' : 'token'),
      addedByName: true,
    };
    orgs.push(via === 'app' ? entry : await orgRepos(api, entry, []));
  }
  return { via, login, orgs, personal, fetchedAt: now() };
}

const WORKED_IN = `query CommanderWorkedIn($from: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from) {
      commitContributionsByRepository(maxRepositories: 100) { repository { id nameWithOwner } }
      pullRequestContributionsByRepository(maxRepositories: 100) { repository { id nameWithOwner } }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { id nameWithOwner } }
    }
  }
}`;

const byRepository = z.array(z.object({ repository: z.object({ id: z.string().min(1) }) })).default([]);
const workedAnswer = z.object({
  data: z.object({
    viewer: z.object({
      contributionsCollection: z.object({
        commitContributionsByRepository: byRepository,
        pullRequestContributionsByRepository: byRepository,
        pullRequestReviewContributionsByRepository: byRepository,
      }),
    }),
  }),
});

// The node ids of the repos the User pushed to, opened pull requests in or reviewed in the last 90
// days: one GraphQL query over their contributions, by repository.
export async function readWorkedRepos(options: GitHubApiOptions): Promise<string[]> {
  const api = connect(options);
  const now = options.now ?? Date.now;
  const from = new Date(now() - WORKED_DAYS * 86_400_000).toISOString();
  const body = await api.send('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: WORKED_IN, operationName: 'CommanderWorkedIn', variables: { from } }),
  });
  const parsed = workedAnswer.safeParse(body);
  if (!parsed.success) throw new SourceUnavailable('GitHub couldn’t say which repos you worked in.');
  const collection = parsed.data.data.viewer.contributionsCollection;
  const ids = [
    ...collection.commitContributionsByRepository,
    ...collection.pullRequestContributionsByRepository,
    ...collection.pullRequestReviewContributionsByRepository,
  ].map((each) => each.repository.id);
  return [...new Set(ids)];
}
