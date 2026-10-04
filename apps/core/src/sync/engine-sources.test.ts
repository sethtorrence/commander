import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Source } from '@commander/domain';
import {
  RateLimited,
  type SourceAdapter,
  SourceUnavailable,
  type SyncRequest,
  type SyncResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncAccount, type SyncEngine } from './engine';

// The sync engine with an Account that carries several Sources sharing one sign-in (a Google
// Account: Gmail and Google Calendar). Two fake adapters, a fake clock and a real Item store.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const GOOGLE = 'google:1045';
const OTHER = 'google:2090';

type Behaviour = (request: SyncRequest) => Promise<SyncResult>;
type Call = { source: Source; account: string; at: number; cursor: unknown };

// Every adapter's calls, in order, and how many syncs ran at once (per Account).
let calls: Call[];
let running: Map<string, number>;
let mostAtOnce: Map<string, number>;

function fakeSource(source: Source, cadence = { defaultMinutes: 15, choices: [5, 15, 30] }) {
  const scripted: Behaviour[] = [];
  let n = 0;
  const adapter: SourceAdapter = {
    source,
    cadence,
    async sync(request) {
      calls.push({ source, account: request.account, at: Date.now(), cursor: request.cursor });
      const now = (running.get(request.account) ?? 0) + 1;
      running.set(request.account, now);
      mostAtOnce.set(request.account, Math.max(mostAtOnce.get(request.account) ?? 0, now));
      try {
        // Each sync takes a minute, so overlapping syncs would show.
        await new Promise((resolve) => setTimeout(resolve, MIN));
        const behaviour = scripted.shift();
        if (behaviour) return await behaviour(request);
        n += 1;
        return { cursor: `${source}-${n}`, cost: { requests: 1, complexity: null } };
      } finally {
        running.set(request.account, (running.get(request.account) ?? 1) - 1);
      }
    },
  };
  return { adapter, next: (...behaviours: Behaviour[]) => scripted.push(...behaviours) };
}

const fail =
  (error: Error): Behaviour =>
  async () => {
    throw error;
  };

let dir: string;
let store: ItemStore;
let gmail: ReturnType<typeof fakeSource>;
let calendar: ReturnType<typeof fakeSource>;
let engine: SyncEngine;
const engines: SyncEngine[] = [];

function start() {
  const started = createSyncEngine({
    store,
    adapters: [gmail.adapter, calendar.adapter],
    accessTokens: { request: async () => ({ token: 'ya29.never-stored', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engines.push(started);
  return started;
}

const google = (
  id = GOOGLE,
  sources: Source[] = ['gmail', 'google-calendar'],
  needsReconnect = false,
): SyncAccount => ({ id, sources, needsReconnect });

const times = (source: Source, account = GOOGLE) =>
  calls.filter((call) => call.source === source && call.account === account).map((c) => (c.at - T0) / MIN);
// A refresh, waited out on the fake clock (each sync takes a minute).
async function refreshed(...args: Parameters<SyncEngine['refresh']>) {
  const done = engine.refresh(...args);
  await vi.advanceTimersByTimeAsync(2 * MIN);
  await done;
}
const status = (source: Source, account = GOOGLE) =>
  engine.statuses().find((each) => each.account === account && each.source === source);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-sync-sources-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  calls = [];
  running = new Map();
  mostAtOnce = new Map();
  gmail = fakeSource('gmail');
  calendar = fakeSource('google-calendar');
  engine = start();
});

afterEach(() => {
  for (const each of engines.splice(0)) each.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('an Account carrying several Sources', () => {
  it('syncs each of them, one at a time on the Account’s one queue', async () => {
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(40 * MIN);

    expect(times('gmail')).toEqual([0, 16, 32]);
    expect(times('google-calendar')).toEqual([1, 17, 33]);
    expect(mostAtOnce.get(GOOGLE)).toBe(1);
  });

  it('never holds up another Account', async () => {
    engine.setAccounts([google(), google(OTHER)]);
    await vi.advanceTimersByTimeAsync(2 * MIN);

    expect(times('gmail', OTHER)).toEqual([0]);
    expect(times('google-calendar', OTHER)).toEqual([1]);
    expect(mostAtOnce.get(OTHER)).toBe(1);
  });

  it('reports a status for each Source', async () => {
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(MIN / 2);

    expect(status('gmail')).toMatchObject({ activity: 'syncing', cadenceChoices: [5, 15, 30] });
    expect(status('google-calendar')).toMatchObject({ activity: 'idle' });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(status('gmail')).toMatchObject({ activity: 'idle', lastSyncedAt: T0 + MIN });
    expect(status('google-calendar')).toMatchObject({ activity: 'syncing', lastSyncedAt: null });
  });

  it('keeps a cursor for each Source, also after a restart', async () => {
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    engine.stop();

    engine = start();
    engine.setAccounts([google()]);
    await refreshed(GOOGLE);

    const cursors = (source: Source) => calls.filter((c) => c.source === source).map((c) => c.cursor);
    expect(cursors('gmail')).toEqual([null, 'gmail-1']);
    expect(cursors('google-calendar')).toEqual([null, 'google-calendar-1']);
  });

  it('keeps a cadence for each Source', async () => {
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    engine.setCadence(GOOGLE, 5, 'gmail');
    await vi.advanceTimersByTimeAsync(15 * MIN);

    expect(times('gmail')).toEqual([0, 6, 12]);
    expect(times('google-calendar')).toEqual([1, 17]);
    expect(status('gmail')?.cadenceMinutes).toBe(5);
    expect(status('google-calendar')?.cadenceMinutes).toBe(15);
  });

  it('backs off one Source without slowing the other', async () => {
    gmail.next(...Array.from({ length: 4 }, () => fail(new SourceUnavailable('Gmail is down'))));
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(1.5 * MIN);

    expect(status('gmail')).toMatchObject({
      activity: 'backing-off',
      nextSyncAt: T0 + 2 * MIN,
      problem: { kind: 'failed', message: 'Gmail is down' },
    });
    expect(status('google-calendar')).toMatchObject({ activity: 'syncing', problem: null });
    await vi.advanceTimersByTimeAsync(20 * MIN);
    // Gmail waits 1, 2, 4, 8 minutes after each failure; Calendar keeps to its 15 minutes.
    expect(times('gmail')).toEqual([0, 2, 5, 10, 19]);
    expect(times('google-calendar')).toEqual([1, 17]);
    expect(status('gmail')).toMatchObject({ problem: null, lastSyncedAt: T0 + 20 * MIN });
  });

  it('honours one Source’s rate limit only for that Source', async () => {
    gmail.next(fail(new RateLimited('Gmail asked Commander to slow down.', 90 * MIN)));
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await refreshed(GOOGLE);

    expect(times('gmail')).toEqual([0]);
    expect(times('google-calendar')).toEqual([1, 2]);
    expect(status('gmail')).toMatchObject({ activity: 'backing-off', problem: { kind: 'rate-limited' } });
  });

  it('refreshes every Source of the Account, or just the one asked for', async () => {
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(5 * MIN);

    await refreshed(GOOGLE, 'google-calendar');
    expect(times('gmail')).toEqual([0]);
    expect(times('google-calendar')).toEqual([1, 5]);

    await refreshed(GOOGLE);
    expect(times('gmail')).toEqual([0, 7]);
    expect(times('google-calendar')).toEqual([1, 5, 8]);
    expect(mostAtOnce.get(GOOGLE)).toBe(1);
  });

  it('stops a Source switched off, and starts one switched on', async () => {
    engine.setAccounts([google(GOOGLE, ['gmail'])]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(times('google-calendar')).toEqual([]);
    expect(status('google-calendar')).toBeUndefined();

    engine.setAccounts([google(GOOGLE, ['gmail', 'google-calendar'])]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(times('google-calendar')).toEqual([2]);

    engine.setAccounts([google(GOOGLE, ['google-calendar'])]);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(times('gmail')).toEqual([0]);
    expect(status('gmail')).toBeUndefined();
  });

  it('pauses every Source while the Account needs reconnecting', async () => {
    engine.setAccounts([google(GOOGLE, ['gmail', 'google-calendar'], true)]);
    await vi.advanceTimersByTimeAsync(30 * MIN);

    expect(calls).toEqual([]);
    expect(status('gmail')?.activity).toBe('needs-reconnect');
    expect(status('google-calendar')?.activity).toBe('needs-reconnect');
  });

  it('forgets every Source’s sync state when the Account is removed', async () => {
    engine.setAccounts([google()]);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    engine.forget(GOOGLE);

    expect(store.syncState.get(GOOGLE, 'gmail')).toBeNull();
    expect(store.syncState.get(GOOGLE, 'google-calendar')).toBeNull();
    expect(engine.statuses()).toEqual([]);
  });
});
