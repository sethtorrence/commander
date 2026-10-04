import type { SourceItem } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type AccessToken, RateLimited, SignInRefused, SourceUnavailable, type SyncPage } from '../source';
import { createLinearSource } from './linear-source';
import firstSync from './recorded/first-sync.json';
import incremental from './recorded/incremental.json';
import refusals from './recorded/refusals.json';

// The Linear adapter against recorded GraphQL responses (shaped exactly as Linear answers). Each
// recording also pins down the request Commander must send for it.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = {
  request: { operationName: string; variables: Record<string, unknown> };
  response: Recorded;
};

const NOW = Date.UTC(2026, 9, 3, 12);
const apiKey: AccessToken = { token: 'lin_api_recorded', kind: 'api-key' };

// Answers each request with the next recording, after checking the request is the one recorded.
function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: { authorization: string | null; operationName: string; variables: unknown }[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { operationName: string; variables: unknown };
    const headers = new Headers(init?.headers);
    sent.push({ authorization: headers.get('authorization'), ...body });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${body.operationName}`);
    expect(body.operationName).toBe(next.request.operationName);
    expect(body.variables).toMatchObject(next.request.variables);
    return respond(next.response);
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, remaining: () => queue.length };
}

function respond({ status, headers, body }: Recorded) {
  return new Response(body === null ? 'Service Unavailable' : JSON.stringify(body), { status, headers });
}

async function sync(
  fetch: typeof globalThis.fetch,
  cursor: unknown = null,
  token = apiKey,
  recheck: string[] | undefined = undefined,
) {
  const pages: SyncPage[] = [];
  const source = createLinearSource({ apiUrl: () => 'https://linear.test/graphql', fetch, now: () => NOW });
  const result = await source.sync({
    account: 'linear:org-acme',
    cursor,
    accessToken: async () => token,
    save: (page) => pages.push(page),
    signal: new AbortController().signal,
    recheck,
  });
  return { result, pages, items: pages.flatMap((page) => page.items) };
}

const byId = (items: SourceItem[], externalId: string) =>
  items.find((item) => item.externalId === externalId);

describe('the first sync', () => {
  it('fetches every open issue plus those closed in the last 30 days, page by page', async () => {
    const linear = replay(firstSync as Exchange[]);
    const { pages, items } = await sync(linear.fetch);

    expect(linear.remaining()).toBe(0);
    expect(pages.map((page) => page.items.map((item) => item.externalId))).toEqual([
      ['issue-418', 'issue-401'],
      ['issue-377'],
    ]);
    expect(items.map((item) => [item.title, item.status])).toEqual([
      ['Fix the login loop', 'open'],
      ['Rotate the signing keys', 'done'],
      ['Move backups to the new bucket', 'done'],
    ]);
  });

  it('turns each issue into a linear-issue Item with its Linear detail and People as handles', async () => {
    const { items } = await sync(replay(firstSync as Exchange[]).fetch);
    const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
    const sam = { id: 'user-sam', name: 'Sam Lee', displayName: 'sam', email: null };

    expect(byId(items, 'issue-418')).toEqual({
      externalId: 'issue-418',
      kind: 'linear-issue',
      title: 'Fix the login loop',
      people: ['linear:user-priya', 'priya@acme.test', 'linear:user-sam'],
      status: 'open',
      detail: {
        kind: 'linear-issue',
        identifier: 'ENG-418',
        url: 'https://linear.app/acme/issue/ENG-418/fix-the-login-loop',
        team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
        state: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
        priority: 2,
        assignee: priya,
        creator: sam,
        labels: [
          { id: 'label-bug', name: 'Bug', color: '#eb5757' },
          { id: 'label-urgent', name: 'Customer', color: '#5e6ad2' },
        ],
        cycle: {
          id: 'cycle-12',
          number: 12,
          name: null,
          startsAt: Date.UTC(2026, 8, 28),
          endsAt: Date.UTC(2026, 9, 12),
        },
        linearProject: { id: 'project-login', name: 'Login revamp' },
        dueDate: '2026-10-09',
        estimate: 3,
        description: 'The login page **loops** after SSO.',
        comments: [
          {
            id: 'comment-1',
            author: priya,
            body: 'Reproduced on staging.',
            createdAt: Date.UTC(2026, 8, 30, 9),
            updatedAt: Date.UTC(2026, 8, 30, 9),
          },
        ],
        createdAt: Date.UTC(2026, 8, 29, 10),
        updatedAt: Date.UTC(2026, 9, 1, 9),
        startedAt: Date.UTC(2026, 8, 30, 8),
        completedAt: null,
        canceledAt: null,
      },
    });
    expect(byId(items, 'issue-377')?.detail).toMatchObject({
      state: { type: 'canceled' },
      canceledAt: Date.UTC(2026, 8, 20, 11),
      linearProject: { name: 'Storage plan' },
    });
  });

  it('starts the next sync from the newest change Linear reported, and reports the complexity', async () => {
    const { result } = await sync(replay(firstSync as Exchange[]).fetch);

    expect(result).toEqual({
      cursor: {
        issuesUpdatedAfter: '2026-10-01T09:00:00.000Z',
        commentsUpdatedAfter: '2026-10-01T09:00:00.000Z',
      },
      cost: { requests: 2, complexity: 291 + 288 },
    });
  });

  it('presents API keys bare and OAuth tokens as Bearer tokens', async () => {
    const withKey = replay(firstSync as Exchange[]);
    await sync(withKey.fetch);
    const withOAuth = replay(firstSync as Exchange[]);
    await sync(withOAuth.fetch, null, { token: 'lin_oauth_recorded', kind: 'oauth' });

    expect(withKey.sent[0]?.authorization).toBe('lin_api_recorded');
    expect(withOAuth.sent[0]?.authorization).toBe('Bearer lin_oauth_recorded');
  });
});

describe('polling for changes', () => {
  const cursor = {
    issuesUpdatedAfter: '2026-10-01T09:00:00.000Z',
    commentsUpdatedAfter: '2026-10-01T09:00:00.000Z',
  };

  it('fetches issues updated since the cursor across several pages, with all their comments', async () => {
    const linear = replay(incremental as Exchange[]);
    const { items } = await sync(linear.fetch, cursor);

    expect(linear.remaining()).toBe(0);
    expect(byId(items, 'issue-418')?.detail).toMatchObject({ state: { name: 'In Review' }, priority: 1 });
    expect(byId(items, 'issue-430')?.detail).toMatchObject({
      comments: [
        { id: 'comment-30a', author: null, body: 'Started a spike.' },
        { id: 'comment-30b', author: { displayName: 'sam' }, body: 'And for imports?' },
      ],
    });
  });

  it('refetches issues whose comments changed even when the issue itself did not', async () => {
    const { items } = await sync(replay(incremental as Exchange[]).fetch, cursor);

    expect(byId(items, 'issue-401')?.detail).toMatchObject({
      comments: [{ id: 'comment-9', body: 'Keys rotated in prod too.' }],
    });
  });

  it('reports archived and deleted issues for tombstoning', async () => {
    const { pages, items } = await sync(replay(incremental as Exchange[]).fetch, cursor);

    expect(pages.flatMap((page) => page.deleted)).toEqual(['issue-377']);
    expect(byId(items, 'issue-377')).toBeUndefined();
  });

  it('moves the cursor on to the newest issue and comment changes it saw', async () => {
    const { result } = await sync(replay(incremental as Exchange[]).fetch, cursor);

    expect(result).toEqual({
      cursor: {
        issuesUpdatedAfter: '2026-10-03T10:00:00.000Z',
        commentsUpdatedAfter: '2026-10-03T11:15:00.000Z',
      },
      cost: { requests: 5, complexity: 290 + 286 + 12 + 6 + 40 },
    });
  });

  it('keeps the cursor when nothing changed', async () => {
    const empty = (operationName: string, field: string): Exchange => ({
      request: { operationName, variables: {} },
      response: {
        status: 200,
        headers: { 'x-complexity': '3' },
        body: { data: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      },
    });
    const linear = replay([
      empty('CommanderIssues', 'issues'),
      empty('CommanderChangedComments', 'comments'),
    ]);

    const { result, pages } = await sync(linear.fetch, cursor);

    expect(result.cursor).toEqual(cursor);
    expect(pages.flatMap((page) => [...page.items, ...page.deleted])).toEqual([]);
  });

  // The issues behind open Linear Todos: a reassignment may not show among what changed.
  describe('re-reading the issues it is asked to recheck', () => {
    const empty = (operationName: string, field: string): Exchange => ({
      request: { operationName, variables: {} },
      response: {
        status: 200,
        headers: {},
        body: { data: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      },
    });
    const recorded = (incremental as Exchange[])[0]?.response.body as {
      data: { issues: { nodes: Record<string, unknown>[] } };
    };
    const reassigned = { ...recorded.data.issues.nodes[0], updatedAt: '2026-09-30T10:00:00.000Z' };

    it('reads them in one batched query, and reports those Linear no longer has as deleted', async () => {
      const linear = replay([
        empty('CommanderIssues', 'issues'),
        empty('CommanderChangedComments', 'comments'),
        {
          request: {
            operationName: 'CommanderIssues',
            variables: { includeArchived: true, filter: { id: { in: ['issue-418', 'issue-gone'] } } },
          },
          response: {
            status: 200,
            headers: {},
            body: {
              data: { issues: { nodes: [reassigned], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          },
        },
      ]);
      const { items, pages, result } = await sync(linear.fetch, cursor, apiKey, ['issue-418', 'issue-gone']);

      expect(linear.remaining()).toBe(0);
      expect(byId(items, 'issue-418')?.detail).toMatchObject({ assignee: { name: 'Priya Patel' } });
      expect(pages.flatMap((page) => page.deleted)).toEqual(['issue-gone']);
      expect(result.cursor).toEqual(cursor);
    });

    it('skips those the sync already brought', async () => {
      const linear = replay(incremental as Exchange[]);
      await sync(linear.fetch, cursor, apiKey, ['issue-418', 'issue-401']);
      expect(linear.remaining()).toBe(0);
    });
  });
});

describe('when Linear says no', () => {
  const once = (response: Recorded): Exchange[] => [
    { request: { operationName: 'CommanderIssues', variables: {} }, response },
  ];

  it('treats a RATELIMITED answer as a rate limit, waiting until the exhausted limit resets', async () => {
    const failure = sync(replay(once(refusals.rateLimited)).fetch);

    await expect(failure).rejects.toBeInstanceOf(RateLimited);
    await expect(failure).rejects.toMatchObject({ retryAfterMs: 2 * 60 * 60_000 });
  });

  it('honours Retry-After on a 429', async () => {
    await expect(sync(replay(once(refusals.tooManyRequests)).fetch)).rejects.toMatchObject({
      name: 'RateLimited',
      retryAfterMs: 120_000,
    });
  });

  it('stops before running out of complexity, until the limit resets', async () => {
    const [page] = firstSync as Exchange[];
    if (!page) throw new Error('missing recording');
    const nearlySpent: Exchange = {
      ...page,
      response: {
        ...page.response,
        headers: {
          'x-complexity': '291',
          'x-ratelimit-complexity-remaining': '200',
          'x-ratelimit-complexity-reset': String(NOW + 30 * 60_000),
        },
      },
    };
    const linear = replay([nearlySpent]);

    const failure = sync(linear.fetch);

    await expect(failure).rejects.toMatchObject({ name: 'RateLimited', retryAfterMs: 30 * 60_000 });
    expect(linear.sent).toHaveLength(1);
  });

  it('reports a refused sign-in', async () => {
    await expect(sync(replay(once(refusals.unauthenticated)).fetch)).rejects.toBeInstanceOf(SignInRefused);
  });

  it('reports other failures as passing, in plain words', async () => {
    const failure = sync(replay(once(refusals.serverError)).fetch);
    await expect(failure).rejects.toBeInstanceOf(SourceUnavailable);
    await expect(failure).rejects.toThrow('Linear couldn’t answer just now (HTTP 503).');
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    await expect(sync(offline)).rejects.toThrow('Commander couldn’t reach Linear.');
  });
});
