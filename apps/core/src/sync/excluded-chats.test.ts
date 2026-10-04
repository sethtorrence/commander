import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceItem } from '@commander/domain';
import type { SourceAdapter, SyncRequest } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

// Excluded Teams Chats (#105): the engine passes an Account's excluded Chats to its sync, and never
// saves one back, even from a sync that started before the User excluded it.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const TEAMS = 'teams:tenant-1:u-sam';
const PRIYA_CHAT = '19:priya_sam@unq.gbl.spaces';
const LAUNCH_CHAT = '19:launch@thread.v2';

const chat = (externalId: string, title: string): SourceItem => ({ externalId, kind: 'chat', title });

let dir: string;
let store: ItemStore;
let engine: SyncEngine;
let requests: SyncRequest[];
// Runs during the next sync, before it saves.
let during: (() => void) | null;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-excluded-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  requests = [];
  during = null;
  const adapter: SourceAdapter = {
    source: 'teams',
    cadence: { defaultMinutes: 1440, choices: [1440], alsoAfterOtherSources: true },
    async sync(request) {
      requests.push(request);
      during?.();
      during = null;
      // A Source that ignores what it was told to skip.
      request.save({
        items: [chat(PRIYA_CHAT, 'Priya Patel'), chat(LAUNCH_CHAT, 'Launch crew')],
        deleted: [],
      });
      return { cursor: { n: requests.length }, cost: { requests: 1, complexity: null } };
    },
  };
  engine = createSyncEngine({
    store,
    adapters: [adapter],
    accessTokens: { request: async () => ({ token: 'never-stored', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engine.setAccounts([{ id: TEAMS, source: 'teams', needsReconnect: false, me: 'u-sam' }]);
});

afterEach(() => {
  engine.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const titles = () =>
  store
    .query({ kinds: ['chat'] })
    .map((item) => item.title)
    .sort();
const exclude = (chatId: string, change: 'exclude' | 'include' = 'exclude') =>
  store.chatSettings.change({ account: TEAMS, chatId, change }, { by: { kind: 'user' } });

describe('excluded Chats in sync', () => {
  it('tells the sync which Chats to skip, and saves none of them back', async () => {
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[0]?.excluded).toEqual([]);
    expect(titles()).toEqual(['Launch crew', 'Priya Patel']);

    exclude(PRIYA_CHAT);
    await engine.refresh(TEAMS);

    expect(requests[1]?.excluded).toEqual([PRIYA_CHAT]);
    expect(titles()).toEqual(['Launch crew']);

    exclude(PRIYA_CHAT, 'include');
    await engine.refresh(TEAMS);
    expect(requests[2]?.excluded).toEqual([]);
    expect(titles()).toEqual(['Launch crew', 'Priya Patel']);
  });

  it('skips a Chat excluded while a sync was already under way', async () => {
    await vi.advanceTimersByTimeAsync(0);
    during = () => exclude(LAUNCH_CHAT);

    await engine.refresh(TEAMS);

    expect(requests[1]?.excluded).toEqual([]);
    expect(titles()).toEqual(['Priya Patel']);
  });
});
