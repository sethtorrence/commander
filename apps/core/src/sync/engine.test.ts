import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, SourceItem } from '@commander/domain';
import {
  RateLimited,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  type SyncRequest,
  type SyncResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTokenUnavailable } from '../access-tokens';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine, type SyncEngineOptions } from './engine';

// The sync engine through its interface: a fake Source adapter, a fake clock (Vitest's timers) and
// a real Item store on a temporary database.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const ACME = 'linear:org-acme';
const GLOBEX = 'linear:org-globex';
const TOKEN = 'lin_api_never_stored_anywhere';

type Behaviour = (request: SyncRequest) => Promise<SyncResult>;

// A Source adapter that does what each test scripts, and by default hands over `issues`.
function fakeSource() {
  const calls: { account: string; at: number; cursor: unknown }[] = [];
  const scripted: Behaviour[] = [];
  const issues = new Map<string, SourceItem[]>();
  let running = 0;
  let mostAtOnce = 0;
  const sendIssues: Behaviour = async (request) => {
    request.save({ items: issues.get(request.account) ?? [], deleted: [] });
    return { cursor: { after: calls.length }, cost: { requests: 1, complexity: 590 } };
  };
  const adapter: SourceAdapter = {
    source: 'linear',
    cadence: { defaultMinutes: 15, choices: [15, 30, 60] },
    async sync(request) {
      calls.push({ account: request.account, at: Date.now(), cursor: request.cursor });
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      try {
        await request.accessToken();
        return await (scripted.shift() ?? sendIssues)(request);
      } finally {
        running -= 1;
      }
    },
  };
  return {
    adapter,
    calls,
    issues,
    mostAtOnce: () => mostAtOnce,
    // The next syncs behave like this, in order; then back to handing over `issues`.
    next: (...behaviours: Behaviour[]) => scripted.push(...behaviours),
    sendIssues,
  };
}

const fail =
  (error: Error): Behaviour =>
  async () => {
    throw error;
  };

// A sync that waits until the test lets it finish.
function held() {
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const behaviour =
    (then: Behaviour): Behaviour =>
    async (request) => {
      await released;
      return then(request);
    };
  return { behaviour, finish: () => finish() };
}

const issue = (externalId: string, title: string): SourceItem => ({
  externalId,
  kind: 'linear-issue',
  title,
});

let dir: string;
let store: ItemStore;
let source: ReturnType<typeof fakeSource>;
let engine: SyncEngine;
let refused: string[];
let logs: string[];
let tokenFailure: AccessTokenUnavailable | null;
const engines: SyncEngine[] = [];

function openStore() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
}

function start(options: Partial<SyncEngineOptions> = {}) {
  const started = createSyncEngine({
    store,
    adapters: [source.adapter],
    accessTokens: {
      request: async () => {
        if (tokenFailure) throw tokenFailure;
        return { token: TOKEN, kind: 'api-key' };
      },
    },
    onSignInRefused: (account) => refused.push(account),
    random: () => 0,
    log: (message) => logs.push(message),
    ...options,
  });
  engines.push(started);
  return started;
}

const connected = (...ids: string[]) =>
  ids.map((id) => ({ id, source: 'linear' as const, needsReconnect: false }));
const status = (account = ACME) => engine.statuses().find((each) => each.account === account);
const syncTimes = (account = ACME) =>
  source.calls.filter((call) => call.account === account).map((call) => (call.at - T0) / MIN);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-sync-'));
  store = openStore();
  source = fakeSource();
  refused = [];
  logs = [];
  tokenFailure = null;
  engine = start();
});

afterEach(() => {
  for (const each of engines.splice(0)) each.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduling', () => {
  it('syncs a newly connected Account at once, then every 15 minutes', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(46 * MIN);

    expect(syncTimes()).toEqual([0, 15, 30, 45]);
  });

  it('spreads start times by a small random offset', async () => {
    engine.stop();
    engine = start({ random: () => 0.5 });
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(32 * MIN);

    expect(syncTimes()).toEqual([0, 15.5, 31]);
  });

  it('changes the cadence to one of the Source’s choices, and keeps it after a restart', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    engine.setCadence(ACME, 30);
    engine.setCadence(ACME, 7);
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(syncTimes()).toEqual([0, 30]);
    expect(status()).toMatchObject({ cadenceMinutes: 30, cadenceChoices: [15, 30, 60] });

    engine.stop();
    engine = start();
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(syncTimes()).toEqual([0, 30, 60]);
  });

  it('gives each Account its own queue, so one slow or failing Account never holds up another', async () => {
    const slow = held();
    source.next(slow.behaviour(source.sendIssues));
    engine.setAccounts(connected(ACME, GLOBEX));
    await vi.advanceTimersByTimeAsync(31 * MIN);

    expect(syncTimes(ACME)).toEqual([0]);
    expect(syncTimes(GLOBEX)).toEqual([0, 15, 30]);
    slow.finish();
  });

  it('refreshes at once, and never runs two syncs of one Account at the same time', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const slow = held();
    source.next(slow.behaviour(source.sendIssues));

    const first = engine.refresh(ACME);
    const second = engine.refresh(ACME);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(status()?.activity).toBe('syncing');
    slow.finish();
    await Promise.all([first, second]);

    expect(syncTimes()).toEqual([0, 5]);
    expect(source.mostAtOnce()).toBe(1);
    // The next scheduled sync counts from the refresh.
    expect(status()?.nextSyncAt).toBe(Date.now() + 15 * MIN);
  });

  it('pauses while asleep and catches up once on wake', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1 * MIN);
    engine.setSystemState({ awake: false, online: true });
    expect(status()?.activity).toBe('asleep');
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(syncTimes()).toEqual([0]);

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(syncTimes()).toEqual([0, 61]);
  });

  it('pauses while offline, skips refreshes, and catches up once when back online', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1 * MIN);
    engine.setSystemState({ awake: true, online: false });
    await engine.refresh(ACME);
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(status()).toMatchObject({ activity: 'offline', nextSyncAt: null });
    expect(syncTimes()).toEqual([0]);

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(syncTimes()).toEqual([0, 41]);
  });

  it('tells listeners after every sync, so other Sources can sync alongside', async () => {
    const synced: unknown[] = [];
    engine.onSynced((event) => synced.push(event));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);

    expect(synced).toEqual([{ account: ACME, source: 'linear', outcome: 'synced' }]);
  });
});

describe('back-off', () => {
  it('waits exponentially longer after each failure, up to an hour, and recovers on success', async () => {
    source.next(...Array.from({ length: 9 }, () => fail(new SourceUnavailable('Linear is down'))));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    expect(status()).toMatchObject({
      activity: 'backing-off',
      nextSyncAt: T0 + 1 * MIN,
      problem: { kind: 'failed', message: 'Linear is down' },
    });

    await vi.advanceTimersByTimeAsync(260 * MIN);
    const gaps = syncTimes().map((at, i, all) => at - (all[i - 1] ?? 0));
    expect(gaps).toEqual([0, 1, 2, 4, 8, 16, 32, 60, 60, 60, 15]);
    expect(status()).toMatchObject({ activity: 'idle', problem: null });
  });

  it('always honours Retry-After, even past the cap, and refreshes wait for it too', async () => {
    source.next(fail(new RateLimited('Linear asked Commander to slow down.', 2 * 60 * MIN)));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    expect(status()).toMatchObject({
      activity: 'backing-off',
      nextSyncAt: T0 + 120 * MIN,
      problem: { kind: 'rate-limited' },
    });

    await engine.refresh(ACME);
    await vi.advanceTimersByTimeAsync(119 * MIN);
    expect(syncTimes()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(syncTimes()).toEqual([0, 120]);
  });

  it('lets the User retry at once after an ordinary failure', async () => {
    source.next(fail(new SourceUnavailable('Linear is down')));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(10_000);
    await engine.refresh(ACME);

    expect(syncTimes()).toEqual([0, 10_000 / MIN]);
    expect(status()?.problem).toBeNull();
  });

  it('keeps the back-off across a restart', async () => {
    source.next(fail(new RateLimited('Slow down', 90 * MIN)));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    engine.stop();

    engine = start();
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(91 * MIN);
    expect(syncTimes()).toEqual([0, 90]);
  });
});

describe('Accounts that need reconnecting', () => {
  it('skips them until reconnected, then syncs at once', async () => {
    engine.setAccounts([{ id: ACME, source: 'linear', needsReconnect: true }]);
    await engine.refresh(ACME);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(syncTimes()).toEqual([]);
    expect(status()).toMatchObject({ activity: 'needs-reconnect', nextSyncAt: null });

    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    expect(syncTimes()).toEqual([60]);
  });

  it('reports a sign-in the Source refused, so the Account can be marked Reconnect', async () => {
    source.next(fail(new SignInRefused('Linear refused this Account’s sign-in.')));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);

    expect(refused).toEqual([ACME]);
    expect(status()?.problem).toEqual({ kind: 'refused', message: 'Linear refused this Account’s sign-in.' });
  });

  it('stops syncing an Account whose token the main process says needs reconnecting', async () => {
    tokenFailure = new AccessTokenUnavailable(
      'needs-reconnect',
      'The Acme Linear Account needs reconnecting',
    );
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(60 * MIN);

    expect(syncTimes()).toEqual([0]);
    expect(status()?.activity).toBe('needs-reconnect');
  });
});

describe('what a sync saves', () => {
  it('saves the Source’s Items through the Item store and reports the Account’s status', async () => {
    source.issues.set(ACME, [issue('issue-1', 'Fix the login loop'), issue('issue-2', 'Rotate keys')]);
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);

    expect(
      store
        .query({ account: ACME })
        .map((item) => item.title)
        .sort(),
    ).toEqual(['Fix the login loop', 'Rotate keys']);
    expect(status()).toEqual({
      account: ACME,
      source: 'linear',
      activity: 'idle',
      cadenceMinutes: 15,
      cadenceChoices: [15, 30, 60],
      lastSyncedAt: T0,
      nextSyncAt: T0 + 15 * MIN,
      itemCount: 2,
      problem: null,
    });
  });

  it('starts each sync from the cursor the last one returned, also after a restart', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(16 * MIN);
    engine.stop();
    engine = start();
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(15 * MIN);

    expect(source.calls.map((call) => call.cursor)).toEqual([null, { after: 1 }, { after: 2 }]);
    expect(syncTimes()).toEqual([0, 15, 30]);
  });

  it('leaves every Item unchanged, with no new activity, when nothing changed at the Source', async () => {
    source.issues.set(ACME, [issue('issue-1', 'Fix the login loop')]);
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    const before = { items: store.query(), activity: store.activity() };

    await engine.refresh(ACME);
    await vi.advanceTimersByTimeAsync(30 * MIN);

    expect(syncTimes()).toHaveLength(4);
    expect(store.query()).toEqual(before.items);
    expect(store.activity()).toEqual(before.activity);
  });

  it('keeps filing and Links made in Commander through later syncs', async () => {
    source.issues.set(ACME, [issue('issue-1', 'Fix the login loop')]);
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    const [synced] = store.query({ account: ACME });
    if (!synced) throw new Error('no Item');
    const user = { by: { kind: 'user' } } as const;
    const titanlink = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    }).project as Project;
    store.record(
      {
        type: 'update',
        itemId: synced.id,
        changes: { filing: { projectId: titanlink.id, filedBy: 'user' } },
      },
      user,
    );
    const day = store.ensureDailyNote('2026-10-03', user);
    const text = 'Ask Priya about [[ENG-1]]';
    const blockDetail = {
      kind: 'block',
      dailyNoteId: day.id,
      parentId: null,
      position: 'a0',
      text,
      folded: false,
    } as const;
    const note = store.record(
      { type: 'create', item: { kind: 'block', title: text, detail: blockDetail } },
      user,
    );
    store.link({ from: note.itemId, linkType: 'refers-to', to: synced.id }, user);

    source.issues.set(ACME, [issue('issue-1', 'Fix the login loop for good')]);
    await engine.refresh(ACME);

    expect(store.get(synced.id)).toMatchObject({
      item: { title: 'Fix the login loop for good', filing: { projectId: titanlink.id, filedBy: 'user' } },
      backlinks: [{ type: 'refers-to', from: { id: note.itemId } }],
    });
  });

  it('records what each sync cost the Source', async () => {
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);
    source.next(fail(new RateLimited('Slow down', 5 * MIN, { requests: 3, complexity: 870 })));
    await engine.refresh(ACME);

    expect(store.syncState.runs(ACME)).toMatchObject([
      { outcome: 'rate-limited', trigger: 'refresh', requests: 3, complexity: 870 },
      { outcome: 'synced', trigger: 'scheduled', requests: 1, complexity: 590, created: 0 },
    ]);
  });

  it('never writes the access token to the database or the logs', async () => {
    source.issues.set(ACME, [issue('issue-1', 'Fix the login loop')]);
    source.next(fail(new SourceUnavailable('Linear is down')));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(2 * MIN);
    store.close();
    store = openStore();

    const files = readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString('latin1'));
    expect(files.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('stops a removed Account at once: nothing more is saved and its sync state goes', async () => {
    const slow = held();
    source.issues.set(ACME, [issue('issue-1', 'Fix the login loop')]);
    source.next(slow.behaviour(source.sendIssues));
    engine.setAccounts(connected(ACME));
    await vi.advanceTimersByTimeAsync(1);

    engine.forget(ACME);
    slow.finish();
    await vi.advanceTimersByTimeAsync(60 * MIN);

    expect(store.query({ account: ACME })).toEqual([]);
    expect(store.syncState.get(ACME)).toBeNull();
    expect(syncTimes()).toEqual([0]);
    expect(status()).toBeUndefined();
  });
});
