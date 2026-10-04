import type { GitHubCatalog, GitHubWatch, SourceItem } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type AccessToken, RateLimited, SignInRefused, type SyncPage, type SyncWatch } from '../source';
import { createGitHubSource, type GitHubBudget, type GitHubCursor } from './github-source';
import answers from './recorded/sync-answers.json';
import changed from './recorded/sync-changed.json';
import firstSync from './recorded/sync-first-sync.json';
import unchanged from './recorded/sync-unchanged.json';

// The GitHub adapter against recorded REST and GraphQL answers (shaped as GitHub answers them). Each
// recording also pins down the request Commander must send for it: the path and the ETag it sends,
// or the GraphQL operation and its variables.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = {
  request: {
    method: 'GET' | 'POST';
    path: string;
    etag?: string | null;
    operationName?: string;
    variables?: Record<string, unknown>;
  };
  response: Recorded;
};
type Sent = {
  method: string;
  path: string;
  etag: string | null;
  operationName?: string;
  variables?: unknown;
};

const API = 'https://api.github.test';
const NOW = Date.UTC(2026, 9, 3, 12);
const LATER = NOW + 15 * 60_000;
const token: AccessToken = { token: 'ghu_recorded', kind: 'oauth' };
const recorded = answers as unknown as Record<string, Recorded>;

const API_REPO = { nodeId: 'R_kgDOAcmeApi', owner: 'acme', name: 'api' };
const DOTFILES = { nodeId: 'R_kgDOOctoDotfiles', owner: 'octocat', name: 'dotfiles' };
// acme watched whole; octocat/dotfiles on its own.
const WATCH: SyncWatch = {
  selection: { orgs: [{ login: 'acme', except: [] }], repos: [DOTFILES] },
  orgs: ['acme', 'initech'],
};

function respond({ status, headers, body }: Recorded) {
  return new Response(status === 304 || body === null ? null : JSON.stringify(body), { status, headers });
}

const describeRequest = (url: URL, init?: RequestInit): Sent => {
  const headers = new Headers(init?.headers);
  const path = `${url.pathname.slice(new URL(API).pathname.replace(/\/$/, '').length)}${url.search}`;
  const sent: Sent = { method: init?.method ?? 'GET', path, etag: headers.get('if-none-match') };
  if (sent.method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { operationName: string; variables: unknown };
    sent.operationName = body.operationName;
    sent.variables = body.variables;
  }
  return sent;
};

// Answers each request with the next recording, after checking it is the request recorded.
function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = describeRequest(new URL(String(input)), init);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer ghu_recorded');
    expect(headers.get('user-agent')).toBe('Commander');
    sent.push(request);
    const next = queue.shift();
    if (!next)
      throw new Error(`Unexpected request ${request.method} ${request.path} ${request.operationName ?? ''}`);
    expect({ method: request.method, path: request.path }).toEqual({
      method: next.request.method,
      path: next.request.path,
    });
    if (next.request.method === 'GET') expect(request.etag).toBe(next.request.etag ?? null);
    else {
      expect(request.operationName).toBe(next.request.operationName);
      expect(request.variables).toEqual(next.request.variables);
    }
    return respond(next.response);
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    sent,
    remaining: () => queue.map((each) => each.request),
  };
}

// Answers by a function of the request, for the narrower tests.
function answering(answer: (request: Sent) => Recorded) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = describeRequest(new URL(String(input)), init);
    sent.push(request);
    return respond(answer(request));
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

async function sync(
  fetch: typeof globalThis.fetch,
  {
    cursor = null,
    now = NOW,
    watch = WATCH,
    catalog = null,
    budget,
    held = [],
  }: {
    cursor?: unknown;
    now?: number;
    watch?: SyncWatch | null;
    catalog?: GitHubCatalog | null;
    budget?: Partial<GitHubBudget>;
    // The Items Commander holds already (what earlier syncs saved).
    held?: SourceItem[];
  } = {},
) {
  const pages: SyncPage[] = [];
  const catalogs: GitHubCatalog[] = [];
  const source = createGitHubSource({ apiUrl: () => API, fetch, now: () => now, budget });
  const result = await source.sync({
    account: 'github:583231',
    cursor,
    mode: 'full',
    accessToken: async () => token,
    save: (page) => pages.push(page),
    saveCatalog: (each) => {
      if (each.kind === 'github') catalogs.push(each);
    },
    catalog,
    watch,
    stored: (externalIds) =>
      externalIds.flatMap((externalId) => {
        const item = byId(held, externalId);
        return item
          ? [
              {
                externalId,
                title: item.title,
                people: item.people ?? [],
                status: item.status ?? 'open',
                detail: item.detail ?? null,
              },
            ]
          : [];
      }),
    signal: new AbortController().signal,
  });
  return {
    result,
    cursor: result.cursor as GitHubCursor,
    pages,
    items: pages.flatMap((page) => page.items),
    deleted: pages.flatMap((page) => page.deleted),
    catalog: catalogs.at(-1) ?? null,
  };
}

const byId = (items: SourceItem[], externalId: string) =>
  items.filter((item) => item.externalId === externalId).at(-1);
const ids = (items: SourceItem[]) => [...new Set(items.map((item) => item.externalId))];

async function afterFirstSync() {
  return sync(replay(firstSync as Exchange[]).fetch);
}

describe('the first sync', () => {
  it('asks for open work, gates each owner, searches its open and recently closed work, and queries its repos', async () => {
    const github = replay(firstSync as Exchange[]);
    await sync(github.fetch);
    expect(github.remaining()).toEqual([]);
  });

  it('brings open pull requests and issues in watched repos, those closed in the last 30 days, and recent releases', async () => {
    const { items } = await afterFirstSync();
    expect(ids(items).sort()).toEqual(
      [
        'R_kgDOAcmeApi:pull/12',
        'R_kgDOAcmeApi:pull/15',
        'R_kgDOAcmeWeb:pull/7',
        'R_kgDOAcmeApi:issue/30',
        'R_kgDOAcmeApi:issue/25',
        'R_kgDOAcmeApi:pull/9',
        'R_kgDOAcmeApi:review-request/15',
        'R_kgDOAcmeWeb:review-request/7',
        'R_kgDOAcmeApi:release/RE_api_140',
      ].sort(),
    );
    // initech/secret isn't watched, though octocat's pull request there is open work.
    expect(items.some((item) => item.externalId.startsWith('R_kgDOOtherSecret'))).toBe(false);
  });

  it('saves a pull request with its detail, its People as handles and the emails GitHub tied to them', async () => {
    const { items } = await afterFirstSync();
    expect(byId(items, 'R_kgDOAcmeApi:pull/15')).toEqual({
      externalId: 'R_kgDOAcmeApi:pull/15',
      kind: 'pull-request',
      title: 'Rotate the signing keys',
      people: ['github:priya', 'github:octocat', 'github:sam', 'priya@acme.test', 'priya.patel@acme.test'],
      // Who the logins are, for Person matching: the author's profile, and the head commit's author.
      identities: [
        { handle: 'github:priya', email: 'priya@acme.test', name: 'Priya Patel' },
        { handle: 'github:priya', email: 'priya.patel@acme.test', name: null },
      ],
      status: 'open',
      detail: {
        kind: 'pull-request',
        repo: API_REPO,
        number: 15,
        url: 'https://github.com/acme/api/pull/15',
        nodeId: 'PR_api_15',
        author: 'priya',
        state: 'open',
        draft: false,
        baseBranch: 'main',
        headBranch: 'kms-keys',
        labels: [],
        assignees: [],
        requestedReviewers: [
          { kind: 'user', login: 'octocat', requestedAt: Date.parse('2026-10-02T11:30:00Z') },
          { kind: 'team', team: 'acme/platform', requestedAt: Date.parse('2026-10-02T10:00:00Z') },
        ],
        reviews: [{ login: 'sam', state: 'commented', submittedAt: Date.parse('2026-10-02T12:00:00Z') }],
        reviewDecision: 'review-required',
        checks: 'success',
        closingIssues: [],
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        body: 'Moves signing to the new KMS key.',
        createdAt: Date.parse('2026-09-30T09:00:00Z'),
        updatedAt: Date.parse('2026-10-02T15:00:00Z'),
        mergedAt: null,
        closedAt: null,
      },
    });
    const twelve = byId(items, 'R_kgDOAcmeApi:pull/12');
    // GitHub's no-reply address is no use for matching People.
    expect(twelve?.people).toEqual(['github:octocat', 'github:priya', 'octocat@github.test']);
    expect(twelve?.detail).toMatchObject({
      checks: 'pending',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
      closingIssues: [
        {
          owner: 'acme',
          name: 'api',
          number: 30,
          title: 'Webhooks drop on 502',
          url: 'https://github.com/acme/api/issues/30',
        },
      ],
    });
    expect(byId(items, 'R_kgDOAcmeApi:pull/9')).toMatchObject({
      status: 'done',
      detail: { state: 'merged', mergedAt: Date.parse('2026-09-21T09:00:00Z'), reviewDecision: 'approved' },
    });
  });

  it('saves an issue with its milestone and its counts, parent, sub-issue summary, claim and blockers', async () => {
    const { items } = await afterFirstSync();
    expect(byId(items, 'R_kgDOAcmeApi:issue/30')).toEqual({
      externalId: 'R_kgDOAcmeApi:issue/30',
      kind: 'github-issue',
      title: 'Webhooks drop on 502',
      people: ['github:priya', 'github:octocat', 'priya@acme.test'],
      identities: [{ handle: 'github:priya', email: 'priya@acme.test', name: null }],
      status: 'open',
      detail: {
        kind: 'github-issue',
        repo: API_REPO,
        number: 30,
        url: 'https://github.com/acme/api/issues/30',
        nodeId: 'I_api_30',
        author: 'priya',
        assignees: ['octocat'],
        labels: [{ name: 'bug', color: 'd73a4a' }],
        milestone: {
          title: 'October',
          dueOn: Date.parse('2026-10-31T00:00:00Z'),
          issues: { open: 3, closed: 5 },
        },
        state: 'open',
        stateReason: null,
        body: 'When the receiver answers 502 we drop the event.',
        commentCount: 4,
        createdAt: Date.parse('2026-09-20T09:00:00Z'),
        updatedAt: Date.parse('2026-10-01T10:00:00Z'),
        closedAt: null,
        parent: {
          owner: 'acme',
          name: 'api',
          number: 25,
          title: 'Reliable webhooks',
          url: 'https://github.com/acme/api/issues/25',
        },
        subIssues: null,
        // Assigned to octocat (its one assignee) on 28 September; priya's earlier assignment is past.
        claimedAt: Date.parse('2026-09-28T08:00:00Z'),
        blockedBy: [{ owner: 'acme', name: 'api', number: 28, state: 'closed' }],
      },
    });
    expect(byId(items, 'R_kgDOAcmeApi:issue/25')?.detail).toMatchObject({
      subIssues: { total: 4, completed: 1 },
    });
  });

  it('makes a review request for each review asked of the User, directly or through one of their teams', async () => {
    const { items } = await afterFirstSync();
    expect(byId(items, 'R_kgDOAcmeApi:review-request/15')).toEqual({
      externalId: 'R_kgDOAcmeApi:review-request/15',
      kind: 'review-request',
      title: 'Rotate the signing keys',
      people: ['github:priya'],
      status: 'open',
      detail: {
        kind: 'review-request',
        pullRequest: 'R_kgDOAcmeApi:pull/15',
        pullRequestId: null,
        repo: API_REPO,
        number: 15,
        url: 'https://github.com/acme/api/pull/15',
        direct: true,
        teams: ['acme/platform'],
        requestedAt: Date.parse('2026-10-02T11:30:00Z'),
      },
    });
    // Only the User's own team, not design.
    expect(byId(items, 'R_kgDOAcmeWeb:review-request/7')?.detail).toMatchObject({
      direct: false,
      teams: ['acme/platform'],
      requestedAt: Date.parse('2026-10-01T14:00:00Z'),
    });
  });

  it('hands a review request over after the pull request it is about', async () => {
    const { pages } = await afterFirstSync();
    const order = pages.flatMap((page) => page.items.map((item) => item.externalId));
    expect(order.indexOf('R_kgDOAcmeApi:review-request/15')).toBeGreaterThan(
      order.indexOf('R_kgDOAcmeApi:pull/15'),
    );
  });

  it('saves releases published in the last 30 days, never drafts', async () => {
    const { items } = await afterFirstSync();
    expect(byId(items, 'R_kgDOAcmeApi:release/RE_api_140')).toEqual({
      externalId: 'R_kgDOAcmeApi:release/RE_api_140',
      kind: 'github-release',
      title: 'api Webhooks, faster',
      people: ['github:priya'],
      status: 'done',
      detail: {
        kind: 'github-release',
        repo: API_REPO,
        tag: 'v1.4.0',
        name: 'Webhooks, faster',
        url: 'https://github.com/acme/api/releases/tag/v1.4.0',
        author: 'priya',
        prerelease: false,
        publishedAt: Date.parse('2026-10-01T18:00:00Z'),
        notes: '- Retries\n- Faster lookups',
      },
    });
  });

  it('keeps each watched repo’s health: its default branch, head checks and the last week’s commits, reverts flagged', async () => {
    const { catalog } = await afterFirstSync();
    expect(catalog?.repos.map((repo) => `${repo.repo.owner}/${repo.repo.name}`)).toEqual([
      'acme/api',
      'acme/web',
      'octocat/dotfiles',
    ]);
    expect(catalog?.repos[0]).toEqual({
      repo: API_REPO,
      defaultBranch: 'main',
      head: { oid: 'a1b2c3', checks: 'success', committedAt: Date.parse('2026-10-02T16:00:00Z') },
      commits: [
        {
          oid: 'a1b2c3',
          headline: 'Revert "Cache the session lookups"',
          author: { login: 'sam', name: 'Sam', email: 'sam@acme.test' },
          committedAt: Date.parse('2026-10-02T16:00:00Z'),
          revert: true,
        },
        {
          oid: '9f8e7d',
          headline: 'Cache the session lookups',
          author: { login: 'priya', name: 'Priya', email: 'priya@acme.test' },
          committedAt: Date.parse('2026-10-01T09:00:00Z'),
          revert: false,
        },
      ],
      checkedAt: NOW,
    });
    expect(catalog?.repos[1]?.head?.checks).toBe('failure');
    expect(catalog?.repos[2]?.head?.checks).toBeNull();
  });

  it('keeps the ETags, each repo’s last push, the open review requests and what it cost', async () => {
    const { cursor, result } = await afterFirstSync();
    expect(cursor.owners.acme).toEqual({
      kind: 'org',
      reposEtag: 'W/"acme-repos-1"',
      issuesEtag: 'W/"acme-issues-1"',
      issuesGate: true,
      since: '2026-10-03T11:55:00.000Z',
      scope: { whole: true, ids: [] },
    });
    expect(cursor.personalEtag).toBe('W/"personal-1"');
    expect(cursor.repos.R_kgDOAcmeApi?.pushedAt).toBe('2026-10-02T16:00:00Z');
    expect(cursor.reviewRequests.sort()).toEqual([
      'R_kgDOAcmeApi:review-request/15',
      'R_kgDOAcmeWeb:review-request/7',
    ]);
    expect(cursor.login).toBe('octocat');
    // Five REST requests charged (teams and four gates); GraphQL points as GitHub reported them.
    expect(result.cost).toEqual({ requests: 5, complexity: 13 });
  });
});

describe('a sync with nothing changed', () => {
  it('ends after open work when every gate answers 304', async () => {
    const first = await afterFirstSync();
    const github = replay(unchanged as Exchange[]);
    const again = await sync(github.fetch, {
      cursor: first.cursor,
      now: LATER,
      catalog: first.catalog,
      held: first.items,
    });

    expect(github.remaining()).toEqual([]);
    expect(github.sent.filter((each) => each.operationName === 'CommanderSearch')).toEqual([]);
    // Only open work, as it was: the same Items, and no review request tombstoned.
    expect(again.deleted).toEqual([]);
    for (const item of again.items) expect(item).toEqual(byId(first.items, item.externalId));
    // 304s are free.
    expect(again.result.cost).toEqual({ requests: 0, complexity: 1 });
    expect(again.cursor.owners).toEqual(first.cursor.owners);
    expect(again.catalog).toEqual(first.catalog);
  });
});

describe('a sync after changes', () => {
  async function afterChanges() {
    const first = await afterFirstSync();
    const github = replay(changed as Exchange[]);
    const next = await sync(github.fetch, {
      cursor: first.cursor,
      now: LATER,
      catalog: first.catalog,
      held: first.items,
    });
    return { first, github, next };
  }

  it('searches the owner since the cursor and queries only the repos pushed to since', async () => {
    const { github } = await afterChanges();
    expect(github.remaining()).toEqual([]);
  });

  it('saves what changed, and tombstones the review request the User met', async () => {
    const { next } = await afterChanges();
    expect(byId(next.items, 'R_kgDOAcmeApi:pull/15')?.detail).toMatchObject({
      reviewDecision: 'approved',
      requestedReviewers: [],
    });
    expect(byId(next.items, 'R_kgDOAcmeApi:issue/30')).toMatchObject({
      status: 'done',
      detail: { state: 'closed', stateReason: 'completed' },
    });
    expect(next.deleted).toEqual(['R_kgDOAcmeApi:review-request/15']);
    expect(next.cursor.reviewRequests).toEqual(['R_kgDOAcmeWeb:review-request/7']);
    expect(byId(next.items, 'R_kgDOAcmeApi:release/RE_api_141')).toMatchObject({ kind: 'github-release' });
  });

  it('tombstones a met review request once its pull request is saved as it is now, so its Todo can say why', async () => {
    const { next } = await afterChanges();
    const pull = next.pages.findLastIndex((page) =>
      page.items.some((item) => item.externalId === 'R_kgDOAcmeApi:pull/15'),
    );
    const tombstone = next.pages.findIndex((page) =>
      page.deleted.includes('R_kgDOAcmeApi:review-request/15'),
    );
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(tombstone).toBeGreaterThan(pull);
  });

  it('adds the new commits to the repo’s health and keeps the rest', async () => {
    const { next } = await afterChanges();
    const api = next.catalog?.repos.find((repo) => repo.repo.name === 'api');
    expect(api?.head).toEqual({
      oid: 'b4b4b4',
      checks: 'success',
      committedAt: Date.parse('2026-10-03T12:04:00Z'),
    });
    expect(api?.commits.map((commit) => commit.oid)).toEqual(['b4b4b4', 'a1b2c3', '9f8e7d']);
    expect(next.catalog?.repos.find((repo) => repo.repo.name === 'web')?.checkedAt).toBe(NOW);
    expect(next.cursor.owners.acme?.reposEtag).toBe('W/"acme-repos-2"');
    expect(next.cursor.owners.acme?.since).toBe('2026-10-03T12:10:00.000Z');
  });
});

// A GitHub that answers every gate with a 304 and open work as at the first sync, unless `answer`
// says otherwise.
function quietGitHub(answer: (request: Sent) => Recorded | undefined = () => undefined) {
  const openWork = (firstSync as Exchange[])[1]?.response as Recorded;
  const nodes = (firstSync as Exchange[])[2]?.response as Recorded;
  return answering((request) => {
    const special = answer(request);
    if (special) return special;
    if (request.operationName === 'CommanderOpenWork') return openWork;
    if (request.operationName === 'CommanderNodes') return nodes;
    if (request.method === 'GET') return recorded.notModified as Recorded;
    throw new Error(`Unexpected request ${request.method} ${request.path} ${request.operationName ?? ''}`);
  });
}

describe('searching more than GitHub returns at once', () => {
  it('splits the time window while a window would pass 1,000 results', async () => {
    const first = await afterFirstSync();
    // Since 11:55 there are 1,500 changes: 900 in the first half, 600 in the second.
    const counts: Record<string, number> = {
      'org:acme updated:>=2026-10-03T11:55:00Z': 1500,
      'org:acme updated:2026-10-03T11:55:00Z..2026-10-03T12:05:00Z': 900,
      'org:acme updated:2026-10-03T12:05:01Z..2026-10-03T12:15:00Z': 600,
    };
    const github = quietGitHub((request) => {
      if (request.path.startsWith('/orgs/acme/issues')) return recorded.issuesGate as Recorded;
      const query = (request.variables as { query?: string } | undefined)?.query ?? '';
      if (request.operationName === 'CommanderSearchCount') {
        const count = counts[query];
        if (count === undefined) throw new Error(`Unexpected search ${query}`);
        return { status: 200, headers: {}, body: { data: { search: { issueCount: count } } } };
      }
      if (request.operationName === 'CommanderSearch') return recorded.searchPage as Recorded;
      return undefined;
    });
    await sync(github.fetch, { cursor: first.cursor, now: LATER });

    const searched = github.sent
      .filter((each) => each.operationName === 'CommanderSearch')
      .map((each) => (each.variables as { query: string; first: number }).query);
    expect(searched).toEqual([
      'org:acme updated:2026-10-03T11:55:00Z..2026-10-03T12:05:00Z',
      'org:acme updated:2026-10-03T12:05:01Z..2026-10-03T12:15:00Z',
    ]);
  });
});

describe('gates that can’t settle it', () => {
  it('searches every sync an org whose issues GitHub won’t list to the User', async () => {
    const first = await afterFirstSync();
    const cursor = structuredClone(first.cursor);
    const acme = cursor.owners.acme;
    if (!acme) throw new Error('no acme');
    cursor.owners.acme = { ...acme, issuesGate: false, issuesEtag: null };
    const github = quietGitHub((request) =>
      request.operationName === 'CommanderSearchCount'
        ? { status: 200, headers: {}, body: { data: { search: { issueCount: 0 } } } }
        : undefined,
    );
    await sync(github.fetch, { cursor, now: LATER, held: first.items });

    expect(github.sent.some((each) => each.path.startsWith('/orgs/acme/issues'))).toBe(false);
    expect(github.sent.find((each) => each.operationName === 'CommanderSearchCount')?.variables).toEqual({
      query: 'org:acme updated:>=2026-10-03T11:55:00Z',
    });
  });

  it('looks at a repo again while its default branch’s checks are still running, though nothing was pushed', async () => {
    const first = await afterFirstSync();
    const catalog = structuredClone(first.catalog);
    const api = catalog?.repos[0];
    if (!api?.head) throw new Error('no api');
    api.head.checks = 'pending';
    const github = quietGitHub((request) =>
      request.operationName === 'CommanderRepos'
        ? {
            status: 200,
            headers: {},
            body: { data: { nodes: [recorded.repoNode] } },
          }
        : undefined,
    );
    const next = await sync(github.fetch, { cursor: first.cursor, now: LATER, catalog, held: first.items });

    expect(
      github.sent.filter((each) => each.operationName === 'CommanderRepos').map((each) => each.variables),
    ).toEqual([{ ids: ['R_kgDOAcmeApi'], since: '2026-10-03T11:55:00.000Z' }]);
    expect(next.catalog?.repos[0]?.head?.checks).toBe('success');
  });
});

describe('querying many repos', () => {
  it('asks about 25 repos at a time, and halves the batch when GitHub times out', async () => {
    const nodeIds = Array.from({ length: 30 }, (_, n) => `R_many_${n}`);
    const repos = nodeIds.map((nodeId, n) => ({
      node_id: nodeId,
      name: `repo-${n}`,
      owner: { login: 'acme', type: 'Organization' },
      archived: false,
      pushed_at: '2026-10-02T16:00:00Z',
    }));
    let timedOut = false;
    const github = quietGitHub((request) => {
      if (request.path.startsWith('/orgs/acme/repos')) return { status: 200, headers: {}, body: repos };
      if (request.operationName === 'CommanderSearchCount')
        return { status: 200, headers: {}, body: { data: { search: { issueCount: 0 } } } };
      if (request.operationName === 'CommanderRepos') {
        const asked = (request.variables as { ids: string[] }).ids;
        if (asked.length === 25 && !timedOut) {
          timedOut = true;
          return recorded.timeout as Recorded;
        }
        const node = recorded.repoNode as unknown as Record<string, unknown>;
        return {
          status: 200,
          headers: {},
          body: { data: { nodes: asked.map((id, n) => ({ ...node, id, name: `repo-${n}` })) } },
        };
      }
      return undefined;
    });
    const { catalog } = await sync(github.fetch, {
      watch: { selection: { orgs: [{ login: 'acme', except: [] }], repos: [] }, orgs: ['acme'] },
    });

    const batches = github.sent
      .filter((each) => each.operationName === 'CommanderRepos')
      .map((each) => (each.variables as { ids: string[] }).ids.length);
    expect(batches).toEqual([25, 12, 12, 6]);
    expect(catalog?.repos).toHaveLength(30);
  });
});

describe('rate limits', () => {
  const failing = (answer: Recorded) =>
    quietGitHub((request) => (request.path === '/user/teams?per_page=100' ? answer : undefined));

  it('waits until the reset when the hourly limit is spent', async () => {
    const error = await sync(failing(recorded.primaryLimit as Recorded).fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(1791034200 * 1000 - NOW);
  });

  it('honours Retry-After', async () => {
    const error = await sync(failing(recorded.tooManyRequests as Recorded).fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(120_000);
  });

  it('waits a minute after a secondary limit that says no more', async () => {
    const error = await sync(failing(recorded.secondaryLimit as Recorded).fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(60_000);
  });

  it('waits for GraphQL’s reset when GitHub says its points are spent', async () => {
    const github = quietGitHub((request) =>
      request.operationName === 'CommanderOpenWork' ? (recorded.graphqlRateLimited as Recorded) : undefined,
    );
    const error = await sync(github.fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(1791032400 * 1000 - NOW);
  });

  it('leaves a reserve for the User’s other tools: with little left, it asks nothing until the reset', async () => {
    const first = await afterFirstSync();
    const resetAt = NOW + 20 * 60_000;
    const cursor = { ...first.cursor, limits: { graphql: { limit: 5000, remaining: 120, resetAt } } };
    const github = quietGitHub();
    const error = await sync(github.fetch, { cursor, now: LATER }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(resetAt - LATER);
    expect(github.sent).toEqual([]);
  });

  it('leaves owners past the sync’s budget to the next sync', async () => {
    const github = replay((firstSync as Exchange[]).slice(0, 10));
    const { cursor } = await sync(github.fetch, { budget: { pointsPerSync: 5 } });
    expect(github.remaining()).toEqual([]);
    expect(Object.keys(cursor.owners)).toEqual(['acme']);
  });

  it('a refused sign-in is SignInRefused', async () => {
    const error = await sync(failing(recorded.badCredentials as Recorded).fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInRefused);
  });
});

describe('what isn’t there any more', () => {
  it('skips an org GitHub won’t show any more, keeping its Items and cursor', async () => {
    const first = await afterFirstSync();
    const github = quietGitHub((request) =>
      request.path.startsWith('/orgs/acme/repos') ? (recorded.notFound as Recorded) : undefined,
    );
    const { cursor, deleted } = await sync(github.fetch, { cursor: first.cursor, now: LATER });
    expect(deleted).toEqual([]);
    expect(cursor.owners.acme).toEqual(first.cursor.owners.acme);
  });

  it('once a day, tombstones open pull requests and issues GitHub deleted or moved to another repo', async () => {
    const first = await afterFirstSync();
    const open = {
      PR_api_15: 'R_kgDOAcmeApi:pull/15',
      I_api_30: 'R_kgDOAcmeApi:issue/30',
      PR_api_12: 'R_kgDOAcmeApi:pull/12',
    };
    const cursor = { ...first.cursor, open, sweptAt: NOW - 25 * 60 * 60_000 };
    const github = quietGitHub((request) =>
      request.operationName === 'CommanderSweep' ? (recorded.sweep as Recorded) : undefined,
    );
    const watch: SyncWatch = { selection: { orgs: [], repos: [API_REPO] }, orgs: ['acme'] };
    const next = await sync(github.fetch, { cursor, now: LATER, watch });

    const sweep = github.sent.find((each) => each.operationName === 'CommanderSweep');
    expect(sweep?.variables).toEqual({
      ids: ['PR_api_15', 'I_api_30', 'PR_api_12'],
      repos: ['R_kgDOAcmeApi'],
    });
    expect(next.deleted.filter((id) => !id.includes('review-request'))).toEqual([
      'R_kgDOAcmeApi:pull/15',
      'R_kgDOAcmeApi:issue/30',
    ]);
    expect(next.cursor.open).toEqual({ PR_api_12: 'R_kgDOAcmeApi:pull/12' });
    expect(next.cursor.sweptAt).toBe(LATER);
  });

  it('does a first sync for an owner again when more of its repos are watched', async () => {
    const first = await afterFirstSync();
    const watch: SyncWatch = {
      selection: { orgs: [], repos: [API_REPO, DOTFILES] } satisfies GitHubWatch,
      orgs: ['acme'],
    };
    // Watching only acme/api is less than all of acme: nothing to catch up on.
    const narrower = quietGitHub();
    await sync(narrower.fetch, { cursor: first.cursor, now: LATER, watch });
    expect(narrower.sent.filter((each) => each.operationName === 'CommanderSearchCount')).toEqual([]);

    // Watching acme whole again, after only api: a first sync of acme.
    const { cursor } = await sync(quietGitHub().fetch, { cursor: first.cursor, now: LATER, watch });
    const wider = quietGitHub((request) =>
      request.operationName === 'CommanderSearchCount'
        ? { status: 200, headers: {}, body: { data: { search: { issueCount: 0 } } } }
        : request.path.startsWith('/orgs/acme/') && request.etag === null
          ? (recorded.reposApi as Recorded)
          : undefined,
    );
    await sync(wider.fetch, { cursor, now: LATER + 60_000 });
    expect(
      wider.sent
        .filter((each) => each.operationName === 'CommanderSearchCount')
        .map((each) => (each.variables as { query: string }).query),
    ).toEqual(['org:acme is:open', 'org:acme is:closed closed:>=2026-09-03T12:16:00Z']);
  });

  it('fetches nothing while nothing is watched', async () => {
    const github = quietGitHub();
    await sync(github.fetch, { watch: null });
    expect(github.sent).toEqual([]);
  });
});
