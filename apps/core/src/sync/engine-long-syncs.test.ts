import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailDetail } from '@commander/domain';
import {
  GMAIL_CADENCE,
  RateLimited,
  type SourceAdapter,
  type SyncRequest,
  type SyncResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncAccount, type SyncEngine } from './engine';

// The sync engine with a Source whose first sync is long (Gmail's 30-day download): it checkpoints
// where it has got to so a stopped sync carries on, reports its progress while it runs, learns when
// the Account was connected and which Items Commander already holds, and keeps the User's cadence
// (Email: every 5 to 60 minutes) across restarts.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const GOOGLE = 'google:1045';
const CONNECTED = T0 - 2 * MIN;

type Behaviour = (request: SyncRequest) => Promise<SyncResult>;

let dir: string;
let store: ItemStore;
let requests: SyncRequest[];
let scripted: Behaviour[];
const engines: SyncEngine[] = [];

const gmail: SourceAdapter = {
  source: 'gmail',
  cadence: GMAIL_CADENCE,
  async sync(request) {
    requests.push(request);
    const behaviour = scripted.shift();
    if (behaviour) return behaviour(request);
    return { cursor: { done: true }, cost: { requests: 1, complexity: 20 } };
  },
};

function start() {
  const engine = createSyncEngine({
    store,
    adapters: [gmail],
    accessTokens: { request: async () => ({ token: 'ya29.never-stored', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engines.push(engine);
  return engine;
}

const account: SyncAccount = {
  id: GOOGLE,
  sources: ['gmail'],
  needsReconnect: false,
  connectedAt: CONNECTED,
};
const status = (engine: SyncEngine) => engine.statuses().find((each) => each.source === 'gmail');

const emailItem = (externalId: string) => ({
  externalId,
  kind: 'email' as const,
  title: externalId,
  detail: {
    kind: 'email',
    messageId: `<${externalId}@x.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${externalId}@x.test>`,
    sourceThreadId: externalId,
    from: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: externalId,
    sentAt: T0,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  } satisfies EmailDetail,
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-long-syncs-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  requests = [];
  scripted = [];
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('a long first sync', () => {
  it('hands the Source when the Account was connected, and the external ids Commander holds from it', async () => {
    store.saveFromSource({ source: 'gmail', account: GOOGLE, items: [emailItem('m1'), emailItem('m2')] });
    store.saveFromSource({ source: 'gmail', account: GOOGLE, items: [], deleted: ['m2'] });
    store.saveFromSource({ source: 'gmail', account: 'google:other', items: [emailItem('m9')] });
    const engine = start();

    engine.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);

    expect(requests[0]?.connectedAt).toBe(CONNECTED);
    expect(requests[0]?.heldIds?.()).toEqual(['m1']);
  });

  it('carries on from its checkpoint after Gmail’s quota stops it, and only then counts as synced', async () => {
    scripted.push(async (request) => {
      request.checkpoint?.({ backfill: 'from 5000' });
      throw new RateLimited('Gmail asked Commander to slow down.', 60_000);
    });
    const engine = start();

    engine.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);
    expect(status(engine)).toMatchObject({ activity: 'backing-off', lastSyncedAt: null });

    await vi.advanceTimersByTimeAsync(MIN + 10);

    expect(requests.map((request) => request.cursor)).toEqual([null, { backfill: 'from 5000' }]);
    expect(status(engine)?.lastSyncedAt).not.toBeNull();
  });

  it('carries on from its checkpoint after a restart', async () => {
    let release: () => void = () => {};
    scripted.push(async (request) => {
      request.checkpoint?.({ backfill: 'from 5000' });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('Commander quit');
    });
    const first = start();
    first.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);
    first.stop();
    release();

    const second = start();
    second.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);

    expect(requests.map((request) => request.cursor)).toEqual([null, { backfill: 'from 5000' }]);
  });

  it('shows its progress while it runs, and none once it is over', async () => {
    let release: () => void = () => {};
    scripted.push(async (request) => {
      request.progress?.({ done: 1240, total: 3000 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { cursor: 'done', cost: { requests: 1, complexity: null } };
    });
    const engine = start();
    const seen: unknown[] = [];
    engine.onStatus((statuses) => seen.push(statuses[0]?.progress));

    engine.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);
    expect(status(engine)?.progress).toEqual({ done: 1240, total: 3000 });
    expect(seen).toContainEqual({ done: 1240, total: 3000 });

    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(status(engine)?.progress).toBeUndefined();
  });
});

describe('the cadence', () => {
  it('offers 5 to 60 minutes, keeps the User’s choice across restarts, and syncs on it', async () => {
    const engine = start();
    engine.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);
    expect(status(engine)).toMatchObject({ cadenceMinutes: 15, cadenceChoices: [5, 10, 15, 30, 60] });

    engine.setCadence(GOOGLE, 5);
    expect(status(engine)?.nextSyncAt).toBe(T0 + 5 * MIN);
    engine.stop();

    const restarted = start();
    restarted.setAccounts([account]);
    expect(status(restarted)?.cadenceMinutes).toBe(5);
    await vi.advanceTimersByTimeAsync(5 * MIN + 10);
    expect(requests).toHaveLength(2);
  });
});
