import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ChatDetail, ChatMessage, ChatReply, Item, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Replying to Teams Chats and their read state in the Item store (#106): both are the User's edits
// of a Chat's synced fields (`message:<clientId>` and `read`), queued for Teams in the same
// transaction (ADR 0003). A reply can be undone (cancelled) while it is still queued, never once it
// has reached Teams.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TEAMS = 'teams:tenant-1:u-sam';
const CHAT = '19:priya_sam@unq.gbl.spaces';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  clock = T;
  dir = mkdtempSync(join(tmpdir(), 'commander-replies-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const message = (id: string, at: number): ChatMessage => ({
  id,
  from: { userId: 'u-priya', name: 'Priya Patel' },
  event: null,
  createdAt: at,
  modifiedAt: at,
  deleted: false,
  text: `Message ${id}`,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});

// Priya's Chat with the User: two messages, unread unless `lastReadAt` says otherwise.
function chat(
  lastReadAt: number | null = null,
  messages = [message('m1', T - 10 * MIN), message('m2', T - 5 * MIN)],
) {
  const unread = messages.filter((each) => lastReadAt === null || each.createdAt > lastReadAt);
  const detail: ChatDetail = {
    kind: 'chat',
    chatType: 'one-on-one',
    topic: null,
    webUrl: null,
    members: [],
    lastReadAt,
    hidden: false,
    joinUrl: null,
    messages,
    unreadCount: unread.length,
    mentionsMe: false,
    latestFromMe: false,
    lastMessageAt: messages.at(-1)?.createdAt ?? null,
  };
  const item: SourceItem = { externalId: CHAT, kind: 'chat', title: 'Priya Patel', detail };
  return item;
}

function saved(item = chat()): Item {
  store.saveFromSource({ source: 'teams', account: TEAMS, items: [item], deleted: [] });
  const [found] = store.query({ kinds: ['chat'] });
  if (!found) throw new Error('No Chat saved');
  return found;
}

const detailOf = (itemId: string) => store.get(itemId)?.item.detail as ChatDetail;
const reply = (clientId: string, text = 'On it.'): ChatReply => ({ clientId, text, createdAt: clock });
const replyTo = (itemId: string, value: ChatReply) =>
  store.record({ type: 'edit-fields', itemId, fields: { [`message:${value.clientId}`]: value } }, user);
const queued = (itemId: string) =>
  store.outgoing.forItem(itemId).map(({ field, value, synced, madeAt, status }) => ({
    field,
    value,
    synced,
    madeAt,
    status,
  }));

describe('replying to a Chat', () => {
  it('shows the reply at once and queues it for Teams, with the time it was written', () => {
    const { id } = saved();
    clock = T + MIN;
    replyTo(id, reply('c1'));

    expect(detailOf(id).replies).toEqual([reply('c1')]);
    expect(queued(id)).toEqual([
      { field: 'message:c1', value: reply('c1'), synced: null, madeAt: T + MIN, status: 'pending' },
    ]);
  });

  it('refuses an empty reply', () => {
    const { id } = saved();
    expect(() => replyTo(id, reply('c1', '   '))).toThrow(/doesn't fit a chat Item/);
    expect(queued(id)).toEqual([]);
  });

  it('keeps a queued reply on top when Teams syncs before it has it', () => {
    const { id } = saved();
    replyTo(id, reply('c1'));
    saved(chat(null, [message('m1', T - 10 * MIN), message('m2', T - 5 * MIN), message('m3', T + MIN)]));

    expect(detailOf(id).messages.map((each) => each.id)).toEqual(['m1', 'm2', 'm3']);
    expect(detailOf(id).replies).toEqual([reply('c1')]);
  });

  it('cancels a reply still queued when it is undone, so nothing goes to Teams', () => {
    const { id } = saved();
    const entry = replyTo(id, reply('c1'));
    store.outgoing.fail(
      store.outgoing.forItem(id).map((row) => row.id),
      { error: 'Offline', failed: true, nextAttemptAt: null },
    );

    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(detailOf(id).replies).toBeUndefined();
    expect(queued(id)).toEqual([]);
  });

  it('can’t undo a reply once it is on its way, or once Teams has it', () => {
    const { id } = saved();
    const entry = replyTo(id, reply('c1'));
    const ids = store.outgoing.forItem(id).map((row) => row.id);
    store.outgoing.markSending(ids, T);
    expect(() => store.record({ type: 'undo', entryId: entry.id }, user)).toThrow(/on its way to Teams/);

    store.outgoing.settle(ids);
    expect(() => store.record({ type: 'undo', entryId: entry.id }, user)).toThrow(
      /Sent to Teams: a message that reached other people can’t be recalled/,
    );
    expect(detailOf(id).replies).toEqual([reply('c1')]);
  });

  it('is the User’s alone to send: Ares or a Rule can never queue one (Ares only drafts)', () => {
    const { id } = saved();
    const fields = { 'message:c1': reply('c1') };
    for (const by of [{ kind: 'ares' }, { kind: 'rule', ruleId: 'rule-1' }] as const) {
      expect(() => store.record({ type: 'edit-fields', itemId: id, fields }, { by })).toThrow(
        /Only you can send a message to Teams/,
      );
    }
    expect(queued(id)).toEqual([]);
    // Reading a Chat isn't sending anything.
    store.record({ type: 'edit-fields', itemId: id, fields: { read: true } }, { by: { kind: 'ares' } });
    expect(queued(id)).toHaveLength(1);
  });

  it('logs the reply whole, but not the Chat’s messages it left alone', () => {
    const { id } = saved();
    const entry = replyTo(id, reply('c1'));
    const [logged] = store.activity({ itemId: id }).filter((each) => each.id === entry.id);
    const detail = logged?.changes.find((change) => change.field === 'detail');

    expect(detail).toMatchObject({
      before: { messages: [] },
      after: { messages: [], replies: [reply('c1')] },
    });
  });
});

describe('a Chat’s read state', () => {
  it('reads it to its latest message, queued for Teams, and undo queues it unread again', () => {
    const { id } = saved();
    clock = T + MIN;
    const entry = store.record({ type: 'edit-fields', itemId: id, fields: { read: true } }, user);

    expect(detailOf(id)).toMatchObject({ unreadCount: 0, lastReadAt: T - 5 * MIN });
    expect(queued(id)).toEqual([
      { field: 'read', value: true, synced: false, madeAt: T + MIN, status: 'pending' },
    ]);

    // Teams has it read now.
    store.outgoing.settle(store.outgoing.forItem(id).map((row) => row.id));
    saved(chat(T + MIN));
    clock = T + 2 * MIN;
    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(detailOf(id)).toMatchObject({ unreadCount: 1, lastReadAt: T - 5 * MIN - 1 });
    expect(queued(id)).toEqual([
      { field: 'read', value: false, synced: true, madeAt: T + 2 * MIN, status: 'pending' },
    ]);
  });

  it('sends nothing when it is undone before Teams had it', () => {
    const { id } = saved();
    const entry = store.record({ type: 'edit-fields', itemId: id, fields: { read: true } }, user);
    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(queued(id)).toEqual([]);
  });
});

describe('the outgoing queue', () => {
  it('remembers when a change was first on its way, so a retry can tell its outcome may be unknown', () => {
    const { id } = saved();
    replyTo(id, reply('c1'));
    const ids = store.outgoing.forItem(id).map((row) => row.id);
    expect(store.outgoing.forItem(id)[0]?.attemptedAt).toBeNull();

    store.outgoing.markSending(ids, T + MIN);
    store.outgoing.resetSending();
    store.outgoing.markSending(ids, T + 2 * MIN);

    expect(store.outgoing.forItem(id)[0]?.attemptedAt).toBe(T + MIN);
  });
});
