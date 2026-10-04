import type { ChatDetail, ChatMessage, ChatReply, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessToken,
  type FieldChange,
  RateLimited,
  SignInRefused,
  SourceUnavailable,
  type StoredItem,
  WriteRejected,
} from '../source';
import recorded from './recorded/writes.json';
import { createTeamsSource } from './teams-source';

// Teams's write side (Two-way sync, #106) against recorded Microsoft Graph responses, shaped as Graph
// answers: a reply posted to a Chat as escaped HTML, never twice (Graph takes no idempotency key, so
// a retry after an unknown outcome looks for it first), and the Chat marked read or unread for the
// User, the newer change winning.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Sent = { method: string; path: string; body: unknown; authorization: string | null };

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const at = (hour: number, minute = 0, second = 0) => Date.UTC(2026, 9, 3, hour, minute, second);
const ACCOUNT = 'teams:fake-tenant:u-sam';
const CHAT = '19:priya_sam@unq.gbl.spaces';
const token: AccessToken = { token: 'ms_access_recorded', kind: 'oauth' };
const TEXT = 'On it <b>now</b> & back at 3 "sharp".\nThanks, Priya';
const ESCAPED = 'On it &lt;b&gt;now&lt;/b&gt; &amp; back at 3 &quot;sharp&quot;.<br>Thanks, Priya';

const CHAT_PATH = `/chats/${CHAT}?$expand=lastMessagePreview`;
const MESSAGES_PATH = `/chats/${CHAT}/messages`;
const newestSince = (time: number) =>
  `/chats/${CHAT}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt ${new Date(time).toISOString()}`;

let clock: number;
let sent: Sent[];
let unexpected: string[];

beforeEach(() => {
  clock = NOW;
  sent = [];
  unexpected = [];
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

const priyaAsks: ChatMessage = {
  id: '1791027000000',
  from: { userId: 'u-priya', name: 'Priya Patel' },
  event: null,
  createdAt: at(11, 30),
  modifiedAt: at(11, 30),
  deleted: false,
  text: 'Also, @Sam Rivera: ship it?',
  mentions: [{ userId: 'u-sam', name: 'Sam Rivera' }],
  reactions: [],
  attachments: [],
  replyTo: null,
};

// The Chat as Commander last saved it: Priya's question unread since 09:30.
const storedChat: ChatDetail = {
  kind: 'chat',
  chatType: 'one-on-one',
  topic: null,
  webUrl: 'https://teams.microsoft.com/l/chat/19%3Apriya_sam%40unq.gbl.spaces/0?tenantId=fake-tenant',
  members: [
    { userId: 'u-sam', name: 'Sam Rivera', email: 'sam@contoso.test' },
    { userId: 'u-priya', name: 'Priya Patel', email: 'priya@contoso.test' },
  ],
  lastReadAt: at(9, 30),
  hidden: false,
  joinUrl: null,
  messages: [priyaAsks],
  unreadCount: 1,
  mentionsMe: true,
  latestFromMe: false,
  lastMessageAt: at(11, 30),
};

// Answers each request with the next response, after checking it is the request expected.
function graph(...exchanges: [method: string, path: string, response: Recorded][]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ method, path, body, authorization: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (!next || next[0] !== method || next[1] !== path) {
      unexpected.push(`${method} ${path}`);
      throw new Error(`Unexpected request ${method} ${path}`);
    }
    const { status, headers, body: answer } = next[2];
    return new Response(answer === null ? null : JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

const dropped = async () => {
  throw new TypeError('fetch failed');
};

function write(
  fetch: typeof globalThis.fetch,
  changes: FieldChange[],
  { stored = storedChat as ChatDetail | null } = {},
) {
  const source = createTeamsSource({
    graphUrl: () => GRAPH,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  if (!source.write) throw new Error('The Teams adapter writes');
  return source.write({
    account: ACCOUNT,
    externalId: CHAT,
    changes,
    me: 'u-sam',
    stored: (ids) =>
      ids.flatMap((id): StoredItem[] =>
        id === CHAT && stored
          ? [{ externalId: id, title: 'Priya Patel', people: [], status: 'open', detail: stored }]
          : [],
      ),
    accessToken: async () => token,
    signal: new AbortController().signal,
  });
}

const reply = (clientId = 'c1', text = TEXT): ChatReply => ({ clientId, text, createdAt: at(11, 59) });
const replying = (value: ChatReply | null, attemptedAt: number | null = null): FieldChange => ({
  field: `message:${value?.clientId ?? 'c1'}`,
  value,
  synced: null,
  madeAt: at(11, 59),
  attemptedAt,
});
const reading = (read: boolean, madeAt = at(11, 59)): FieldChange => ({
  field: 'read',
  value: read,
  synced: !read,
  madeAt,
});
const chatOf = (item: SourceItem | null) => item?.detail as ChatDetail;
const posts = () => sent.filter((request) => request.method === 'POST');

describe('replying to a Chat', () => {
  it('posts the reply as escaped HTML, as the User, and hands back the Chat with it under Teams’s id', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat], ['POST', MESSAGES_PATH, recorded.messagePosted]);
    const result = await write(fake.fetch, [replying(reply())]);

    expect(posts()).toEqual([
      {
        method: 'POST',
        path: MESSAGES_PATH,
        body: { body: { contentType: 'html', content: ESCAPED } },
        authorization: 'Bearer ms_access_recorded',
      },
    ]);
    expect(result.superseded).toEqual([]);
    const detail = chatOf(result.item);
    expect(detail.messages.map((message) => [message.id, message.from?.name, message.text])).toEqual([
      ['1791027000000', 'Priya Patel', 'Also, @Sam Rivera: ship it?'],
      ['1791028805000', 'Sam Rivera', TEXT],
    ]);
    expect(detail.replies).toBeUndefined();
    expect(detail).toMatchObject({ latestFromMe: true, lastMessageAt: at(12, 0, 5) });
    expect(result.cost.requests).toBe(2);
  });

  it('never lets the text through as markup', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat], ['POST', MESSAGES_PATH, recorded.messagePosted]);
    await write(fake.fetch, [replying(reply('c1', `<img src=x onerror="alert('hi')"> <at id="0">Lee</at>`))]);

    expect(posts()[0]?.body).toEqual({
      body: {
        contentType: 'html',
        content:
          '&lt;img src=x onerror=&quot;alert(&#39;hi&#39;)&quot;&gt; &lt;at id=&quot;0&quot;&gt;Lee&lt;/at&gt;',
      },
    });
  });

  it('after an attempt whose outcome is unknown, finds the reply already in Teams and doesn’t post it again', async () => {
    const fake = graph(
      ['GET', CHAT_PATH, recorded.chat],
      ['GET', newestSince(at(11, 59)), recorded.newestWithTheReply],
    );
    const result = await write(fake.fetch, [replying(reply(), at(12))]);

    expect(posts()).toEqual([]);
    expect(chatOf(result.item).messages.map((message) => message.id)).toEqual([
      '1791027000000',
      '1791028805000',
    ]);
  });

  it('posts it after all when Teams has no such reply from the User since the first attempt', async () => {
    const fake = graph(
      ['GET', CHAT_PATH, recorded.chat],
      ['GET', newestSince(at(11, 59)), recorded.newestWithoutIt],
      ['POST', MESSAGES_PATH, recorded.messagePosted],
    );
    await write(fake.fetch, [replying(reply(), at(12))]);

    expect(posts().map((request) => request.path)).toEqual([MESSAGES_PATH]);
  });

  it('sends nothing for a reply taken back before it went', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat]);
    const result = await write(fake.fetch, [replying(null)]);

    expect(posts()).toEqual([]);
    expect(chatOf(result.item).messages).toHaveLength(1);
  });

  it('leaves the Chat for the next sync to save when Commander holds none of it', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat], ['POST', MESSAGES_PATH, recorded.messagePosted]);
    const result = await write(fake.fetch, [replying(reply())], { stored: null });

    expect(posts()).toHaveLength(1);
    expect(result.item).toBeNull();
  });

  it('refuses a reply that isn’t one', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat]);
    await expect(write(fake.fetch, [replying({ clientId: 'c1', text: '', createdAt: 1 })])).rejects.toThrow(
      WriteRejected,
    );
  });
});

describe('a Chat’s read state', () => {
  it('marks it read for the User, with their id and tenant, and hands back Teams’s read time', async () => {
    const fake = graph(
      ['GET', CHAT_PATH, recorded.chat],
      ['POST', `/chats/${CHAT}/markChatReadForUser`, recorded.noContent],
      ['GET', CHAT_PATH, recorded.chatAfterReading],
    );
    const result = await write(fake.fetch, [reading(true)]);

    expect(posts().map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: `/chats/${CHAT}/markChatReadForUser`,
        body: { user: { id: 'u-sam', tenantId: 'fake-tenant' } },
      },
    ]);
    expect(chatOf(result.item)).toMatchObject({ unreadCount: 0, lastReadAt: at(12, 0, 2) });
  });

  it('marks it unread from its latest message from someone else', async () => {
    const fake = graph(
      ['GET', CHAT_PATH, recorded.chatAfterReading],
      ['POST', `/chats/${CHAT}/markChatUnreadForUser`, recorded.noContent],
      ['GET', CHAT_PATH, recorded.chatAfterMarkingUnread],
    );
    const result = await write(fake.fetch, [reading(false, at(12, 1))], {
      stored: { ...storedChat, lastReadAt: at(12), unreadCount: 0, mentionsMe: false },
    });

    expect(posts()[0]?.body).toEqual({
      user: { id: 'u-sam', tenantId: 'fake-tenant' },
      lastMessageReadDateTime: '2026-10-03T11:29:59.999Z',
    });
    expect(chatOf(result.item)).toMatchObject({ unreadCount: 1 });
  });

  it('sends nothing when Teams already has it that way', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chatReadLaterInTeams]);
    const result = await write(fake.fetch, [reading(true, at(11, 40))]);

    expect(posts()).toEqual([]);
    expect(result.superseded).toEqual([]);
  });

  it('lets a newer read time in Teams win over the User’s change', async () => {
    // The User marked it unread at 11:40, then read it in Teams at 11:45.
    const unread = graph(['GET', CHAT_PATH, recorded.chatReadLaterInTeams]);
    const kept = await write(unread.fetch, [reading(false, at(11, 40))]);
    expect(kept.superseded).toEqual([{ field: 'read', by: null, at: at(11, 45) }]);
    expect(chatOf(kept.item)).toMatchObject({ unreadCount: 0, lastReadAt: at(11, 45) });

    // The User marked it read at 11:40, read it in Teams at 11:45, and Priya wrote again at 11:50.
    sent = [];
    const read = graph(['GET', CHAT_PATH, recorded.chatReadLaterInTeamsThenNewMessage]);
    const won = await write(read.fetch, [reading(true, at(11, 40))]);
    expect(posts()).toEqual([]);
    expect(won.superseded).toEqual([{ field: 'read', by: null, at: at(11, 45) }]);
  });
});

describe('what Teams refuses', () => {
  it.each([
    ['refuses the message', recorded.badRequest, WriteRejected],
    ['won’t let the User post there', recorded.forbidden, WriteRejected],
    ['no longer has the Chat', recorded.notFound, WriteRejected],
    ['asks Commander to slow down', recorded.throttled, RateLimited],
    ['refuses the sign-in', recorded.unauthorized, SignInRefused],
    ['is down', recorded.unavailable, SourceUnavailable],
  ])('rejects as the engine expects when Teams %s', async (_what, answer, error) => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat], ['POST', MESSAGES_PATH, answer]);
    await expect(write(fake.fetch, [replying(reply())])).rejects.toThrow(error);
  });

  it('counts a dropped connection as Teams being unreachable, to retry', async () => {
    let calls = 0;
    const fake = graph(['GET', CHAT_PATH, recorded.chat]);
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return calls === 1 ? fake.fetch(url, init) : dropped();
    }) as typeof globalThis.fetch;
    await expect(write(fetch, [replying(reply())])).rejects.toThrow(SourceUnavailable);
  });

  it('honours Retry-After', async () => {
    const fake = graph(['GET', CHAT_PATH, recorded.chat], ['POST', MESSAGES_PATH, recorded.throttled]);
    const error = await write(fake.fetch, [replying(reply())]).catch((caught) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(30_000);
  });
});
