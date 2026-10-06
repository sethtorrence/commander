import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailDetail, MirrorPlan, SourceItem } from '@commander/domain';
import {
  type MirrorRequest,
  type SourceAdapter,
  SourceUnavailable,
  type WriteRequest,
} from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

// Mirror Buckets (#142) through the sync engine, with a fake Gmail adapter on a fake clock and a real
// Item store: nothing about Buckets reaches the Source while mirroring is off; once on, the Account's
// label plan (labels to make, rename and delete) is carried out before its writes, on the Account's own
// queue, and a plan that fails holds the writes back rather than letting them make labels of their own.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const T0 = Date.UTC(2026, 9, 7, 9);
const ALEX = 'google:alex';

function message(id: string): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: id,
    from: { name: 'Dana', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    sentAt: T0 - 3_600_000,
    snippet: '',
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  return { externalId: id, kind: 'email', title: detail.subject, people: [], status: 'open', detail };
}

function fakeGmail() {
  const calls: string[] = [];
  const plans: MirrorPlan[] = [];
  const failing: Error[] = [];
  const adapter: SourceAdapter = {
    source: 'gmail',
    cadence: { defaultMinutes: 15, choices: [15] },
    sync: async (request) => {
      request.save({ items: [message('m1'), message('m2')], deleted: [] });
      return { cursor: { n: 1 }, cost: { requests: 1, complexity: 1 } };
    },
    write: async (request: WriteRequest) => {
      calls.push(
        `write ${request.changes.map((change) => `${change.field}=${JSON.stringify(change.value)}`)}`,
      );
      return { item: null, superseded: [], cost: { requests: 1, complexity: 5 } };
    },
    mirrorBuckets: async (request: MirrorRequest) => {
      const failure = failing.shift();
      calls.push(failure ? 'plan (failed)' : 'plan');
      if (failure) throw failure;
      plans.push(request.plan);
      return { problems: [], cost: { requests: 1, complexity: 1 } };
    },
  };
  return { adapter, calls, plans, failNextPlan: (error: Error) => failing.push(error) };
}

let dir: string;
let store: ItemStore;
let gmail: ReturnType<typeof fakeGmail>;
let engine: SyncEngine;

const idOf = (externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId)?.id as string;
const sort = (externalId: string, bucketId: string | null) =>
  store.record(
    { type: 'edit-fields', itemId: idOf(externalId), fields: { bucket: { bucketId, sortedBy: 'user' } } },
    { by: { kind: 'user' } },
  );

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-mirror-sync-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.now(),
  });
  gmail = fakeGmail();
  engine = createSyncEngine({
    store,
    adapters: [gmail.adapter],
    accessTokens: { request: async () => ({ token: 'ya29.test', kind: 'oauth' }) },
    random: () => 0,
    log: () => {},
  });
  engine.setAccounts([{ id: ALEX, sources: ['gmail'], needsReconnect: false }]);
  await vi.advanceTimersByTimeAsync(1);
});

afterEach(() => {
  engine.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('Mirror Buckets through the sync engine', () => {
  it('sends nothing about Buckets while mirroring is off', async () => {
    sort('m1', 'fyi');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gmail.calls).toEqual([]);
  });

  it('carries out the label plan before the writes, once', async () => {
    store.bucketMirror.set({ account: ALEX, source: 'gmail', enabled: true });
    sort('m1', 'fyi');
    await vi.advanceTimersByTimeAsync(1);
    sort('m2', 'fyi');
    await vi.advanceTimersByTimeAsync(1);

    expect(gmail.calls).toEqual(['plan', 'write bucket-mirror="FYI"', 'write bucket-mirror="FYI"']);
    expect(gmail.plans).toEqual([
      { ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }], rename: [], remove: [] },
    ]);
    expect(store.bucketMirror.plan(ALEX)).toBeNull();
  });

  it('holds the writes back while the plan fails, then carries on', async () => {
    store.bucketMirror.set({ account: ALEX, source: 'gmail', enabled: true });
    gmail.failNextPlan(new SourceUnavailable('Commander couldn’t reach Gmail.'));
    sort('m1', 'fyi');
    await vi.advanceTimersByTimeAsync(1);
    expect(gmail.calls).toEqual(['plan (failed)']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(gmail.calls).toEqual(['plan (failed)', 'plan', 'write bucket-mirror="FYI"']);
  });

  it('deletes Commander’s labels when the User switches off and asks for them to go', async () => {
    store.bucketMirror.set({ account: ALEX, source: 'gmail', enabled: true });
    sort('m1', 'fyi');
    await vi.advanceTimersByTimeAsync(1);

    store.bucketMirror.set({ account: ALEX, source: 'gmail', enabled: false, removeLabels: true });
    await vi.advanceTimersByTimeAsync(1);

    expect(gmail.plans.at(-1)).toEqual({
      ensure: [],
      rename: [],
      remove: [{ bucketId: 'fyi', name: 'FYI' }],
    });
    expect(store.bucketMirror.plan(ALEX)).toBeNull();
  });
});
