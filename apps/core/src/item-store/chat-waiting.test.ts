import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ChatDetail, ChatMessage, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Ares's waiting flags on Teams Chats (#109), as the Item store keeps them: a flag decorates its
// Chat wherever the Chat is read, goes when the User replies or Ares judges it no longer waiting,
// and the User can clear it by hand: a correction in the activity log, undone like any change.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TEAMS = 'teams:tenant-1:u-sam';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 9);
const REASON = 'Omar asked whether you can sign off the TL release today';

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-chat-waiting-'));
  clock = T;
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

const message = (id: string, text: string): ChatMessage => ({
  id,
  from: { userId: 'u-omar', name: 'Omar Haddad' },
  event: null,
  createdAt: T - 60_000,
  modifiedAt: T - 60_000,
  deleted: false,
  text,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
});

function chat(chatId: string, title: string): SourceItem {
  const messages = [message('m1', 'Can Sam sign off the TL release today?')];
  const detail: ChatDetail = {
    kind: 'chat',
    chatType: 'group',
    topic: title,
    webUrl: null,
    members: [],
    lastReadAt: null,
    hidden: false,
    joinUrl: null,
    messages,
    unreadCount: 1,
    mentionsMe: false,
    latestFromMe: false,
    lastMessageAt: T - 60_000,
  };
  return { externalId: chatId, kind: 'chat', title, detail };
}

function saveChat(): string {
  const [saved] = store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [chat('19:titanlink@thread.v2', 'Titanlink eng')],
  }).created;
  return saved as string;
}

const read = (itemId: string) => store.get(itemId)?.item;

describe('Ares’s waiting flag on a Chat', () => {
  it('decorates the Chat wherever it is read, and goes when Ares judges it no longer waiting', () => {
    const id = saveChat();
    expect(store.chatWaiting.flag(id, { messageId: 'm1', reason: REASON }, T)).toBe(true);

    expect(read(id)?.waiting).toEqual({ messageId: 'm1', reason: REASON, at: T });
    expect(store.query({ kinds: ['chat'] })[0]?.waiting).toEqual({ messageId: 'm1', reason: REASON, at: T });
    expect(store.chatWaiting.flagged()).toEqual([{ itemId: id, messageId: 'm1', reason: REASON, at: T }]);

    expect(store.chatWaiting.clear(id, 'ares', T + 1)).toBe(true);
    expect(read(id)?.waiting).toBeUndefined();
    expect(store.chatWaiting.clear(id, 'reply', T + 2)).toBe(false);
    // Neither is a change to the Item: nothing in its activity log beyond its arrival.
    expect(store.activity({ itemId: id }).map((entry) => entry.action)).toEqual(['create']);
  });

  it('remembers how far Ares has read each Chat', () => {
    const id = saveChat();
    expect(store.chatWaiting.judgedThrough(id)).toBeNull();
    store.chatWaiting.judged(id, T - 60_000);
    expect(store.chatWaiting.judgedThrough(id)).toBe(T - 60_000);
  });

  it('cleared by hand: a correction by the User, undone and redone like any change', () => {
    const id = saveChat();
    store.chatWaiting.flag(id, { messageId: 'm1', reason: REASON }, T);
    clock = T + 1000;

    const correction = store.chatWaiting.clearByUser(id, user);
    expect(correction).toMatchObject({
      action: 'correction',
      by: { kind: 'user' },
      itemId: id,
      why: 'Not waiting on you',
      changes: [],
    });
    expect(read(id)?.waiting).toBeUndefined();
    // Not an answer to his filing: his filing record and its examples leave it out.
    expect(store.filing.record().corrected).toBe(0);
    expect(store.filing.feedback()).toEqual([]);

    const undone = store.record({ type: 'undo', entryId: correction.id }, user);
    expect(undone).toMatchObject({ action: 'undo', undoes: correction.id, itemId: id, changes: [] });
    expect(read(id)?.waiting).toEqual({ messageId: 'm1', reason: REASON, at: T });
    expect(store.undone([correction.id])).toEqual([correction.id]);

    // Redo: cleared again.
    store.record({ type: 'undo', entryId: undone.id }, user);
    expect(read(id)?.waiting).toBeUndefined();
    expect(() => store.record({ type: 'undo', entryId: correction.id }, user)).toThrow(/already undone/);
  });

  it('never flags a message again once the User said it isn’t waiting on them', () => {
    const id = saveChat();
    store.chatWaiting.flag(id, { messageId: 'm1', reason: REASON }, T);
    store.chatWaiting.clearByUser(id, user);
    expect(store.chatWaiting.flag(id, { messageId: 'm1', reason: 'Still waiting' }, T + 1)).toBe(false);
    expect(read(id)?.waiting).toBeUndefined();
    expect(store.chatWaiting.flag(id, { messageId: 'm2', reason: 'Omar asked again' }, T + 2)).toBe(true);
  });

  it('refuses clearing a Chat with no flag standing', () => {
    const id = saveChat();
    expect(() => store.chatWaiting.clearByUser(id, user)).toThrow(/isn’t marked as waiting/);
  });
});
