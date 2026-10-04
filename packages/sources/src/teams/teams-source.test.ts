import type { ChatDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessToken,
  RateLimited,
  SignInRefused,
  SourceUnavailable,
  type StoredItem,
  type SyncMode,
  type SyncPage,
} from '../source';
import check from './recorded/check.json';
import daily from './recorded/daily.json';
import firstSync from './recorded/first-sync.json';
import { type ChatMark, createTeamsSource, TEAMS_CADENCE, type TeamsCursor } from './teams-source';

// The Teams adapter against recorded Microsoft Graph responses (shaped exactly as Graph answers,
// with `{graph}` standing for Graph's base in the links it gives). Each recording also pins down the
// request Commander must send for it, in order.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { path: string }; response: Recorded };

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const ME = 'u-sam';
const token: AccessToken = { token: 'ms_access_recorded', kind: 'oauth' };

const PRIYA_CHAT = '19:priya_sam@unq.gbl.spaces';
const LAUNCH = '19:launch@thread.v2';
const STANDUP = '19:meeting_standup@thread.v2';
const OLD = '19:old@thread.v2';

let clock: number;
// Every request sent: its path under Graph (decoded), when, and with what authorization.
let sent: { path: string; at: number; authorization: string | null }[];
// What the Item store holds, as the adapter's `stored` reads it.
let held: Map<string, SourceItem>;
// Requests no recording expected.
let unexpected: string[];

beforeEach(() => {
  clock = NOW;
  sent = [];
  held = new Map();
  unexpected = [];
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

function respond({ status, headers, body }: Recorded) {
  const text = body === null ? '' : JSON.stringify(body).replaceAll('{graph}', GRAPH);
  return new Response(text, { status, headers });
}

// Answers each request with the next recording, after checking it is the request recorded.
function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    sent.push({ path, at: clock, authorization: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    // The adapter takes a failing fetch for Graph being unreachable, so a wrong request is kept to fail the test.
    if (next?.request.path !== path) {
      unexpected.push(path);
      throw new Error(`Unexpected request ${path}`);
    }
    return respond(next.response);
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

async function sync(
  fetch: typeof globalThis.fetch,
  {
    cursor = null,
    mode = 'light',
    messagesPerChat,
    excluded,
  }: { cursor?: unknown; mode?: SyncMode; messagesPerChat?: number; excluded?: string[] } = {},
) {
  const pages: SyncPage[] = [];
  // Every sync starts at NOW; pacing moves the clock on within it.
  clock = NOW;
  const source = createTeamsSource({
    graphUrl: () => GRAPH,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    messagesPerChat,
  });
  const result = await source.sync({
    account: 'teams:fake-tenant:u-sam',
    cursor,
    mode,
    me: ME,
    stored: (ids) =>
      ids.flatMap((id): StoredItem[] => {
        const item = held.get(id);
        return item
          ? [
              {
                externalId: id,
                title: item.title,
                people: item.people ?? [],
                status: 'open',
                detail: item.detail ?? null,
              },
            ]
          : [];
      }),
    accessToken: async () => token,
    excluded,
    save: (page) => {
      pages.push(page);
      for (const item of page.items) held.set(item.externalId, item);
      for (const id of page.deleted) held.delete(id);
    },
    signal: new AbortController().signal,
  });
  return { result, pages, items: pages.flatMap((page) => page.items) };
}

const byId = (items: SourceItem[], externalId: string) =>
  items.find((item) => item.externalId === externalId);
const chatOf = (item: SourceItem | undefined) => item?.detail as ChatDetail;
const messageTexts = (item: SourceItem | undefined) => chatOf(item).messages.map((message) => message.text);

async function afterFirstSync() {
  const { result } = await sync(replay(firstSync as Exchange[]).fetch, { mode: 'full' });
  sent = [];
  return result.cursor as TeamsCursor;
}

// What the cursor holds for a Chat Commander already knew, from its entry in a list response.
function markFor(exchanges: Exchange[], chatId: string, seen: number): ChatMark {
  const body = exchanges[0]?.response.body as { value: Record<string, never>[] };
  const chat = body.value.find((each) => each.id === chatId) as unknown as {
    lastUpdatedDateTime: string;
    viewpoint: { isHidden: boolean; lastMessageReadDateTime: string };
    lastMessagePreview: { id: string; createdDateTime: string };
  };
  return {
    updated: Date.parse(chat.lastUpdatedDateTime),
    last: Date.parse(chat.lastMessagePreview.createdDateTime),
    lastId: chat.lastMessagePreview.id,
    read: Date.parse(chat.viewpoint.lastMessageReadDateTime),
    hidden: chat.viewpoint.isHidden,
    seen,
  };
}

// A Chat Commander holds with no recent messages.
const quietChat = (topic: string): ChatDetail => ({
  kind: 'chat',
  chatType: 'group',
  topic,
  webUrl: null,
  members: [],
  lastReadAt: null,
  hidden: false,
  joinUrl: null,
  messages: [],
  unreadCount: 0,
  mentionsMe: false,
  latestFromMe: false,
  lastMessageAt: null,
});

// The cursor after the first sync, plus Chats Commander had already seen that it didn't bring
// (two quiet ones, and one the User has since left).
async function cursorBeforeTheCheck(): Promise<TeamsCursor> {
  const cursor = await afterFirstSync();
  const design = markFor(check as Exchange[], '19:design@thread.v2', Date.UTC(2026, 8, 10, 11));
  const ops = markFor(check as Exchange[], '19:ops@thread.v2', Date.UTC(2026, 7, 1, 11));
  const left = { ...ops, lastId: 'gone' };
  for (const [id, title] of [
    ['19:design@thread.v2', 'Design reviews'],
    ['19:ops@thread.v2', 'Ops'],
    ['19:left@thread.v2', 'Left behind'],
  ] as const) {
    held.set(id, { externalId: id, kind: 'chat', title, detail: quietChat(title) });
  }
  return {
    chats: {
      ...cursor.chats,
      '19:design@thread.v2': design,
      '19:ops@thread.v2': ops,
      '19:left@thread.v2': left,
    },
  };
}

describe('the cadence', () => {
  it('syncs fully once a day, and checks whenever another Source syncs', () => {
    expect(TEAMS_CADENCE).toEqual({ defaultMinutes: 1440, choices: [1440], alsoAfterOtherSources: true });
  });
});

describe('Chats the User excluded', () => {
  const without = (chatId: string) =>
    (firstSync as Exchange[]).filter((exchange) => !exchange.request.path.startsWith(`/chats/${chatId}/`));

  it('fetches nothing for them, hands none over, and forgets them, so including one again fetches it afresh', async () => {
    const graph = replay(without(LAUNCH));
    const { items, pages, result } = await sync(graph.fetch, { mode: 'full', excluded: [LAUNCH] });

    expect(graph.remaining()).toBe(0);
    expect(items.map((item) => item.externalId)).toEqual([PRIYA_CHAT, STANDUP, OLD]);
    expect(pages.flatMap((page) => page.deleted)).toEqual([]);
    expect(Object.keys((result.cursor as TeamsCursor).chats)).not.toContain(LAUNCH);
  });

  it('drops one excluded since the last sync without treating it as left', async () => {
    const cursor = await afterFirstSync();
    const graph = replay(without(LAUNCH).slice(0, 2));
    const { pages, result } = await sync(graph.fetch, { cursor, mode: 'light', excluded: [LAUNCH] });

    expect(pages.flatMap((page) => page.items.map((item) => item.externalId))).not.toContain(LAUNCH);
    expect(pages.flatMap((page) => page.deleted)).toEqual([]);
    expect(Object.keys((result.cursor as TeamsCursor).chats)).not.toContain(LAUNCH);
  });
});

describe('the first sync', () => {
  it('lists every Chat page by page, reads who is in each, and fetches the last 30 days of messages from active ones', async () => {
    const graph = replay(firstSync as Exchange[]);
    const { items } = await sync(graph.fetch, { mode: 'full' });

    expect(graph.remaining()).toBe(0);
    expect(items.map((item) => [item.externalId, item.title])).toEqual([
      [PRIYA_CHAT, 'Priya Patel'],
      [LAUNCH, 'Launch crew'],
      [STANDUP, 'Daily standup'],
      [OLD, 'Lee Chen, Ana Gomez'],
    ]);
    expect(sent.every((each) => each.authorization === 'Bearer ms_access_recorded')).toBe(true);
  });

  it('turns a one-to-one Chat into a chat Item, with everyone in it as handles and its messages as plain text', async () => {
    const { items } = await sync(replay(firstSync as Exchange[]).fetch, { mode: 'full' });
    const sam = { userId: 'u-sam', name: 'Sam Rivera' };
    const priya = { userId: 'u-priya', name: 'Priya Patel' };

    expect(byId(items, PRIYA_CHAT)).toEqual({
      externalId: PRIYA_CHAT,
      kind: 'chat',
      title: 'Priya Patel',
      people: ['teams:u-sam', 'sam@contoso.test', 'teams:u-priya', 'priya.patel@contoso.test'],
      status: 'open',
      detail: {
        kind: 'chat',
        chatType: 'one-on-one',
        topic: null,
        webUrl: 'https://teams.microsoft.com/l/chat/19%3Apriya_sam%40unq.gbl.spaces/0?tenantId=fake-tenant',
        members: [
          { userId: 'u-sam', name: 'Sam Rivera', email: 'sam@contoso.test' },
          { userId: 'u-priya', name: 'Priya Patel', email: 'Priya.Patel@contoso.test' },
        ],
        lastReadAt: Date.UTC(2026, 9, 3, 9, 30),
        hidden: false,
        joinUrl: null,
        messages: [
          {
            id: String(Date.UTC(2026, 8, 20, 14)),
            from: priya,
            event: null,
            createdAt: Date.UTC(2026, 8, 20, 14),
            modifiedAt: Date.UTC(2026, 8, 21, 8),
            deleted: false,
            text: 'Enjoy the break!',
            mentions: [],
            reactions: [{ type: 'like', by: { userId: 'u-sam', name: '' } }],
            attachments: [],
            replyTo: null,
          },
          {
            id: String(Date.UTC(2026, 9, 3, 9)),
            from: sam,
            event: null,
            createdAt: Date.UTC(2026, 9, 3, 9),
            modifiedAt: Date.UTC(2026, 9, 3, 9),
            deleted: false,
            text: 'Morning! Back from leave.',
            mentions: [],
            reactions: [],
            attachments: [],
            replyTo: null,
          },
          {
            id: String(Date.UTC(2026, 9, 3, 10)),
            from: priya,
            event: null,
            createdAt: Date.UTC(2026, 9, 3, 10),
            modifiedAt: Date.UTC(2026, 9, 3, 10),
            deleted: false,
            text: '@Sam Rivera can you review the rollout plan (https://contoso.test/rollout)?',
            mentions: [sam],
            reactions: [],
            attachments: [],
            replyTo: null,
          },
        ],
        unreadCount: 1,
        mentionsMe: true,
        latestFromMe: false,
        lastMessageAt: Date.UTC(2026, 9, 3, 10),
      },
    });
  });

  it('keeps system events, deletions, files as links, inline images, lists and quoted replies', async () => {
    const { items } = await sync(replay(firstSync as Exchange[]).fetch, { mode: 'full' });
    const launch = chatOf(byId(items, LAUNCH));

    expect(launch.chatType).toBe('group');
    expect(
      launch.messages.map(({ from, event, deleted, text, attachments, replyTo }) => ({
        from: from?.name ?? null,
        event,
        deleted,
        text,
        attachments,
        replyTo,
      })),
    ).toEqual([
      { from: 'Priya Patel', event: null, deleted: true, text: '', attachments: [], replyTo: null },
      { from: null, event: 'members added', deleted: false, text: '', attachments: [], replyTo: null },
      {
        from: 'Priya Patel',
        event: null,
        deleted: false,
        text: 'Draft attached [image]',
        attachments: [
          {
            name: 'plan.docx',
            url: 'https://contoso.sharepoint.com/sites/launch/Shared%20Documents/plan.docx',
          },
        ],
        replyTo: null,
      },
      {
        from: 'Lee Chen',
        event: null,
        deleted: false,
        text: 'Launch moved to Thursday.\n\n- QA on Wednesday\n- Go on Thursday',
        attachments: [],
        replyTo: String(Date.UTC(2026, 8, 20, 11)),
      },
    ]);
    expect(launch).toMatchObject({ unreadCount: 1, latestFromMe: false, mentionsMe: false });
  });

  it('keeps a meeting Chat’s join link, guests, and hidden Chats with no recent messages', async () => {
    const { items } = await sync(replay(firstSync as Exchange[]).fetch, { mode: 'full' });

    expect(chatOf(byId(items, STANDUP))).toMatchObject({
      chatType: 'meeting',
      topic: 'Daily standup',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_standup%40thread.v2/0?context=%7b%7d',
    });
    expect(chatOf(byId(items, STANDUP)).members).toContainEqual({
      userId: null,
      name: 'Jordan (Guest)',
      email: null,
    });
    expect(byId(items, STANDUP)?.people).not.toContain('teams:null');
    expect(chatOf(byId(items, OLD))).toMatchObject({
      hidden: true,
      messages: [],
      unreadCount: 0,
      lastMessageAt: null,
    });
  });

  it('asks for no more than one request a second per Chat, and reports what it cost', async () => {
    const { result } = await sync(replay(firstSync as Exchange[]).fetch, { mode: 'full' });
    const priyaChat = sent
      .filter((each) => each.path.startsWith(`/chats/${PRIYA_CHAT}/`))
      .map((each) => each.at);

    expect(priyaChat).toHaveLength(3);
    for (let i = 1; i < priyaChat.length; i++) {
      expect((priyaChat[i] ?? 0) - (priyaChat[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
    expect(result.cost).toEqual({ requests: 10, complexity: null });
  });

  it('keeps only the newest messages of a busy Chat, and stops fetching once it has them', async () => {
    const chatId = '19:busy@thread.v2';
    const iso = (minute: number) => new Date(NOW - minute * 60_000).toISOString();
    const message = (minute: number) => ({
      id: `m-${minute}`,
      messageType: 'message',
      createdDateTime: iso(minute),
      lastModifiedDateTime: iso(minute),
      from: { user: { id: 'u-lee', displayName: 'Lee Chen' } },
      body: { contentType: 'text', content: `Message ${minute} minutes ago` },
    });
    let pagesServed = 0;
    const fetch = (async (url: string | URL | Request) => {
      const path = decodeURIComponent(String(url).slice(GRAPH.length));
      sent.push({ path, at: clock, authorization: null });
      if (path.startsWith('/me/chats')) {
        return respond({
          status: 200,
          headers: {},
          body: {
            value: [
              {
                id: chatId,
                topic: 'Busy',
                chatType: 'group',
                lastUpdatedDateTime: iso(10_000),
                lastMessagePreview: { id: 'm-0', createdDateTime: iso(0) },
              },
            ],
          },
        });
      }
      if (path.endsWith('/members')) return respond({ status: 200, headers: {}, body: { value: [] } });
      const page = pagesServed++;
      return respond({
        status: 200,
        headers: {},
        body: {
          value: Array.from({ length: 50 }, (_, i) => message(page * 50 + i)),
          '@odata.nextLink': `{graph}/chats/${chatId}/messages?$skiptoken=${page + 1}`,
        },
      });
    }) as typeof globalThis.fetch;

    const { items } = await sync(fetch, { mode: 'full', messagesPerChat: 120 });

    expect(pagesServed).toBe(3);
    const texts = messageTexts(byId(items, chatId));
    expect(texts).toHaveLength(120);
    expect(texts.at(-1)).toBe('Message 0 minutes ago');
    expect(texts[0]).toBe('Message 119 minutes ago');
  });
});

describe('the check (a light sync)', () => {
  it('makes the one Chat-list request plus message requests for just the two Chats that changed', async () => {
    const cursor = await cursorBeforeTheCheck();
    const graph = replay(check as Exchange[]);
    const { pages, items, result } = await sync(graph.fetch, { cursor, mode: 'light' });

    expect(graph.remaining()).toBe(0);
    expect(sent.map((each) => each.path.split('?')[0])).toEqual([
      '/me/chats',
      `/chats/${PRIYA_CHAT}/messages`,
      `/chats/${LAUNCH}/messages`,
    ]);
    expect(items.map((item) => item.externalId)).toEqual([PRIYA_CHAT, LAUNCH]);
    expect(result.cost.requests).toBe(3);
    expect(pages.flatMap((page) => page.deleted)).toEqual(['19:left@thread.v2']);
  });

  it('adds the new messages to those Commander has, and works out what is unread and mentions the User', async () => {
    const cursor = await cursorBeforeTheCheck();
    const { items } = await sync(replay(check as Exchange[]).fetch, { cursor, mode: 'light' });

    expect(messageTexts(byId(items, PRIYA_CHAT))).toEqual([
      'Enjoy the break!',
      'Morning! Back from leave.',
      '@Sam Rivera can you review the rollout plan (https://contoso.test/rollout)?',
      'Also, @Sam Rivera: ship it?',
    ]);
    expect(chatOf(byId(items, PRIYA_CHAT))).toMatchObject({
      unreadCount: 2,
      mentionsMe: true,
      latestFromMe: false,
    });
    expect(messageTexts(byId(items, LAUNCH)).at(-1)).toBe('On it.');
    expect(chatOf(byId(items, LAUNCH))).toMatchObject({ unreadCount: 1, latestFromMe: true });
  });

  it('moves the cursor on, so checking again with nothing new makes only the list request and saves nothing', async () => {
    const before = await cursorBeforeTheCheck();
    const { result } = await sync(replay(check as Exchange[]).fetch, { cursor: before, mode: 'light' });
    sent = [];

    const listOnly = [check[0] as Exchange];
    const again = await sync(replay(listOnly).fetch, { cursor: result.cursor, mode: 'light' });

    expect(sent).toHaveLength(1);
    expect(again.pages).toEqual([]);
    expect(again.result.cursor).toEqual(result.cursor);
    expect((result.cursor as TeamsCursor).chats[PRIYA_CHAT]?.seen).toBe(Date.UTC(2026, 9, 3, 11, 30));
    expect((result.cursor as TeamsCursor).chats['19:left@thread.v2']).toBeUndefined();
  });

  it('saves a Chat read or hidden in Teams again without fetching its messages', async () => {
    const before = await cursorBeforeTheCheck();
    const { result } = await sync(replay(check as Exchange[]).fetch, { cursor: before, mode: 'light' });
    sent = [];
    const list = structuredClone(check[0]) as Exchange;
    const body = list.response.body as {
      value: { id: string; viewpoint: { lastMessageReadDateTime: string } }[];
    };
    const priya = body.value.find((chat) => chat.id === PRIYA_CHAT);
    if (priya) priya.viewpoint.lastMessageReadDateTime = '2026-10-03T11:58:00.000Z';

    const { items } = await sync(replay([list]).fetch, { cursor: result.cursor, mode: 'light' });

    expect(sent).toHaveLength(1);
    expect(items.map((item) => item.externalId)).toEqual([PRIYA_CHAT]);
    expect(chatOf(byId(items, PRIYA_CHAT))).toMatchObject({ unreadCount: 0, mentionsMe: false });
    expect(messageTexts(byId(items, PRIYA_CHAT))).toHaveLength(4);
  });

  it('turns a Chat the User left into a tombstone', async () => {
    const cursor = await cursorBeforeTheCheck();
    const { pages } = await sync(replay(check as Exchange[]).fetch, { cursor, mode: 'light' });

    expect(pages.at(-1)).toEqual({ items: [], deleted: ['19:left@thread.v2'] });
  });
});

describe('the daily full sync', () => {
  async function cursorAfterTheCheck() {
    const cursor = await cursorBeforeTheCheck();
    const { result } = await sync(replay(check as Exchange[]).fetch, { cursor, mode: 'light' });
    sent = [];
    return result.cursor;
  }

  it('re-reads the last 7 days of Chats active in them, catching an edit and a reaction the check missed', async () => {
    const cursor = await cursorAfterTheCheck();
    const graph = replay(daily as Exchange[]);
    const { items } = await sync(graph.fetch, { cursor, mode: 'full' });

    expect(graph.remaining()).toBe(0);
    expect(sent.map((each) => each.path.split('?')[0])).toEqual([
      '/me/chats',
      `/chats/${PRIYA_CHAT}/messages`,
      `/chats/${LAUNCH}/messages`,
      `/chats/${STANDUP}/messages`,
    ]);
    const messages = chatOf(byId(items, PRIYA_CHAT)).messages;
    const edited = messages.find((message) => message.id === String(Date.UTC(2026, 9, 3, 10)));
    expect(edited?.text).toBe(
      '@Sam Rivera can you review the rollout plan v2 (https://contoso.test/rollout-v2)?',
    );
    expect(edited?.editedAt).toBe(Date.UTC(2026, 9, 3, 11, 50));
    // Reacted to, not edited.
    expect(
      messages.find((message) => message.id === String(Date.UTC(2026, 9, 3, 9)))?.editedAt,
    ).toBeUndefined();
    expect(messages.find((message) => message.id === String(Date.UTC(2026, 9, 3, 9)))?.reactions).toEqual([
      { type: 'heart', by: { userId: 'u-priya', name: '' } },
    ]);
    expect(messages).toHaveLength(4);
  });

  it('is never done by a light sync: the same list in a check makes no message requests', async () => {
    const cursor = await cursorAfterTheCheck();
    const { pages } = await sync(replay([daily[0] as Exchange]).fetch, { cursor, mode: 'light' });

    expect(sent).toHaveLength(1);
    expect(pages).toEqual([]);
  });
});

describe('throttling and sign-in', () => {
  const answer = (status: number, headers: Record<string, string> = {}) =>
    replay([
      {
        request: { path: '/me/chats?$expand=lastMessagePreview&$top=50' },
        response: { status, headers, body: { error: { code: 'x', message: 'y' } } },
      },
    ]);

  it('backs off at once on a 429, for as long as Retry-After says', async () => {
    const failure = await sync(answer(429, { 'retry-after': '120' }).fetch).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimited);
    expect(failure).toMatchObject({ retryAfterMs: 120_000, cost: { requests: 1 } });
  });

  it('treats a 503 with Retry-After as a rate limit too, and one without as Teams being down', async () => {
    const limited = await sync(answer(503, { 'retry-after': '30' }).fetch).catch((error: unknown) => error);
    const down = await sync(answer(503).fetch).catch((error: unknown) => error);

    expect(limited).toBeInstanceOf(RateLimited);
    expect(limited).toMatchObject({ retryAfterMs: 30_000 });
    expect(down).toBeInstanceOf(SourceUnavailable);
  });

  it('reports a refused sign-in, so the Account can be marked Reconnect', async () => {
    const failure = await sync(answer(401).fetch).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignInRefused);
  });

  it('never follows a next page link away from Graph', async () => {
    const graph = replay([
      {
        request: { path: '/me/chats?$expand=lastMessagePreview&$top=50' },
        response: {
          status: 200,
          headers: {},
          body: { value: [], '@odata.nextLink': 'https://evil.test/v1.0/me/chats' },
        },
      },
    ]);
    const failure = await sync(graph.fetch).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SourceUnavailable);
    expect(sent).toHaveLength(1);
  });
});
