import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Source, SourceItem } from '@commander/domain';
import {
  type Cadence,
  RateLimited,
  type SourceAdapter,
  type SyncMode,
  type SyncRequest,
  type SyncResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

// Sources with a light sync (Teams): a full sync on their cadence (once a day), and a cheap check
// whenever another Source's Account finishes syncing, coalesced and never more than every 5 minutes,
// unless the User switches it off. Through the engine's interface, with fake adapters, a fake clock
// and a real Item store on a temporary database.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LINEAR_ACME = 'linear:org-acme';
const LINEAR_GLOBEX = 'linear:org-globex';
const TEAMS = 'teams:tenant-1:u-sam';

type Call = { account: string; at: number; mode: SyncMode; cursor: unknown };
type Behaviour = (request: SyncRequest) => Promise<SyncResult>;

function fakeSource(
  source: Source,
  cadence: Cadence,
  items: (request: SyncRequest) => SourceItem[] = () => [],
) {
  const calls: Call[] = [];
  const scripted: Behaviour[] = [];
  const adapter: SourceAdapter = {
    source,
    cadence,
    async sync(request) {
      calls.push({ account: request.account, at: Date.now(), mode: request.mode, cursor: request.cursor });
      const behaviour = scripted.shift();
      if (behaviour) return behaviour(request);
      request.save({ items: items(request), deleted: [] });
      return { cursor: { n: calls.length }, cost: { requests: 1, complexity: null } };
    },
  };
  return { adapter, calls, next: (...behaviours: Behaviour[]) => scripted.push(...behaviours) };
}

let dir: string;
let store: ItemStore;
let linear: ReturnType<typeof fakeSource>;
let teams: ReturnType<typeof fakeSource>;
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

function start() {
  const started = createSyncEngine({
    store,
    adapters: [linear.adapter, teams.adapter],
    accessTokens: { request: async () => ({ token: 'never-stored', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engines.push(started);
  return started;
}

const accounts = (...ids: string[]) =>
  ids.map((id) => ({ id, source: id.split(':')[0] as Source, needsReconnect: false, me: 'u-sam' }));
const teamsCalls = () => teams.calls.map((call) => ({ at: (call.at - T0) / MIN, mode: call.mode }));
const status = (account = TEAMS) => engine.statuses().find((each) => each.account === account);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-alongside-'));
  store = openStore();
  linear = fakeSource('linear', { defaultMinutes: 15, choices: [15, 30, 60] });
  teams = fakeSource('teams', { defaultMinutes: 1440, choices: [1440], alsoAfterOtherSources: true });
  engine = start();
});

afterEach(() => {
  for (const each of engines.splice(0)) each.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

// Teams connected and through its first (full) sync, at T0, before Linear joins.
async function teamsSyncedFirst() {
  engine.setAccounts(accounts(TEAMS));
  await vi.advanceTimersByTimeAsync(0);
}

describe('the cadence of a Source with a light sync', () => {
  it('syncs fully at once and then once a day, counted from the last full sync, not the last check', async () => {
    await teamsSyncedFirst();
    await vi.advanceTimersByTimeAsync(6 * 60 * MIN);
    await engine.refresh(TEAMS);
    await vi.advanceTimersByTimeAsync(DAY - 6 * 60 * MIN);

    expect(teamsCalls()).toEqual([
      { at: 0, mode: 'full' },
      { at: 6 * 60, mode: 'light' },
      { at: 24 * 60, mode: 'full' },
    ]);
    expect(status()).toMatchObject({
      lastSyncedAt: T0 + DAY,
      nextSyncAt: T0 + 2 * DAY,
      alsoAfterOtherSources: true,
    });
  });

  it('runs a full sync whenever it has no cursor to check from, even on refresh', async () => {
    engine.setAccounts([{ id: TEAMS, source: 'teams', needsReconnect: true }]);
    engine.setAccounts(accounts(TEAMS));
    await vi.advanceTimersByTimeAsync(1);

    expect(teamsCalls()).toEqual([{ at: 0, mode: 'full' }]);
  });

  it('asks Sources without a light sync for full syncs only, and offers them no switch', async () => {
    engine.setAccounts(accounts(LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(1);
    await engine.refresh(LINEAR_ACME);

    expect(linear.calls.map((call) => call.mode)).toEqual(['full', 'full']);
    expect(status(LINEAR_ACME)).not.toHaveProperty('alsoAfterOtherSources');
  });

  it('tells the adapter who the User is and lets it read what Commander holds from the Account', async () => {
    const seen: { me: unknown; stored: string[] }[] = [];
    teams.next(async (request) => {
      request.save({ items: [{ externalId: 'chat-1', kind: 'chat', title: 'Priya Patel' }], deleted: [] });
      return { cursor: { n: 1 }, cost: { requests: 1, complexity: null } };
    });
    teams.next(async (request) => {
      seen.push({
        me: request.me,
        stored: (request.stored?.(['chat-1', 'chat-2']) ?? []).map((item) => item.title),
      });
      return { cursor: { n: 2 }, cost: { requests: 1, complexity: null } };
    });
    await teamsSyncedFirst();
    await engine.refresh(TEAMS);

    expect(seen).toEqual([{ me: 'u-sam', stored: ['Priya Patel'] }]);
  });
});

describe('checking alongside other Sources', () => {
  it('checks Teams once, lightly, a moment after a Linear sync finishes', async () => {
    await teamsSyncedFirst();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(1 * MIN);

    expect(teamsCalls()).toEqual([
      { at: 0, mode: 'full' },
      { at: 20 + 5 / 60, mode: 'light' },
    ]);
    expect(store.syncState.runs(TEAMS)[0]).toMatchObject({ trigger: 'alongside', outcome: 'synced' });
  });

  it('makes one check when several syncs finish together', async () => {
    await teamsSyncedFirst();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME, LINEAR_GLOBEX));
    await vi.advanceTimersByTimeAsync(1 * MIN);

    expect(linear.calls).toHaveLength(2);
    expect(teamsCalls().filter((call) => call.mode === 'light')).toHaveLength(1);
  });

  it('never checks more often than every 5 minutes', async () => {
    await teamsSyncedFirst();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(1 * MIN);
    // Linear refreshed every minute for ten minutes.
    for (let i = 0; i < 10; i++) {
      await engine.refresh(LINEAR_ACME);
      await vi.advanceTimersByTimeAsync(1 * MIN);
    }

    const checks = teamsCalls()
      .filter((call) => call.mode === 'light')
      .map((call) => call.at);
    expect(checks.length).toBeGreaterThan(1);
    for (let i = 1; i < checks.length; i++)
      expect((checks[i] ?? 0) - (checks[i - 1] ?? 0)).toBeGreaterThanOrEqual(5);
  });

  it('does not check right after Teams itself synced', async () => {
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(1 * MIN);

    expect(teamsCalls()).toEqual([{ at: 0, mode: 'full' }]);
  });

  it('stops when the User switches it off, and keeps the choice after a restart', async () => {
    await teamsSyncedFirst();
    engine.setAlsoAfterOtherSources(TEAMS, false);
    expect(status()?.alsoAfterOtherSources).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(teamsCalls()).toEqual([{ at: 0, mode: 'full' }]);

    engine.stop();
    engine = start();
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(teamsCalls()).toEqual([{ at: 0, mode: 'full' }]);
    expect(status()?.alsoAfterOtherSources).toBe(false);

    engine.setAlsoAfterOtherSources(TEAMS, true);
    await engine.refresh(LINEAR_ACME);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(teamsCalls().at(-1)).toMatchObject({ mode: 'light' });
  });

  it('waits out a rate limit: no checks until Retry-After has passed, however often others sync', async () => {
    await teamsSyncedFirst();
    teams.next(async () => {
      throw new RateLimited('Microsoft asked Commander to check Teams less often.', 3 * 60 * MIN);
    });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await engine.refresh(TEAMS);
    engine.setAccounts(accounts(TEAMS, LINEAR_ACME));
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN - 1);

    expect(teamsCalls()).toEqual([
      { at: 0, mode: 'full' },
      { at: 10, mode: 'light' },
    ]);
    expect(status()).toMatchObject({ activity: 'backing-off', nextSyncAt: T0 + 190 * MIN });
    await vi.advanceTimersByTimeAsync(1);
    expect(teamsCalls()).toHaveLength(3);
  });

  it('skips Accounts that need reconnecting', async () => {
    await teamsSyncedFirst();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    engine.setAccounts([...accounts(LINEAR_ACME), { id: TEAMS, source: 'teams', needsReconnect: true }]);
    await vi.advanceTimersByTimeAsync(30 * MIN);

    expect(teamsCalls()).toEqual([{ at: 0, mode: 'full' }]);
  });
});
