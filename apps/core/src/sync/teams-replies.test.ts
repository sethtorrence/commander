import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatDetail, ChatReply } from '@commander/domain';
import { createTeamsSource } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, MAX_WRITE_ATTEMPTS, type SyncEngine, WRITE_BACKOFF_BASE_MS } from './engine';

// Replies to Teams Chats and their read state through the sync engine's interface (#106): the User's
// changes are recorded through the Item store (as the window does) and the engine sends them with the
// real Teams adapter, against a stand-in for Microsoft Graph on a fake clock and a real Item store.
// Graph takes no idempotency key, so the tests that matter most here are the ones where the answer to
// a post never arrives.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const GRAPH = 'https://graph.test/v1.0';
const TEAMS = 'teams:tenant-1:u-sam';
const CHAT = '19:priya_sam@unq.gbl.spaces';
const SAM = { id: 'u-sam', displayName: 'Sam Rivera' };
const PRIYA = { id: 'u-priya', displayName: 'Priya Patel' };

type Person = typeof SAM;
type Message = { id: string; from: Person; html: string; createdAt: number };
// What the next post of a message does: Graph takes it and answers; takes it and the connection drops
// before the answer; takes it and never answers; or fails (HTTP 500).
type Posting = 'ok' | 'drop' | 'hang' | 'fail';

// Microsoft Graph, as far as Teams sync and write-back use it, for one Chat between Sam and Priya.
function fakeGraph() {
  const messages: Message[] = [];
  let readAt: number | null = null;
  let next = 0;
  const postings: Posting[] = [];
  // Runs when the next post arrives, before Graph answers it.
  let duringPost: (() => void) | null = null;
  const posted: { path: string; body: Record<string, unknown> }[] = [];

  const iso = (time: number) => new Date(time).toISOString();
  const identity = (person: Person) => ({ user: { id: person.id, displayName: person.displayName } });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const toGraph = (message: Message) => ({
    id: message.id,
    messageType: 'message',
    createdDateTime: iso(message.createdAt),
    lastModifiedDateTime: iso(message.createdAt),
    from: identity(message.from),
    body: { contentType: 'html', content: message.html },
  });
  const chat = () => {
    const last = messages.at(-1);
    return {
      id: CHAT,
      topic: null,
      chatType: 'oneOnOne',
      lastUpdatedDateTime: iso(T0 - 7 * 24 * 60 * MIN),
      viewpoint: { isHidden: false, lastMessageReadDateTime: readAt === null ? null : iso(readAt) },
      lastMessagePreview: last && {
        id: last.id,
        createdDateTime: iso(last.createdAt),
        isDeleted: false,
        from: identity(last.from),
      },
    };
  };
  const say = (from: Person, html: string, at = Date.now()) => {
    next += 1;
    const message = { id: String(at + next), from, html, createdAt: at };
    messages.push(message);
    return message;
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.slice(new URL(GRAPH).pathname.length));
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posted.push({ path, body });
      duringPost?.();
      duringPost = null;
      if (path === `/chats/${CHAT}/messages`) {
        const posting = postings.shift() ?? 'ok';
        if (posting === 'fail') return json(500, { error: { code: 'InternalServerError' } });
        const content = (body.body as { content: string }).content;
        const message = say(SAM, content);
        if (posting === 'drop') throw new TypeError('fetch failed: socket hang up');
        if (posting === 'hang') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        }
        return json(201, toGraph(message));
      }
      if (path === `/chats/${CHAT}/markChatReadForUser`) {
        readAt = Date.now();
        return new Response(null, { status: 204 });
      }
      if (path === `/chats/${CHAT}/markChatUnreadForUser`) {
        readAt = Date.parse(String(body.lastMessageReadDateTime));
        return new Response(null, { status: 204 });
      }
      return json(404, { error: { code: 'NotFound' } });
    }
    if (path === '/me/chats') return json(200, { value: [chat()] });
    if (path === `/chats/${CHAT}`) return json(200, chat());
    if (path === `/chats/${CHAT}/members`) {
      return json(200, {
        value: [SAM, PRIYA].map((person) => ({ userId: person.id, displayName: person.displayName })),
      });
    }
    if (path === `/chats/${CHAT}/messages`) {
      const since = Date.parse(/gt (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1] ?? '');
      const value = messages
        .filter((message) => Number.isNaN(since) || message.createdAt > since)
        .reverse()
        .map(toGraph);
      return json(200, { value });
    }
    return json(404, { error: { code: 'NotFound' } });
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    messages,
    posted,
    say,
    readAt: () => readAt,
    readInTeams: (at = Date.now()) => {
      readAt = at;
    },
    // The next posts of a message do this, in order; then they go through.
    nextPosts: (...each: Posting[]) => postings.push(...each),
    whilePosting: (run: () => void) => {
      duringPost = run;
    },
    messagePosts: () => posted.filter((post) => post.path === `/chats/${CHAT}/messages`),
  };
}

let dir: string;
let store: ItemStore;
let graph: ReturnType<typeof fakeGraph>;
let engine: SyncEngine;
const engines: SyncEngine[] = [];

function openStore() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
}

// Starts the Core's sync engine (again, after a restart) with the Account connected.
function start(online = true) {
  const started = createSyncEngine({
    store,
    adapters: [
      createTeamsSource({
        graphUrl: () => GRAPH,
        fetch: graph.fetch,
        now: () => Date.now(),
        sleep: async () => {},
      }),
    ],
    accessTokens: { request: async () => ({ token: 'ms_access_token', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engines.push(started);
  started.setSystemState({ awake: true, online });
  started.setAccounts([{ id: TEAMS, source: 'teams', needsReconnect: false, me: SAM.id }]);
  return started;
}

// Quits Commander in the middle of whatever it was doing, and starts it again.
async function restart(online = true) {
  for (const each of engines.splice(0)) each.stop();
  store.close();
  store = openStore();
  engine = start(online);
  await vi.advanceTimersByTimeAsync(1);
}

const chatId = () => store.query({ kinds: ['chat'] })[0]?.id as string;
const local = () => store.get(chatId())?.item.detail as ChatDetail;
const user = { by: { kind: 'user' as const } };
let replies = 0;
function reply(text: string) {
  replies += 1;
  const value: ChatReply = { clientId: `client-${replies}`, text, createdAt: Date.now() };
  return store.record(
    { type: 'edit-fields', itemId: chatId(), fields: { [`message:${value.clientId}`]: value } },
    user,
  );
}
const queue = () => store.outgoing.list({ itemIds: [chatId()] });
const mine = () => local().messages.filter((message) => message.from?.userId === SAM.id);

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-teams-replies-'));
  store = openStore();
  graph = fakeGraph();
  graph.say(PRIYA, '<p>Morning! Can you look at the rollout plan?</p>', T0 - 30 * MIN);
  engine = start();
  await vi.advanceTimersByTimeAsync(1);
  expect(local().unreadCount).toBe(1);
});

afterEach(() => {
  for (const each of engines.splice(0)) each.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('a reply', () => {
  it('shows at once as on its way, reaches Teams as escaped HTML, then shows under Teams’s id', async () => {
    reply('On it <b>now</b> & back at 3');
    expect(local().replies?.map((each) => each.text)).toEqual(['On it <b>now</b> & back at 3']);
    expect(queue()).toEqual([expect.objectContaining({ field: 'message:client-1', status: 'pending' })]);

    await vi.advanceTimersByTimeAsync(1);

    expect(graph.messagePosts().map((post) => post.body)).toEqual([
      { body: { contentType: 'html', content: 'On it &lt;b&gt;now&lt;/b&gt; &amp; back at 3' } },
    ]);
    expect(queue()).toEqual([]);
    expect(local().replies).toBeUndefined();
    expect(mine().map((message) => [message.id, message.text])).toEqual([
      [graph.messages.at(-1)?.id, 'On it <b>now</b> & back at 3'],
    ]);
  });

  it('written offline keeps its time, survives a restart and goes on reconnect, once', async () => {
    engine.setSystemState({ awake: true, online: false });
    const writtenAt = Date.now();
    reply('Written on the train');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(graph.messagePosts()).toEqual([]);

    await restart(false);
    expect(local().replies?.map((each) => each.text)).toEqual(['Written on the train']);
    expect(queue()).toEqual([expect.objectContaining({ madeAt: writtenAt, status: 'pending' })]);

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(graph.messagePosts()).toHaveLength(1);
    expect(mine().map((message) => message.text)).toEqual(['Written on the train']);
    expect(queue()).toEqual([]);
  });

  it('is never posted twice when Teams took it but the answer was lost', async () => {
    graph.nextPosts('drop');
    reply('Shipping it');
    await vi.advanceTimersByTimeAsync(1);
    expect(graph.messages.filter((message) => message.from === SAM)).toHaveLength(1);
    expect(queue()).toEqual([expect.objectContaining({ status: 'pending', attempts: 1 })]);

    await vi.advanceTimersByTimeAsync(WRITE_BACKOFF_BASE_MS);

    expect(graph.messagePosts()).toHaveLength(1);
    expect(graph.messages.filter((message) => message.from === SAM)).toHaveLength(1);
    expect(queue()).toEqual([]);
    expect(mine().map((message) => [message.id, message.text])).toEqual([
      [graph.messages.at(-1)?.id, 'Shipping it'],
    ]);
  });

  it('is never posted twice when Commander quit between Teams taking it and hearing back', async () => {
    graph.nextPosts('hang');
    reply('Shipping it');
    await vi.advanceTimersByTimeAsync(1);
    expect(graph.messagePosts()).toHaveLength(1);
    expect(queue()).toEqual([expect.objectContaining({ status: 'sending' })]);

    await restart();

    expect(graph.messagePosts()).toHaveLength(1);
    expect(queue()).toEqual([]);
    expect(mine().map((message) => message.text)).toEqual(['Shipping it']);
  });

  it('is posted again when the attempt that failed never reached Teams', async () => {
    graph.nextPosts('fail');
    reply('Shipping it');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(WRITE_BACKOFF_BASE_MS);

    expect(graph.messagePosts()).toHaveLength(2);
    expect(mine().map((message) => message.text)).toEqual(['Shipping it']);
  });

  it('stops as Couldn’t sync after repeated failure, and Retry sends it', async () => {
    graph.nextPosts(...Array<Posting>(MAX_WRITE_ATTEMPTS).fill('fail'));
    reply('Shipping it');
    await vi.advanceTimersByTimeAsync(1);
    for (let attempt = 1; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(WRITE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    expect(queue()).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: 'Microsoft Teams couldn’t answer just now (HTTP 500).',
      }),
    ]);
    expect(local().replies?.map((each) => each.text)).toEqual(['Shipping it']);

    store.outgoing.retry(chatId());
    await vi.advanceTimersByTimeAsync(1);

    expect(queue()).toEqual([]);
    expect(mine().map((message) => message.text)).toEqual(['Shipping it']);
  });

  it('can be cancelled while it waits, and then never reaches Teams', async () => {
    engine.setSystemState({ awake: true, online: false });
    const entry = reply('Never mind');
    store.record({ type: 'undo', entryId: entry.id }, user);
    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(1);

    expect(graph.messagePosts()).toEqual([]);
    expect(local().replies).toBeUndefined();
  });

  it('can’t be undone once Teams has it', async () => {
    const entry = reply('Shipping it');
    await vi.advanceTimersByTimeAsync(1);

    expect(() => store.record({ type: 'undo', entryId: entry.id }, user)).toThrow(/Sent to Teams/);
    expect(mine()).toHaveLength(1);
  });
});

describe('a Chat excluded while a change to it is on its way', () => {
  it('stays out of Commander when the answer arrives', async () => {
    graph.whilePosting(() =>
      store.chatSettings.change({ account: TEAMS, chatId: CHAT, change: 'exclude' }, user),
    );
    reply('Shipping it');
    await vi.advanceTimersByTimeAsync(1);

    expect(graph.messagePosts()).toHaveLength(1);
    expect(store.query({ kinds: ['chat'] })).toEqual([]);
    expect(store.outgoing.list({ account: TEAMS })).toEqual([]);
  });
});

describe('a Chat’s read state', () => {
  const read = (value: boolean) =>
    store.record({ type: 'edit-fields', itemId: chatId(), fields: { read: value } }, user);

  it('reads the Chat in Teams when the User reads it here, and undo marks it unread again', async () => {
    const entry = read(true);
    expect(local().unreadCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(graph.posted.at(-1)).toEqual({
      path: `/chats/${CHAT}/markChatReadForUser`,
      body: { user: { id: SAM.id, tenantId: 'tenant-1' } },
    });
    expect(graph.readAt()).toBe(T0 + 1);
    expect(local().unreadCount).toBe(0);

    await vi.advanceTimersByTimeAsync(MIN);
    store.record({ type: 'undo', entryId: entry.id }, user);
    await vi.advanceTimersByTimeAsync(1);

    expect(graph.posted.at(-1)).toEqual({
      path: `/chats/${CHAT}/markChatUnreadForUser`,
      body: {
        user: { id: SAM.id, tenantId: 'tenant-1' },
        lastMessageReadDateTime: new Date(T0 - 30 * MIN - 1).toISOString(),
      },
    });
    expect(local().unreadCount).toBe(1);
    expect(queue()).toEqual([]);
  });

  it('follows Teams when it is read there, and a newer read in Teams wins over the User’s change', async () => {
    graph.readInTeams();
    await engine.refresh(TEAMS);
    expect(local().unreadCount).toBe(0);

    // Marked unread here while offline; read again in Teams after that.
    engine.setSystemState({ awake: true, online: false });
    read(false);
    expect(local().unreadCount).toBe(1);
    await vi.advanceTimersByTimeAsync(MIN);
    graph.readInTeams();
    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(1);

    expect(graph.posted.filter((post) => post.path.endsWith('ForUser'))).toEqual([]);
    expect(local().unreadCount).toBe(0);
    expect(queue()).toEqual([]);
    const [note] = store
      .activity({ itemId: chatId() })
      .filter((entry) => entry.by.kind === 'source' && entry.why);
    expect(note?.why).toMatch(/^Changed in Teams at \d\d:\d\d$/);
  });
});
