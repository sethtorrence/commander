import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelPostDetail, SourceItem } from '@commander/domain';
import type { SourceAdapter, SyncRequest } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncAccount, type SyncEngine } from './engine';

// Channel posts in sync (#111): the engine tells a Teams sync whether Channel posts are on (granted
// and switched on) and which teams and channels to skip, syncs again at once when that changes,
// never saves a post from a channel excluded meanwhile, and passes a permission refusal on.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const TEAMS = 'teams:tenant-1:u-sam';
const TL = 'team-tl';
const GENERAL = '19:general@thread.tacv2';

function post(channelId: string, id: string): SourceItem {
  const message = {
    id,
    from: { userId: 'u-priya', name: 'Priya' },
    event: null,
    createdAt: T0,
    modifiedAt: T0,
    deleted: false,
    text: 'Hello',
    mentions: [],
    reactions: [],
    attachments: [],
    replyTo: null,
  };
  const detail: ChannelPostDetail = {
    kind: 'channel-post',
    team: { id: TL, name: 'Titanlink' },
    channel: { id: channelId, name: 'General' },
    subject: null,
    post: message,
    replies: [],
    webUrl: null,
    mentionsMe: false,
    lastActivityAt: T0,
  };
  return { externalId: `${TL}/${channelId}/${id}`, kind: 'channel-post', title: 'Hello', detail };
}

let dir: string;
let store: ItemStore;
let engine: SyncEngine;
let requests: SyncRequest[];
let refused: string[];
let during: (() => void) | null;

const account = (channelPosts: boolean): SyncAccount => ({
  id: TEAMS,
  source: 'teams',
  needsReconnect: false,
  me: 'u-sam',
  channelPosts,
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-channel-sync-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  requests = [];
  refused = [];
  during = null;
  const adapter: SourceAdapter = {
    source: 'teams',
    cadence: { defaultMinutes: 1440, choices: [1440], alsoAfterOtherSources: true },
    async sync(request) {
      requests.push(request);
      during?.();
      during = null;
      // A Source that ignores what it was told to skip.
      if (request.channelPosts) request.save({ items: [post(GENERAL, 'p1')], deleted: [] });
      if (requests.length === 3) request.channelPostsRefused?.();
      return { cursor: { n: requests.length }, cost: { requests: 1, complexity: null } };
    },
  };
  engine = createSyncEngine({
    store,
    adapters: [adapter],
    accessTokens: { request: async () => ({ token: 'never-stored', kind: 'oauth' }) },
    onChannelPostsRefused: (id) => refused.push(id),
    random: () => 0,
    log: () => {},
  });
});

afterEach(() => {
  engine.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('Channel posts in sync', () => {
  it('are off until granted and switched on, and switching them syncs again at once', async () => {
    engine.setAccounts([account(false)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[0]?.channelPosts).toBeNull();

    engine.setAccounts([account(true)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.channelPosts).toEqual({ excluded: [] });
    expect(requests[1]?.mode).toBe('light');
    expect(store.query({ kinds: ['channel-post'] })).toHaveLength(1);

    // The same again changes nothing.
    engine.setAccounts([account(true)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
  });

  it('passes the exclusions, and never saves a post from a channel excluded during the sync', async () => {
    engine.setAccounts([account(true)]);
    await vi.advanceTimersByTimeAsync(0);
    store.channelSettings.change(
      { account: TEAMS, teamId: TL, channelId: GENERAL, change: 'exclude' },
      { by: { kind: 'user' } },
    );
    await engine.refresh(TEAMS);
    expect(requests[1]?.channelPosts).toEqual({ excluded: [{ teamId: TL, channelId: GENERAL }] });
    expect(store.query({ kinds: ['channel-post'] })).toEqual([]);

    store.channelSettings.change(
      { account: TEAMS, teamId: TL, channelId: GENERAL, change: 'include' },
      { by: { kind: 'user' } },
    );
    during = () =>
      store.channelSettings.change(
        { account: TEAMS, teamId: TL, channelId: null, change: 'exclude' },
        { by: { kind: 'user' } },
      );
    await engine.refresh(TEAMS);
    expect(store.query({ kinds: ['channel-post'] })).toEqual([]);
  });

  it('passes on Microsoft refusing for want of permission', async () => {
    engine.setAccounts([account(true)]);
    await vi.advanceTimersByTimeAsync(0);
    await engine.refresh(TEAMS);
    await engine.refresh(TEAMS);
    expect(refused).toEqual([TEAMS]);
  });
});
