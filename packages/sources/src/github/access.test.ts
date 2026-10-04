import { describe, expect, it } from 'vitest';
import { type AccessToken, RateLimited, SignInRefused, SourceUnavailable } from '../source';
import { readGitHubAccess, readGitHubOrg, readWorkedRepos } from './access';
import appAccess from './recorded/app-access.json';
import contributions from './recorded/contributions.json';
import tokenAccess from './recorded/token-access.json';

// What a GitHub Account can reach, against recorded REST and GraphQL answers (shaped as GitHub
// answers them): a GitHub App user token goes through the app's installations; a classic token (or
// gh's) through the User's own lists. Archived repos never appear.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };

const API = 'https://api.github.test';
const NOW = Date.UTC(2026, 9, 3, 12);
const appToken: AccessToken = { token: 'ghu_recorded', kind: 'oauth' };
const classic: AccessToken = { token: 'ghp_recorded', kind: 'api-key' };

// Answers each GET by its path and query; every other request fails the test.
function replay(recorded: Record<string, Recorded>) {
  const asked: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
    asked.push(key);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer gh[up]_recorded$/);
    expect(headers.get('user-agent')).toBe('Commander');
    const answer = recorded[key];
    if (!answer) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, asked };
}

const names = (repos: { owner: string; name: string }[]) => repos.map((r) => `${r.owner}/${r.name}`);

describe('with the GitHub App', () => {
  it('lists each installation’s repos, orgs apart from personal ones, newest push first', async () => {
    const github = replay(appAccess as Record<string, Recorded>);
    const access = await readGitHubAccess({
      apiUrl: API,
      token: appToken,
      fetch: github.fetch,
      now: () => NOW,
    });

    expect(access.via).toBe('app');
    expect(access.login).toBe('octocat');
    expect(access.fetchedAt).toBe(NOW);
    const acme = access.orgs.find((org) => org.login === 'acme');
    expect(acme).toMatchObject({ id: 501, reach: 'installed', addedByName: false, problem: null });
    // The archived old-site is left out.
    expect(names(acme?.repos ?? [])).toEqual(['acme/api', 'acme/web', 'acme/handbook']);
    expect(acme?.repos[0]).toEqual({
      nodeId: 'R_kgDOAcmeApi',
      owner: 'acme',
      name: 'api',
      visibility: 'private',
      pushedAt: Date.parse('2026-10-02T16:20:00Z'),
    });
    expect(acme?.repos[2]?.visibility).toBe('internal');
    expect(names(access.personal)).toEqual(['octocat/dotfiles', 'octocat/empty']);
    expect(access.personal[1]?.pushedAt).toBeNull();
  });

  it('shows orgs the User belongs to without the app as not installed, from their public memberships when GitHub won’t list them', async () => {
    const github = replay(appAccess as Record<string, Recorded>);
    const access = await readGitHubAccess({
      apiUrl: API,
      token: appToken,
      fetch: github.fetch,
      now: () => NOW,
    });

    // /user/memberships/orgs answered 403 to the app's token; /users/octocat/orgs still told.
    expect(github.asked).toContain('GET /user/memberships/orgs?state=active&per_page=100&page=1');
    expect(access.orgs.map((org) => [org.login, org.reach])).toEqual([
      ['acme', 'installed'],
      ['initech', 'not-installed'],
    ]);
    expect(access.orgs[1]).toMatchObject({ id: 502, repos: [], addedByName: false });
  });

  it('adds orgs named by the User that GitHub’s lists didn’t show', async () => {
    const github = replay({
      ...(appAccess as Record<string, Recorded>),
      'GET /orgs/globex': {
        status: 200,
        headers: {},
        body: { login: 'Globex', id: 503, type: 'Organization' },
      },
    });
    const access = await readGitHubAccess({
      apiUrl: API,
      token: appToken,
      fetch: github.fetch,
      now: () => NOW,
      addedOrgs: ['globex', 'acme', 'no-such-org'],
    });
    expect(access.orgs.map((org) => [org.login, org.reach, org.addedByName])).toEqual([
      ['acme', 'installed', false],
      ['initech', 'not-installed', false],
      ['Globex', 'not-installed', true],
    ]);
  });
});

describe('with a classic token or gh’s sign-in', () => {
  it('lists the User’s orgs with each org’s repos, and their personal repos, from their own lists', async () => {
    const github = replay(tokenAccess as Record<string, Recorded>);
    const access = await readGitHubAccess({
      apiUrl: API,
      token: classic,
      fetch: github.fetch,
      now: () => NOW,
    });

    expect(access.via).toBe('token');
    expect(access.orgs.map((org) => [org.login, org.reach])).toEqual([
      ['acme', 'token'],
      ['initech', 'token'],
      // An org the User only collaborates in (not a member), from their repos.
      ['hooli', 'token'],
    ]);
    expect(names(access.orgs[0]?.repos ?? [])).toEqual(['acme/api', 'acme/web', 'acme/handbook']);
    expect(names(access.orgs[2]?.repos ?? [])).toEqual(['hooli/contrib']);
    // Archived 2019-talk is left out.
    expect(names(access.personal)).toEqual(['octocat/dotfiles', 'octocat/empty']);
  });

  it('says why an org’s repos couldn’t be listed, in GitHub’s words, and lists the rest', async () => {
    const github = replay(tokenAccess as Record<string, Recorded>);
    const access = await readGitHubAccess({
      apiUrl: API,
      token: classic,
      fetch: github.fetch,
      now: () => NOW,
    });
    const initech = access.orgs.find((org) => org.login === 'initech');
    expect(initech?.repos).toEqual([]);
    expect(initech?.problem).toMatch(/SAML/);
  });
});

describe('the repos the User worked in', () => {
  it('asks once, for commits, pull requests and reviews over the last 90 days, by repository', async () => {
    let sent: { query: string; operationName: string; variables: unknown } | null = null;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${API}/graphql`);
      sent = JSON.parse(String(init?.body));
      const { status, headers, body } = contributions.response;
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof globalThis.fetch;

    const worked = await readWorkedRepos({ apiUrl: API, token: appToken, fetch, now: () => NOW });

    expect(sent).toMatchObject(contributions.request);
    const query = (sent as unknown as { query: string }).query;
    for (const field of [
      'commitContributionsByRepository',
      'pullRequestContributionsByRepository',
      'pullRequestReviewContributionsByRepository',
    ])
      expect(query).toContain(field);
    expect(worked).toEqual(['R_kgDOAcmeApi', 'R_kgDOOctoDotfiles', 'R_kgDOHooliContrib', 'R_kgDOAcmeWeb']);
  });
});

describe('when GitHub says no', () => {
  const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () =>
      new Response(JSON.stringify(body), { status, headers })) as unknown as typeof globalThis.fetch;

  it('a refused token is a refused sign-in', async () => {
    await expect(
      readGitHubAccess({
        apiUrl: API,
        token: classic,
        fetch: answering(401, { message: 'Bad credentials' }),
      }),
    ).rejects.toBeInstanceOf(SignInRefused);
  });

  it('a rate limit says how long to wait', async () => {
    const reset = String(Math.floor(NOW / 1000) + 120);
    const error = await readGitHubAccess({
      apiUrl: API,
      token: classic,
      now: () => NOW,
      fetch: answering(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      ),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(120_000);
  });

  it('anything else is passing, and so is no answer at all', async () => {
    await expect(
      readGitHubAccess({ apiUrl: API, token: classic, fetch: answering(502, { message: 'Bad Gateway' }) }),
    ).rejects.toBeInstanceOf(SourceUnavailable);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(readGitHubAccess({ apiUrl: API, token: classic, fetch: offline })).rejects.toThrow(
      'Commander couldn’t reach GitHub.',
    );
  });

  it('an org that doesn’t exist is null', async () => {
    expect(
      await readGitHubOrg(
        { apiUrl: API, token: classic, fetch: answering(404, { message: 'Not Found' }) },
        'nope',
      ),
    ).toBeNull();
  });
});
