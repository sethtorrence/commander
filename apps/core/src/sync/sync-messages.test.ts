import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreAccountRefused, CoreSyncStatus } from '@commander/domain';
import { SignInRefused, type SourceAdapter } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpSync } from '.';

// The Core's side of the sync messages with the main process: Accounts, commands and the machine's
// state in; sync status and refused sign-ins out.

const T0 = Date.UTC(2026, 9, 3, 9);
const ACME = 'linear:org-acme';
const endpoints = { linear: 'http://127.0.0.1:9/graphql' };

let dir: string;
let store: ItemStore;
let sent: (CoreSyncStatus | CoreAccountRefused)[];
let endpointsSeen: string[];
let refuse: boolean;
let sync: ReturnType<typeof setUpSync>;

function adapterFor(apiUrl: () => string): SourceAdapter {
  return {
    source: 'linear',
    cadence: { defaultMinutes: 15, choices: [15, 30, 60] },
    async sync(request) {
      endpointsSeen.push(apiUrl());
      if (refuse) throw new SignInRefused('Linear refused this Account’s sign-in.');
      request.save({
        items: [{ externalId: 'issue-1', kind: 'linear-issue', title: 'Fix it' }],
        deleted: [],
      });
      return { cursor: null, cost: { requests: 1, complexity: 10 } };
    },
  };
}

const lastStatus = () => sent.filter((message) => message.type === 'sync-status').at(-1)?.accounts[0];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  dir = mkdtempSync(join(tmpdir(), 'commander-sync-messages-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => Date.now(),
  });
  sent = [];
  endpointsSeen = [];
  refuse = false;
  sync = setUpSync(store, {
    send: (message) => sent.push(message),
    accessTokens: { request: async () => ({ token: 'secret', kind: 'api-key' }) },
    linearSource: ({ apiUrl }) => adapterFor(apiUrl),
    random: () => 0,
    log: () => {},
  });
});

afterEach(() => {
  sync.stop();
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const accounts = (needsReconnect = false) => ({
  type: 'sync-accounts',
  accounts: [{ id: ACME, source: 'linear', needsReconnect }],
  endpoints,
});

describe('sync messages', () => {
  it('starts syncing the Accounts the main process lists, at the endpoint it names, and reports status', async () => {
    expect(sync.handle(accounts())).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(endpointsSeen).toEqual([endpoints.linear]);
    expect(lastStatus()).toMatchObject({ account: ACME, activity: 'idle', itemCount: 1, lastSyncedAt: T0 });
  });

  it('runs Sync now and cadence changes', async () => {
    sync.handle(accounts());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    sync.handle({ type: 'sync-command', command: { op: 'set-cadence', account: ACME, minutes: 60 } });
    sync.handle({ type: 'sync-command', command: { op: 'refresh', account: ACME } });
    await vi.advanceTimersByTimeAsync(1);

    expect(endpointsSeen).toHaveLength(2);
    expect(lastStatus()).toMatchObject({ cadenceMinutes: 60, nextSyncAt: T0 + 5 * 60_000 + 60 * 60_000 });
  });

  it('pauses while the machine sleeps', async () => {
    sync.handle({ type: 'system-state', awake: false, online: true });
    sync.handle(accounts());
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(endpointsSeen).toEqual([]);
    expect(lastStatus()?.activity).toBe('asleep');
  });

  it('tells the main process when Linear refuses an Account’s sign-in', async () => {
    refuse = true;
    sync.handle(accounts());
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toContainEqual({ type: 'account-refused', account: ACME });
  });

  it('stops a removed Account before its Items are removed', async () => {
    sync.handle(accounts());
    await vi.advanceTimersByTimeAsync(1);
    sync.forget(ACME);

    expect(store.syncState.get(ACME)).toBeNull();
    expect(lastStatus()).toBeUndefined();
  });

  it('leaves other messages alone and drops malformed sync messages', () => {
    expect(sync.handle({ type: 'item-store-request', id: 1 })).toBe(false);
    expect(sync.handle({ type: 'sync-command', command: { op: 'explode' } })).toBe(true);
    expect(sync.handle({ type: 'sync-accounts', accounts: 'everything' })).toBe(true);
    expect(sent).toEqual([]);
  });
});
