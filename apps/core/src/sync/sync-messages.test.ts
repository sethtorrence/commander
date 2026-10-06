import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreAccountRefused, CoreChannelPostsRefused, CoreSyncStatus } from '@commander/domain';
import { SignInRefused, type SourceAdapter } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTokenUnavailable } from '../access-tokens';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpSync } from '.';

// The Core's side of the sync messages with the main process: Accounts, commands and the machine's
// state in; sync status and refused sign-ins out.

const T0 = Date.UTC(2026, 9, 3, 9);
const ACME = 'linear:org-acme';
const TEAMS = 'teams:tenant-1:u-sam';
const endpoints = { linear: 'http://127.0.0.1:9/graphql', graph: 'http://127.0.0.1:9/v1.0' };

let dir: string;
let store: ItemStore;
let sent: (CoreSyncStatus | CoreAccountRefused | CoreChannelPostsRefused)[];
let endpointsSeen: string[];
let refuse: boolean;
let tokenGone: boolean;
let accountsHeard: number;
let sync: ReturnType<typeof setUpSync>;

function adapterFor(apiUrl: () => string): SourceAdapter {
  return {
    source: 'linear',
    cadence: { defaultMinutes: 15, choices: [15, 30, 60] },
    async sync(request) {
      endpointsSeen.push(apiUrl());
      if (refuse) throw new SignInRefused('Linear refused this Account’s sign-in.');
      if (tokenGone) await request.accessToken();
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
  tokenGone = false;
  accountsHeard = 0;
  sync = setUpSync(store, {
    send: (message) => sent.push(message),
    accessTokens: {
      request: async () => {
        if (tokenGone)
          throw new AccessTokenUnavailable('needs-reconnect', 'This Account needs reconnecting.');
        return { token: 'secret', kind: 'api-key' };
      },
    },
    onAccountsChanged: () => {
      accountsHeard += 1;
    },
    linearSource: ({ apiUrl }) => adapterFor(apiUrl),
    teamsSource: ({ graphUrl }) => ({
      source: 'teams',
      cadence: { defaultMinutes: 1440, choices: [1440], alsoAfterOtherSources: true },
      async sync() {
        endpointsSeen.push(graphUrl());
        return { cursor: { chats: {} }, cost: { requests: 1, complexity: null } };
      },
    }),
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

  it('recognises the User among People from the handles each Account names as theirs', () => {
    sync.handle({
      type: 'sync-accounts',
      accounts: [
        { id: ACME, source: 'linear', needsReconnect: false, own: { handles: ['linear:u-me'], name: 'Sam' } },
        {
          id: TEAMS,
          source: 'teams',
          needsReconnect: false,
          own: { handles: ['teams:u-sam', 'sam@contoso.test'], name: 'Sam Rivera' },
        },
      ],
      endpoints,
    });
    const me = store.people.list().filter((person) => person.isUser);
    expect(me.map((person) => person.handles.map((each) => each.handle))).toEqual([
      ['linear:u-me', 'teams:u-sam', 'sam@contoso.test'],
    ]);
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

  it('syncs Teams at the Graph endpoint named, and switches its checks alongside other Sources', async () => {
    sync.handle({
      type: 'sync-accounts',
      accounts: [{ id: TEAMS, source: 'teams', needsReconnect: false }],
      endpoints,
    });
    await vi.advanceTimersByTimeAsync(1);
    sync.handle({
      type: 'sync-command',
      command: { op: 'set-also-after-other-sources', account: TEAMS, enabled: false },
    });

    expect(endpointsSeen).toEqual([endpoints.graph]);
    expect(lastStatus()).toMatchObject({
      account: TEAMS,
      cadenceMinutes: 1440,
      alsoAfterOtherSources: false,
    });
  });

  it('takes Accounts listed with the Sources they carry, and commands naming one of them', async () => {
    sync.handle({
      type: 'sync-accounts',
      // A Google Account with no adapter in the Core yet is left alone.
      accounts: [
        { id: ACME, sources: ['linear'], needsReconnect: false },
        { id: 'google:1045', sources: ['gmail', 'google-calendar'], needsReconnect: false },
      ],
      endpoints,
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    sync.handle({
      type: 'sync-command',
      command: { op: 'set-cadence', account: ACME, source: 'linear', minutes: 30 },
    });
    sync.handle({ type: 'sync-command', command: { op: 'refresh', account: ACME, source: 'linear' } });
    await vi.advanceTimersByTimeAsync(1);

    expect(endpointsSeen).toEqual([endpoints.linear, endpoints.linear]);
    expect(lastStatus()).toMatchObject({ account: ACME, source: 'linear', cadenceMinutes: 30 });
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

    expect(store.syncState.get(ACME, 'linear')).toBeNull();
    expect(lastStatus()).toBeUndefined();
  });

  it('knows every Account listed: its Sources, its name, who the User is there (their addresses too), and whether it needs reconnecting', async () => {
    sync.handle({
      type: 'sync-accounts',
      accounts: [
        { id: ACME, source: 'linear', needsReconnect: false, me: 'user-sam', name: 'Acme' },
        {
          id: 'google:1045',
          sources: ['gmail'],
          needsReconnect: true,
          me: '1045',
          own: { handles: ['sam@acme.test'], name: 'Sam' },
        },
      ],
      endpoints,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.accounts()).toEqual([
      { account: ACME, sources: ['linear'], name: 'Acme', addresses: [], needsReconnect: false },
      {
        account: 'google:1045',
        sources: ['gmail'],
        name: null,
        addresses: ['sam@acme.test'],
        needsReconnect: true,
      },
    ]);
    expect(sync.me(ACME)).toBe('user-sam');
    expect(sync.me('linear:org-other')).toBeNull();
    expect(accountsHeard).toBeGreaterThan(0);
  });

  it('an Account whose sign-in a sync found gone needs reconnecting, before the main process says so', async () => {
    sync.handle(accounts());
    await vi.advanceTimersByTimeAsync(1);
    const heard = accountsHeard;
    tokenGone = true;
    sync.handle({ type: 'sync-command', command: { op: 'refresh', account: ACME } });
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.accounts()).toEqual([
      { account: ACME, sources: ['linear'], name: null, addresses: [], needsReconnect: true },
    ]);
    expect(accountsHeard).toBeGreaterThan(heard);
  });

  it('leaves other messages alone and drops malformed sync messages', () => {
    expect(sync.handle({ type: 'item-store-request', id: 1 })).toBe(false);
    expect(sync.handle({ type: 'sync-command', command: { op: 'explode' } })).toBe(true);
    expect(sync.handle({ type: 'sync-accounts', accounts: 'everything' })).toBe(true);
    expect(sent).toEqual([]);
  });
});
