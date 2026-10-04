import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ChatDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Muting and excluding Teams Chats (#105): Commander settings kept by Account and Chat, which the
// Teams Section, the Dashboard and Ares read, and which the sync engine passes to the adapter.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const TEAMS = 'teams:tenant-1:u-sam';
const OTHER = 'teams:tenant-2:u-sam';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 9);
const PRIYA_CHAT = '19:priya_sam@unq.gbl.spaces';
const LAUNCH_CHAT = '19:launch@thread.v2';

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-chat-settings-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function chat(chatId: string, title: string): SourceItem {
  const detail: ChatDetail = {
    kind: 'chat',
    chatType: 'group',
    topic: title,
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
  };
  return { externalId: chatId, kind: 'chat', title, detail };
}

const saveChats = (account = TEAMS) =>
  store.saveFromSource({
    source: 'teams',
    account,
    items: [chat(PRIYA_CHAT, 'Priya Patel'), chat(LAUNCH_CHAT, 'Launch crew')],
  });

const change = (chatId: string, kind: 'mute' | 'unmute' | 'exclude' | 'include', account = TEAMS) =>
  store.chatSettings.change({ account, chatId, change: kind }, user);

describe('muting and excluding Chats', () => {
  it('mutes and unmutes a Chat without touching its Item or the activity log', () => {
    const [priya] = saveChats().created;
    const before = store.activity();

    const muted = change(PRIYA_CHAT, 'mute');

    expect(muted).toEqual({
      setting: {
        account: TEAMS,
        chatId: PRIYA_CHAT,
        name: 'Priya Patel',
        muted: true,
        excludedAt: null,
        updatedAt: T,
      },
      itemId: priya,
      entry: null,
    });
    expect(store.chatSettings.list()).toEqual([muted.setting]);
    expect(store.activity()).toEqual(before);
    expect(store.get(priya ?? '')?.item.deletedAt).toBeNull();

    change(PRIYA_CHAT, 'unmute');
    expect(store.chatSettings.list()).toEqual([]);
  });

  it('excludes a Chat: its Item is deleted by the User, Links kept, and sync is told to skip it', () => {
    const [priya] = saveChats().created;
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Reply to Priya' } }, user);
    store.link({ from: todo.itemId, linkType: 'about', to: priya ?? '' }, user);

    const excluded = change(PRIYA_CHAT, 'exclude');

    expect(excluded.setting).toMatchObject({ name: 'Priya Patel', excludedAt: T });
    expect(excluded.entry).toMatchObject({ action: 'delete', itemId: priya, by: { kind: 'user' } });
    expect(excluded.entry?.why).toBe('Excluded the Chat from Commander');
    expect(store.query({ kinds: ['chat'] }).map((item) => item.title)).toEqual(['Launch crew']);
    expect(store.get(todo.itemId)?.links).toMatchObject([{ to: { id: priya, deletedAt: T } }]);
    expect(store.chatSettings.excluded(TEAMS)).toEqual([PRIYA_CHAT]);
    expect(store.chatSettings.excluded(OTHER)).toEqual([]);
  });

  it('includes an excluded Chat again: the next sync brings its Item back, as it was', () => {
    const [priya] = saveChats().created;
    change(PRIYA_CHAT, 'mute');
    change(PRIYA_CHAT, 'exclude');

    change(PRIYA_CHAT, 'include');

    expect(store.chatSettings.excluded(TEAMS)).toEqual([]);
    // Muting survives excluding and including.
    expect(store.chatSettings.list()).toMatchObject([{ chatId: PRIYA_CHAT, muted: true, excludedAt: null }]);
    const again = saveChats();
    expect(again.updated).toEqual([priya]);
    expect(store.get(priya ?? '')?.item.deletedAt).toBeNull();
  });

  it('keeps settings per Account, and drops an Account’s when its Items go', () => {
    saveChats(TEAMS);
    saveChats(OTHER);
    change(LAUNCH_CHAT, 'mute', TEAMS);
    change(LAUNCH_CHAT, 'exclude', OTHER);

    expect(store.chatSettings.list(TEAMS).map((each) => [each.account, each.muted])).toEqual([[TEAMS, true]]);
    expect(store.chatSettings.list().map((each) => each.account)).toEqual([TEAMS, OTHER]);

    store.removeAccountItems({ source: 'teams', account: OTHER }, user);
    expect(store.chatSettings.list().map((each) => each.account)).toEqual([TEAMS]);
  });

  it('can exclude a Chat Commander doesn’t hold', () => {
    expect(change('19:unknown@thread.v2', 'exclude')).toMatchObject({
      setting: { name: 'Chat', excludedAt: T },
      itemId: null,
      entry: null,
    });
    expect(store.chatSettings.excluded(TEAMS)).toEqual(['19:unknown@thread.v2']);
  });
});
