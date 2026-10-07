import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailDetail, Item, SourceItem } from '@commander/domain';
import {
  CursorExpired,
  GMAIL_CADENCE,
  RateLimited,
  type SourceAdapter,
  SourceUnavailable,
  type SyncRequest,
  type SyncResult,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, SPREAD_MS, type SyncAccount, type SyncEngine } from './engine';

// Re-sync (#205) through the sync engine's interface: the automatic one, when a Source rejects its
// cursor (Gmail's history expired, a calendar's 410), and the User's Re-sync from Settings → Accounts.
// Both forget the cursor and read the Source again from scratch, honour a Retry-After, carry on from a
// checkpoint when stopped, show how far they have got, and leave everything of the User's (Links,
// filing, Buckets, snoozes, Todos) on the same Items, with none twice. A fake Source adapter, a fake
// clock (Vitest's timers) and a real Item store on a temporary database.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;
const GOOGLE = 'google:1045';

type Behaviour = (request: SyncRequest) => Promise<SyncResult>;

let dir: string;
let store: ItemStore;
let logs: string[];
const engines: SyncEngine[] = [];

// The Account's mail as the Source has it now: handed over whole on a sync from scratch.
let mailbox: SourceItem[];

// A Source adapter: scripted behaviours first, then the default (everything on a sync from scratch,
// nothing new after it). Each call notes the cursor it was handed.
function fakeSource(source: 'gmail' | 'google-calendar', items: () => SourceItem[] = () => []) {
  const cursors: unknown[] = [];
  const scripted: Behaviour[] = [];
  const adapter: SourceAdapter = {
    source,
    cadence: source === 'gmail' ? GMAIL_CADENCE : { defaultMinutes: 15, choices: [15] },
    async sync(request) {
      cursors.push(request.cursor);
      const behaviour = scripted.shift();
      if (behaviour) return behaviour(request);
      if (request.cursor === null) request.save({ items: items(), deleted: [] });
      return { cursor: { after: cursors.length }, cost: { requests: 1, complexity: null } };
    },
  };
  return { adapter, cursors, next: (...behaviours: Behaviour[]) => scripted.push(...behaviours) };
}

let gmail: ReturnType<typeof fakeSource>;
let calendar: ReturnType<typeof fakeSource>;

function start() {
  const engine = createSyncEngine({
    store,
    adapters: [gmail.adapter, calendar.adapter],
    accessTokens: { request: async () => ({ token: 'ya29.never-stored', kind: 'oauth' }) },
    random: () => 0,
    log: (message) => logs.push(message),
  });
  engines.push(engine);
  return engine;
}

const account: SyncAccount = {
  id: GOOGLE,
  sources: ['gmail', 'google-calendar'],
  needsReconnect: false,
  connectedAt: T0 - 2 * MIN,
};
const gmailOnly: SyncAccount = { ...account, sources: ['gmail'] };
const statusOf = (engine: SyncEngine, source = 'gmail') =>
  engine.statuses().find((each) => each.source === source);

function email(externalId: string, from: string, subject: string, read = false): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${externalId}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${externalId}@mail.test>`,
    sourceThreadId: externalId,
    from: {
      name: from,
      address: `${from.toLowerCase()}@${from === 'Stripe' ? 'stripe.com' : 'northwind.test'}`,
    },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    sentAt: T0 - 60 * MIN,
    snippet: '',
    read,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  return { externalId, kind: 'email', title: subject, status: 'open', detail };
}

// A sync that waits until the test lets it finish.
function held(then: Behaviour) {
  let finish: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const behaviour: Behaviour = async (request) => {
    await released;
    return then(request);
  };
  return { behaviour, finish: () => finish() };
}

const finished: Behaviour = async () => ({
  cursor: { finished: true },
  cost: { requests: 1, complexity: null },
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-resync-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  logs = [];
  mailbox = [
    email('m1', 'Dana', 'Q4 offsite dates'),
    email('m2', 'Stripe', 'Your receipt'),
    email('m3', 'Priya', 'Staging certificate'),
  ];
  gmail = fakeSource('gmail', () => mailbox);
  calendar = fakeSource('google-calendar');
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

// What the User (a Rule, and Ares with the User's say-so) made of the Account's mail after its first
// sync: Dana's email filed and sorted by the User, snoozed, made into a Todo and linked from a Block
// of today's Daily Note; Stripe's filed and sorted by Rules; Priya's filed by Ares, accepted.
function arrange() {
  const user = { by: { kind: 'user' } } as const;
  const { project: longtail } = store.changeProject({
    type: 'create',
    project: { name: 'Longtail', code: 'LT', accent: 'blue' },
  });
  const { project: finance } = store.changeProject({
    type: 'create',
    project: { name: 'Finance', code: 'FI', accent: 'teal' },
  });
  if (!longtail || !finance) throw new Error('Projects not made');
  const byTitle = (title: string) => {
    const found = store.query({ kinds: ['email'] }).find((item) => item.title === title);
    if (!found) throw new Error(`No email "${title}"`);
    return found;
  };
  const dana = byTitle('Q4 offsite dates');
  const priya = byTitle('Staging certificate');
  store.recordAll(
    [
      { type: 'update', itemId: dana.id, changes: { filing: { projectId: longtail.id, filedBy: 'user' } } },
      {
        type: 'edit-fields',
        itemId: dana.id,
        fields: {
          bucket: { bucketId: 'needs-reply', sortedBy: 'user' },
          snooze: { until: T0 + 600 * MIN, returned: false },
        },
      },
    ],
    user,
  );
  store.record(
    { type: 'update', itemId: priya.id, changes: { filing: { projectId: longtail.id, filedBy: 'ares' } } },
    { by: { kind: 'ares' }, why: 'Accepted: about the Longtail staging site' },
  );
  const [made] = store.recordAll(
    [
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Reply to Dana about the offsite',
          detail: { kind: 'todo', origin: 'email', dueOn: null, backedBy: null },
        },
      },
    ],
    user,
  );
  const todoId = made?.itemId as string;
  store.record({ type: 'link', from: todoId, linkType: 'made-from', to: dana.id }, user);
  const note = store.ensureDailyNote('2026-10-03', user);
  const [block] = store.recordAll(
    [
      {
        type: 'create',
        item: {
          kind: 'block',
          title: 'Ask Dana about the venue',
          detail: {
            kind: 'block',
            dailyNoteId: note.id,
            parentId: null,
            position: 'a0',
            text: 'Ask Dana about the venue',
            folded: false,
          },
        },
      },
    ],
    user,
  );
  const blockId = block?.itemId as string;
  store.record({ type: 'link', from: blockId, linkType: 'refers-to', to: dana.id }, user);
  // Rules: Stripe's mail files into Finance and sorts into FYI (they file it on the next save).
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'project', projectId: finance.id },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
      },
    },
  });
  store.changeRule({
    type: 'create',
    rule: {
      target: { kind: 'bucket', bucketId: 'fyi' },
      when: {
        join: 'and',
        terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
      },
    },
  });
  const stripe = byTitle('Your receipt');
  store.refile([stripe.id]);
  store.resort([stripe.id]);
  return {
    dana: dana.id,
    stripe: stripe.id,
    priya: priya.id,
    todo: todoId,
    block: blockId,
    longtail,
    finance,
  };
}

// Everything of the User's on the Account's Items, to compare before and after a re-sync.
function theUsersWork(ids: ReturnType<typeof arrange>) {
  const item = (id: string) => store.get(id)?.item as Item;
  const emailOf = (id: string) => item(id).detail as EmailDetail;
  const links = (id: string) =>
    (store.get(id)?.backlinks ?? []).map((link) => ({ type: link.type, from: link.from.id }));
  return {
    emails: store
      .query({ kinds: ['email'] })
      .map((each) => ({ id: each.id, externalId: each.externalId }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    filing: [ids.dana, ids.stripe, ids.priya].map((id) => item(id).filing),
    buckets: [ids.dana, ids.stripe].map((id) => emailOf(id).bucket),
    snooze: emailOf(ids.dana).snooze,
    danaLinks: links(ids.dana),
    todo: { live: item(ids.todo).deletedAt === null, status: item(ids.todo).status },
    block: item(ids.block).deletedAt === null,
  };
}

describe('the automatic re-sync, when the Source rejects its cursor', () => {
  it('reads the Source again from scratch in the same sync, and counts as synced', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    gmail.next(async () => {
      throw new CursorExpired('Gmail’s history has expired.');
    });

    await engine.refresh(GOOGLE);

    expect(gmail.cursors).toEqual([null, { after: 1 }, null]);
    expect(store.syncState.get(GOOGLE, 'gmail')?.cursor).toEqual({ after: 3 });
    expect(statusOf(engine)).toMatchObject({ activity: 'idle', problem: null });
    expect(store.syncState.runs(GOOGLE)[0]).toMatchObject({
      outcome: 'synced',
      trigger: 'refresh',
      unchanged: 3,
    });
    expect(logs).toContain(
      "gmail no longer accepts google:1045's sync cursor; syncing it again from scratch",
    );
  });

  it('restarts only once: a second rejection fails the sync, which backs off', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    const expired: Behaviour = async (request) => {
      request.checkpoint?.({ partly: true });
      throw new CursorExpired('Gmail’s history has expired.');
    };
    gmail.next(expired, expired);

    await engine.refresh(GOOGLE);

    expect(gmail.cursors).toEqual([null, { after: 1 }, null]);
    expect(statusOf(engine)).toMatchObject({ activity: 'backing-off', problem: { kind: 'failed' } });
  });

  it('doesn’t restart a sync that was already from scratch', async () => {
    gmail.next(async () => {
      throw new CursorExpired('Gmail’s history has expired.');
    });
    const engine = start();

    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);

    expect(gmail.cursors).toEqual([null]);
    expect(statusOf(engine)?.activity).toBe('backing-off');
  });

  it('forgets the rejected cursor, so a restart that stops part-way never asks with it again', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    gmail.next(
      async () => {
        throw new CursorExpired('Gmail’s history has expired.');
      },
      async () => {
        throw new SourceUnavailable('Gmail is unreachable.');
      },
    );

    await engine.refresh(GOOGLE);
    expect(store.syncState.get(GOOGLE, 'gmail')?.cursor).toBeNull();
    // Still a re-sync, waiting to try again; the next sync carries it on from scratch.
    expect(statusOf(engine)?.resync).toEqual({ done: 0, total: null });
    await vi.advanceTimersByTimeAsync(MIN + 10);

    expect(gmail.cursors).toEqual([null, { after: 1 }, null, null]);
    expect(store.syncState.runs(GOOGLE)[0]).toMatchObject({ outcome: 'synced', trigger: 'resync' });
    expect(statusOf(engine)?.resync).toBeUndefined();
  });

  it('shows as a re-sync while it runs, with how far it has got', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    const slow = held(async () => ({ cursor: 'done', cost: { requests: 1, complexity: null } }));
    gmail.next(
      async () => {
        throw new CursorExpired('Gmail’s history has expired.');
      },
      async (request) => {
        request.save({ items: mailbox.slice(0, 2), deleted: [] });
        return slow.behaviour(request);
      },
    );

    const done = engine.refresh(GOOGLE);
    await vi.advanceTimersByTimeAsync(10);
    expect(statusOf(engine)).toMatchObject({ activity: 'syncing', resync: { done: 2, total: null } });

    slow.finish();
    await done;
    expect(statusOf(engine)?.resync).toBeUndefined();
  });

  it('leaves the User’s Links, filing, Buckets, snoozes and Todos on the same Items, none twice', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    const ids = arrange();
    const before = theUsersWork(ids);
    // Meanwhile at the Source: Dana's email was read, and new mail came.
    mailbox = [
      email('m1', 'Dana', 'Q4 offsite dates', true),
      ...mailbox.slice(1),
      email('m4', 'Leo', 'Signed contract?'),
    ];
    gmail.next(async () => {
      throw new CursorExpired('Gmail’s history has expired.');
    });

    await engine.refresh(GOOGLE);

    const after = theUsersWork(ids);
    expect(after).toEqual({ ...before, emails: expect.any(Array) });
    expect(after.emails).toHaveLength(4);
    expect(after.emails).toEqual(expect.arrayContaining(before.emails));
    expect(store.get(ids.dana)?.item.detail).toMatchObject({ read: true });
  });
});

describe('the User’s Re-sync', () => {
  it('forgets the cursor of every Source the Account carries and reads each again from scratch', async () => {
    const engine = start();
    engine.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);

    await engine.resync(GOOGLE);

    expect(gmail.cursors).toEqual([null, null]);
    expect(calendar.cursors).toEqual([null, null]);
    expect(store.syncState.runs(GOOGLE).map((run) => [run.source, run.trigger, run.outcome])).toEqual([
      ['google-calendar', 'resync', 'synced'],
      ['gmail', 'resync', 'synced'],
      ['google-calendar', 'scheduled', 'synced'],
      ['gmail', 'scheduled', 'synced'],
    ]);
    expect(statusOf(engine)).toMatchObject({ activity: 'idle', problem: null });
    expect(statusOf(engine)?.resync).toBeUndefined();
  });

  it('shows its progress: waiting its turn, then the Source’s count, and nothing once done', async () => {
    const engine = start();
    engine.setAccounts([account]);
    await vi.advanceTimersByTimeAsync(10);
    const slow = held(async () => ({ cursor: 'done', cost: { requests: 1, complexity: null } }));
    gmail.next(async (request) => {
      request.progress?.({ done: 340, total: 1200 });
      return slow.behaviour(request);
    });
    const seen: unknown[] = [];
    engine.onStatus((statuses) =>
      seen.push(statuses.find((each) => each.source === 'google-calendar')?.resync),
    );

    const done = engine.resync(GOOGLE);
    await vi.advanceTimersByTimeAsync(10);

    expect(statusOf(engine)).toMatchObject({ activity: 'syncing', resync: { done: 340, total: 1200 } });
    // Google Calendar waits its turn on the Account's queue.
    expect(statusOf(engine, 'google-calendar')).toMatchObject({
      activity: 'idle',
      resync: { done: 0, total: null },
    });
    slow.finish();
    await done;
    expect(statusOf(engine)?.resync).toBeUndefined();
    expect(statusOf(engine, 'google-calendar')?.resync).toBeUndefined();
    expect(seen).toContainEqual({ done: 0, total: null });
  });

  it('follows a sync already under way, rather than joining it', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    const slow = held(finished);
    gmail.next(slow.behaviour);
    const refreshing = engine.refresh(GOOGLE);
    await vi.advanceTimersByTimeAsync(10);

    const resyncing = engine.resync(GOOGLE);
    slow.finish();
    await Promise.all([refreshing, resyncing]);

    expect(gmail.cursors).toEqual([null, { after: 1 }, null]);
    expect(store.syncState.get(GOOGLE, 'gmail')?.cursor).toEqual({ after: 3 });
  });

  it('honours a Retry-After: it waits, shown as waiting, and runs from scratch once the wait is over', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    gmail.next(async () => {
      throw new RateLimited('Gmail asked Commander to slow down.', 5 * MIN);
    });
    await engine.refresh(GOOGLE);
    expect(statusOf(engine)?.activity).toBe('backing-off');

    await engine.resync(GOOGLE);
    expect(gmail.cursors).toHaveLength(2);
    expect(statusOf(engine)).toMatchObject({ activity: 'backing-off', resync: { done: 0, total: null } });

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(gmail.cursors).toEqual([null, { after: 1 }, null]);
    expect(store.syncState.runs(GOOGLE)[0]).toMatchObject({ trigger: 'resync', outcome: 'synced' });
  });

  it('carries on from its checkpoint after Gmail’s quota stops it part-way, rather than starting again', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    gmail.next(async (request) => {
      request.save({ items: mailbox.slice(0, 1), deleted: [] });
      request.checkpoint?.({ backfill: 'from m2' });
      throw new RateLimited('Gmail asked Commander to slow down.', MIN);
    });

    await engine.resync(GOOGLE);
    expect(statusOf(engine)).toMatchObject({ activity: 'backing-off', resync: { done: 0, total: null } });
    await vi.advanceTimersByTimeAsync(MIN + 10);

    expect(gmail.cursors).toEqual([null, null, { backfill: 'from m2' }]);
    expect(store.syncState.runs(GOOGLE).map((run) => [run.trigger, run.outcome])).toEqual([
      ['resync', 'synced'],
      ['resync', 'rate-limited'],
      ['scheduled', 'synced'],
    ]);
    expect(statusOf(engine)?.resync).toBeUndefined();
  });

  it('starts again from scratch after a restart that stopped it before any checkpoint', async () => {
    const first = start();
    first.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    const stuck = held(async () => {
      throw new Error('Commander quit');
    });
    gmail.next(stuck.behaviour);
    void first.resync(GOOGLE);
    await vi.advanceTimersByTimeAsync(10);
    first.stop();
    stuck.finish();

    // Its next sync (on the cadence) reads from scratch, not with the cursor it forgot.
    const second = start();
    second.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(15 * MIN + 10);

    expect(gmail.cursors).toEqual([null, null, null]);
  });

  it('waits while offline, then runs from scratch once back', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    engine.setSystemState({ awake: true, online: false });

    await engine.resync(GOOGLE);
    expect(gmail.cursors).toHaveLength(1);
    expect(statusOf(engine)).toMatchObject({ activity: 'offline', resync: { done: 0, total: null } });

    engine.setSystemState({ awake: true, online: true });
    await vi.advanceTimersByTimeAsync(SPREAD_MS + 10);
    expect(gmail.cursors).toEqual([null, null]);
  });

  it('leaves the User’s Links, filing, Buckets, snoozes and Todos on the same Items, none twice', async () => {
    const engine = start();
    engine.setAccounts([gmailOnly]);
    await vi.advanceTimersByTimeAsync(10);
    const ids = arrange();
    const before = theUsersWork(ids);
    expect(before).toMatchObject({
      filing: [
        { projectId: ids.longtail.id, filedBy: 'user' },
        { projectId: ids.finance.id, filedBy: 'rule' },
        { projectId: ids.longtail.id, filedBy: 'ares' },
      ],
      buckets: [
        { bucketId: 'needs-reply', sortedBy: 'user' },
        { bucketId: 'fyi', sortedBy: 'rule' },
      ],
      snooze: { until: T0 + 600 * MIN, returned: false },
      danaLinks: [
        { type: 'made-from', from: ids.todo },
        { type: 'refers-to', from: ids.block },
      ],
    });
    // Meanwhile at the Source: Dana's email was read.
    mailbox = [email('m1', 'Dana', 'Q4 offsite dates', true), ...mailbox.slice(1)];

    await engine.resync(GOOGLE);

    expect(theUsersWork(ids)).toEqual(before);
    expect(store.get(ids.dana)?.item.detail).toMatchObject({ read: true });
    expect(store.syncState.runs(GOOGLE)[0]).toMatchObject({
      trigger: 'resync',
      created: 0,
      unchanged: 2,
      updated: 1,
    });
  });
});
