import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LinearCatalog,
  type LinearIssueDetail,
  type SourceItem,
  syncedFieldsOf,
  withSyncedFields,
} from '@commander/domain';
import {
  RateLimited,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  WriteRejected,
  type WriteRequest,
  type WriteResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTokenUnavailable } from '../access-tokens';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine, supersededNote } from './engine';

// Two-way sync's outgoing queue through the sync engine's interface: the User's changes are recorded
// through the Item store (as the window does), and the engine sends them with a fake Source adapter
// standing in for Linear, on a fake clock and a real Item store.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const SEC = 1000;
const MIN = 60_000;
const ACME = 'linear:org-acme';
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: null };

const detail = (overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail => ({
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
  priority: 2,
  assignee: priya,
  creator: null,
  labels: [],
  cycle: null,
  linearProject: null,
  dueDate: null,
  estimate: 3,
  description: null,
  comments: [],
  createdAt: T0 - 7 * 24 * 60 * MIN,
  updatedAt: T0 - 60 * MIN,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  ...overrides,
});

type WriteBehaviour = (request: WriteRequest) => Promise<WriteResult>;

// Linear, as far as the engine can tell: issues it hands over on sync, and writes that change them
// (unless a test scripts otherwise).
function fakeLinear() {
  const remote = new Map<string, SourceItem>();
  const writes: (WriteRequest & { at: number })[] = [];
  const syncs: number[] = [];
  const scripted: WriteBehaviour[] = [];
  const syncScripted: (() => Promise<void>)[] = [];
  let busy = 0;
  let mostAtOnce = 0;
  let catalog: LinearCatalog | null = null;

  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    busy += 1;
    mostAtOnce = Math.max(mostAtOnce, busy);
    try {
      return await work();
    } finally {
      busy -= 1;
    }
  };

  // Linear applies the changes and answers with the issue as it now has it.
  const applies: WriteBehaviour = async (request) => {
    const item = remote.get(request.externalId);
    if (!item?.detail) throw new Error(`No issue ${request.externalId}`);
    const fields = syncedFieldsOf(item.detail) ?? {};
    for (const change of request.changes) fields[change.field] = change.value;
    const next = { ...item, detail: withSyncedFields(item.detail, fields) };
    remote.set(request.externalId, next);
    return { item: next, superseded: [], cost: { requests: 2, complexity: 120 } };
  };

  const adapter: SourceAdapter = {
    source: 'linear',
    cadence: { defaultMinutes: 15, choices: [15, 30, 60] },
    sync: (request) =>
      track(async () => {
        syncs.push(Date.now());
        await request.accessToken();
        await syncScripted.shift()?.();
        request.save({ items: [...remote.values()], deleted: [] });
        if (catalog) request.saveCatalog?.(catalog);
        return { cursor: { n: syncs.length }, cost: { requests: 1, complexity: 100 } };
      }),
    write: (request) =>
      track(async () => {
        writes.push({ ...request, at: Date.now() });
        await request.accessToken();
        return (scripted.shift() ?? applies)(request);
      }),
  };
  return {
    adapter,
    remote,
    writes,
    syncs,
    applies,
    mostAtOnce: () => mostAtOnce,
    setCatalog: (next: LinearCatalog) => {
      catalog = next;
    },
    // The next writes behave like this, in order; then back to applying the changes.
    next: (...behaviours: WriteBehaviour[]) => scripted.push(...behaviours),
    holdNextSync: (until: Promise<void>) => syncScripted.push(() => until),
    sent: () => writes.map((write) => write.changes.map(({ field, value }) => [field, value])),
  };
}

const fail =
  (error: Error): WriteBehaviour =>
  async () => {
    throw error;
  };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

let dir: string;
let store: ItemStore;
let linear: ReturnType<typeof fakeLinear>;
let engine: SyncEngine;
let refused: string[];
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

function start() {
  const started = createSyncEngine({
    store,
    adapters: [linear.adapter],
    accessTokens: {
      request: async () => {
        if (tokenFailure) throw tokenFailure;
        return { token: 'lin_api_key', kind: 'api-key' };
      },
    },
    onSignInRefused: (account) => refused.push(account),
    random: () => 0,
    log: () => {},
  });
  engines.push(started);
  return started;
}

const connected = (needsReconnect = false) => [{ id: ACME, source: 'linear' as const, needsReconnect }];
const issueId = (externalId = 'issue-418') =>
  store
    .query({ kinds: ['linear-issue'], includeDeleted: true })
    .find((item) => item.externalId === externalId)?.id as string;
const local = () => store.get(issueId())?.item.detail as LinearIssueDetail;
const edit = (fields: Record<string, unknown>) =>
  store.record({ type: 'edit-fields', itemId: issueId(), fields }, { by: { kind: 'user' } });
const queue = () => store.outgoing.list({ itemIds: [issueId()] });
const status = () => engine.statuses().find((each) => each.account === ACME);

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-outgoing-'));
  store = openStore();
  linear = fakeLinear();
  linear.remote.set('issue-418', {
    externalId: 'issue-418',
    kind: 'linear-issue',
    title: 'Fix the login loop',
    detail: detail(),
  });
  refused = [];
  tokenFailure = null;
  engine = start();
  engine.setAccounts(connected());
  await vi.advanceTimersByTimeAsync(1);
});

afterEach(() => {
  for (const each of engines.splice(0)) each.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('a change made in Commander', () => {
  it('shows at once, reaches the Source in the background with the time it was made, then refreshes', async () => {
    const syncsBefore = linear.syncs.length;
    edit({ priority: 1 });
    expect(local().priority).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(linear.writes).toEqual([
      expect.objectContaining({
        account: ACME,
        externalId: 'issue-418',
        changes: [{ field: 'priority', value: 1, synced: 2, madeAt: T0 + 1 }],
      }),
    ]);
    expect(linear.remote.get('issue-418')?.detail).toMatchObject({ priority: 1 });
    expect(queue()).toEqual([]);
    expect(linear.syncs.length).toBe(syncsBefore + 1);
    expect(local().priority).toBe(1);
  });

  it('sends one Item’s changes together, only the fields that changed', async () => {
    store.recordAll(
      [
        { type: 'edit-fields', itemId: issueId(), fields: { priority: 1 } },
        { type: 'edit-fields', itemId: issueId(), fields: { estimate: 5 } },
      ],
      { by: { kind: 'user' } },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(linear.sent()).toEqual([
      [
        ['priority', 1],
        ['estimate', 5],
      ],
    ]);
  });

  it('counts in the Account’s status while on its way', async () => {
    engine.setSystemState({ awake: true, online: false });
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(status()?.outgoing).toEqual({ pending: 1, failed: 0 });
  });

  it('never goes alongside a sync of the same Account', async () => {
    const sync = gate();
    linear.holdNextSync(sync.opened);
    void engine.refresh(ACME);
    await vi.advanceTimersByTimeAsync(1);
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(10 * SEC);
    expect(linear.writes).toEqual([]);

    sync.open();
    await vi.advanceTimersByTimeAsync(1);
    expect(linear.sent()).toEqual([[['priority', 1]]]);
    expect(linear.mostAtOnce()).toBe(1);
    // The sync that ran before the write never put the old value back.
    expect(local().priority).toBe(1);
  });

  it('made while the same field is on its way follows it, rather than losing to it', async () => {
    const write = gate();
    linear.next(async (request) => {
      await write.opened;
      return linear.applies(request);
    });
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    edit({ priority: 4 });
    await vi.advanceTimersByTimeAsync(5 * SEC);
    write.open();
    await vi.advanceTimersByTimeAsync(1);

    expect(linear.writes.map((each) => each.changes)).toEqual([
      [{ field: 'priority', value: 1, synced: 2, madeAt: T0 + 1 }],
      [{ field: 'priority', value: 4, synced: 1, madeAt: T0 + 1 + 5 * SEC + 1 }],
    ]);
    expect(local().priority).toBe(4);
  });
});

describe('what comes back from the Source', () => {
  it('is saved through the normal save path, so search finds the issue as Linear has it', async () => {
    linear.next(async (request) => {
      const result = await linear.applies(request);
      const renamed = { ...(result.item as SourceItem), title: 'Fix the SSO redirect loop' };
      linear.remote.set(request.externalId, renamed);
      return { ...result, item: renamed };
    });
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(store.search.query({ text: 'redirect' }).hits.map((hit) => hit.item.id)).toEqual([issueId()]);
  });
});

describe('conflicts', () => {
  it('drops the User’s change when the Source changed the field later, shows its value and notes who', async () => {
    linear.next(async (request) => {
      const item = linear.remote.get(request.externalId) as SourceItem;
      const theirs = { ...item, detail: detail({ priority: 3 }) };
      linear.remote.set(request.externalId, theirs);
      return {
        item: theirs,
        superseded: [{ field: 'priority', by: 'Priya Patel', at: T0 + 30 * SEC }],
        cost: { requests: 1, complexity: 50 },
      };
    });
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(local().priority).toBe(3);
    expect(queue()).toEqual([]);
    const [latest] = store.activity({ itemId: issueId() });
    expect(latest).toMatchObject({
      by: { kind: 'source', source: 'linear', account: ACME },
      why: supersededNote('linear', [{ field: 'priority', by: 'Priya Patel', at: T0 + 30 * SEC }]),
    });
    expect(latest?.why).toMatch(/^Changed in Linear by Priya Patel at \d\d:\d\d$/);
  });

  it('notes the newest of several, and leaves out who when the Source doesn’t say', () => {
    const at = new Date(2026, 9, 3, 14, 2).getTime();
    expect(
      supersededNote('linear', [
        { field: 'priority', by: 'Sam Rivera', at: at - MIN },
        { field: 'estimate', by: 'Priya Patel', at },
      ]),
    ).toBe('Changed in Linear by Priya Patel at 14:02');
    expect(supersededNote('linear', [{ field: 'state', by: null, at }])).toBe('Changed in Linear at 14:02');
    expect(supersededNote('linear', [])).toBeUndefined();
  });
});

describe('offline and restarts', () => {
  it('waits while offline, then sends with the time the change was made', async () => {
    engine.setSystemState({ awake: true, online: false });
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(linear.writes).toEqual([]);

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(linear.writes.map((each) => each.changes[0]?.madeAt)).toEqual([T0 + 1]);
  });

  it('survives a restart, and sends once Commander is back', async () => {
    engine.setSystemState({ awake: true, online: false });
    edit({ estimate: 8 });
    engine.stop();
    store.close();
    vi.setSystemTime(T0 + 60 * MIN);

    store = openStore();
    engine = start();
    engine.setAccounts(connected());
    await vi.advanceTimersByTimeAsync(1);

    expect(linear.writes.map((each) => each.changes)).toEqual([
      [{ field: 'estimate', value: 8, synced: 3, madeAt: T0 + 1 }],
    ]);
    expect(linear.remote.get('issue-418')?.detail).toMatchObject({ estimate: 8 });
  });

  it('sends a change left on its way when Commander stopped', async () => {
    const write = gate();
    linear.next(async () => {
      await write.opened;
      throw new Error('never answered');
    });
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    engine.stop();

    engine = start();
    engine.setAccounts(connected());
    await vi.advanceTimersByTimeAsync(1);
    expect(linear.sent()).toEqual([[['priority', 1]], [['priority', 1]]]);
    expect(queue()).toEqual([]);
  });
});

describe('failures', () => {
  it('retry with growing back-off, stop as Couldn’t sync after the fifth, and Retry sends again', async () => {
    const down = new SourceUnavailable('Commander couldn’t reach Linear.');
    linear.next(fail(down), fail(down), fail(down), fail(down), fail(down));
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(20 * MIN);

    expect(linear.writes.map((each) => (each.at - T0 - 1) / SEC)).toEqual([0, 10, 30, 70, 150]);
    expect(queue()).toEqual([
      expect.objectContaining({ status: 'failed', attempts: 5, error: 'Commander couldn’t reach Linear.' }),
    ]);
    expect(status()?.outgoing).toEqual({ pending: 0, failed: 1 });
    // The change stays as the User made it until it gets through or is undone.
    expect(local().priority).toBe(1);

    store.outgoing.retry(issueId());
    await vi.advanceTimersByTimeAsync(1);
    expect(linear.writes).toHaveLength(6);
    expect(queue()).toEqual([]);
    expect(linear.remote.get('issue-418')?.detail).toMatchObject({ priority: 1 });
  });

  it('stop as Couldn’t sync at once when the Source refuses the change, and the Account’s others still go', async () => {
    linear.remote.set('issue-420', {
      externalId: 'issue-420',
      kind: 'linear-issue',
      title: 'Rotate the keys',
      detail: detail({ identifier: 'ENG-420' }),
    });
    await engine.refresh(ACME);
    linear.next(fail(new WriteRejected('Linear refused the change: no such state.')));
    edit({ priority: 1 });
    store.record(
      { type: 'edit-fields', itemId: issueId('issue-420'), fields: { estimate: 1 } },
      { by: { kind: 'user' } },
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(queue()).toEqual([
      expect.objectContaining({
        status: 'failed',
        attempts: 1,
        error: 'Linear refused the change: no such state.',
      }),
    ]);
    expect(linear.remote.get('issue-420')?.detail).toMatchObject({ estimate: 1 });
  });

  it('can be undone while Couldn’t sync: the change and its queue entry both go', async () => {
    linear.next(fail(new WriteRejected('Linear refused the change.')));
    const entry = edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    store.record({ type: 'undo', entryId: entry.id }, { by: { kind: 'user' } });
    await vi.advanceTimersByTimeAsync(1);

    expect(local().priority).toBe(2);
    expect(queue()).toEqual([]);
    expect(linear.writes).toHaveLength(1);
  });

  it('honour a rate limit’s wait without counting it as a failure', async () => {
    linear.next(fail(new RateLimited('Linear asked Commander to slow down.', 2 * MIN)));
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(queue()).toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);

    await vi.advanceTimersByTimeAsync(2 * MIN - 2);
    expect(linear.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(linear.writes).toHaveLength(2);
    expect(queue()).toEqual([]);
  });

  it('report a refused sign-in so the Account can be marked Reconnect, and wait for the reconnect', async () => {
    linear.next(fail(new SignInRefused('Linear refused this Account’s sign-in.')));
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(refused).toEqual([ACME]);

    engine.setAccounts(connected(true));
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(linear.writes).toHaveLength(1);
    expect(queue()).toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);

    engine.setAccounts(connected(false));
    await vi.advanceTimersByTimeAsync(1);
    expect(linear.writes).toHaveLength(2);
    expect(queue()).toEqual([]);
  });

  it('wait for a reconnect when the main process says the token needs one', async () => {
    tokenFailure = new AccessTokenUnavailable('needs-reconnect', 'Reconnect Acme');
    edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(status()?.activity).toBe('needs-reconnect');
    expect(queue()).toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);

    tokenFailure = null;
    engine.setAccounts(connected(false));
    await vi.advanceTimersByTimeAsync(1);
    expect(queue()).toEqual([]);
  });
});

describe('undo', () => {
  it('of a change that reached the Source sends the old value back', async () => {
    const entry = edit({ priority: 1 });
    await vi.advanceTimersByTimeAsync(1);
    vi.setSystemTime(T0 + 10 * MIN);
    store.record({ type: 'undo', entryId: entry.id }, { by: { kind: 'user' } });
    await vi.advanceTimersByTimeAsync(1);

    expect(linear.writes.map((each) => each.changes)).toEqual([
      [{ field: 'priority', value: 1, synced: 2, madeAt: T0 + 1 }],
      [{ field: 'priority', value: 2, synced: 1, madeAt: T0 + 10 * MIN }],
    ]);
    expect(local().priority).toBe(2);
    expect(linear.remote.get('issue-418')?.detail).toMatchObject({ priority: 2 });
  });

  it('of a posted comment takes it back at the Source', async () => {
    const comment = { id: 'c-1', author: priya, body: 'On it.', createdAt: T0, updatedAt: T0 };
    const entry = edit({ 'comment:c-1': comment });
    await vi.advanceTimersByTimeAsync(1);
    store.record({ type: 'undo', entryId: entry.id }, { by: { kind: 'user' } });
    await vi.advanceTimersByTimeAsync(1);

    expect(linear.sent()).toEqual([[['comment:c-1', comment]], [['comment:c-1', null]]]);
    expect(local().comments).toEqual([]);
  });
});

describe('the Account', () => {
  it('keeps what its Source offers the pickers, from each sync', async () => {
    const catalog: LinearCatalog = {
      kind: 'linear',
      teams: [
        {
          id: 'team-eng',
          key: 'ENG',
          name: 'Engineering',
          states: [],
          members: [priya],
          labels: [],
          cycles: [],
          linearProjects: [],
        },
      ],
    };
    linear.setCatalog(catalog);
    await engine.refresh(ACME);
    expect(store.syncState.catalog(ACME)).toEqual(catalog);
  });

  it('removed takes its queued changes with it', async () => {
    engine.setSystemState({ awake: true, online: false });
    edit({ priority: 1 });
    engine.forget(ACME);
    expect(store.outgoing.list()).toEqual([]);
  });
});
