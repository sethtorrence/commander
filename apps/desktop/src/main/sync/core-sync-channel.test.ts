import type { AccountSyncStatus } from '@commander/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCoreSyncChannel } from './core-sync-channel';

// The main process's side of sync: it tells the Core which Accounts to sync and what the User asked
// for, and keeps the Core's latest sync status for Settings → Accounts.

const endpoints = { linear: 'https://api.linear.app/graphql' };
const status: AccountSyncStatus = {
  account: 'linear:org-acme',
  source: 'linear',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [15, 30, 60],
  lastSyncedAt: 1,
  nextSyncAt: 2,
  itemCount: 3,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
};

function channel() {
  const sent: unknown[] = [];
  const refused: string[] = [];
  const sync = createCoreSyncChannel({
    send: (message) => sent.push(message),
    endpoints,
    onRefused: (account) => refused.push(account),
  });
  return { sync, sent, refused };
}

describe('the Core sync channel', () => {
  it('sends the Accounts to sync, with whether each needs reconnecting and who the User is there', () => {
    const { sync, sent } = channel();
    sync.setAccounts([
      { id: 'linear:org-acme', source: 'linear', status: 'connected', user: { id: 'user-me', name: 'Sam' } },
      { id: 'linear:org-globex', source: 'linear', status: 'needs-reconnect', user: null },
    ]);

    expect(sent).toEqual([
      {
        type: 'sync-accounts',
        accounts: [
          { id: 'linear:org-acme', source: 'linear', needsReconnect: false, me: 'user-me' },
          { id: 'linear:org-globex', source: 'linear', needsReconnect: true, me: null },
        ],
        endpoints,
      },
    ]);
  });

  it('sends an Account carrying several Sources with those switched on, and none when all are off', () => {
    const { sync, sent } = channel();
    const google = (gmail: boolean, calendar: boolean) => ({
      id: 'google:1045',
      source: 'google' as const,
      status: 'connected' as const,
      user: { id: '1045', name: 'Alex' },
      sources: [
        { source: 'gmail' as const, granted: true, enabled: gmail },
        { source: 'google-calendar' as const, granted: calendar, enabled: calendar },
      ],
    });
    sync.setAccounts([google(true, false)]);
    sync.setAccounts([google(false, false)]);

    expect(sent).toEqual([
      {
        type: 'sync-accounts',
        accounts: [{ id: 'google:1045', sources: ['gmail'], needsReconnect: false, me: '1045' }],
        endpoints,
      },
      { type: 'sync-accounts', accounts: [], endpoints },
    ]);
  });

  it('pauses both Sources of an Outlook Account that needs reconnecting, keeping its identity', () => {
    const { sync, sent } = channel();
    sync.setAccounts([
      {
        id: 'outlook:tenant-1:u-sam',
        source: 'outlook',
        status: 'needs-reconnect',
        user: { id: 'u-sam', name: 'Sam' },
        sources: [
          { source: 'outlook', granted: true, enabled: true },
          { source: 'outlook-calendar', granted: true, enabled: true },
        ],
      },
    ]);

    expect(sent).toEqual([
      {
        type: 'sync-accounts',
        accounts: [
          {
            id: 'outlook:tenant-1:u-sam',
            sources: ['outlook', 'outlook-calendar'],
            needsReconnect: true,
            me: 'u-sam',
          },
        ],
        endpoints,
      },
    ]);
  });

  it('keeps a status for each Source of an Account', () => {
    const { sync } = channel();
    const gmail = { ...status, account: 'google:1045', source: 'gmail' as const };
    const calendar = { ...gmail, source: 'google-calendar' as const, itemCount: 9 };
    sync.handle({ type: 'sync-status', accounts: [gmail, calendar] });

    expect(sync.status('google:1045', 'google-calendar')).toEqual(calendar);
    expect(sync.status('google:1045', 'gmail')).toEqual(gmail);
    expect(sync.status('google:1045')).toEqual(gmail);
  });

  it('relays Sync now, cadence changes and the machine’s state', () => {
    const { sync, sent } = channel();
    sync.refresh('linear:org-acme');
    sync.refresh('google:1045', 'google-calendar');
    sync.setCadence('linear:org-acme', 30);
    sync.setAlsoAfterOtherSources('teams:tenant-1:u-sam', false);
    sync.systemState({ awake: false, online: true });

    expect(sent).toEqual([
      { type: 'sync-command', command: { op: 'refresh', account: 'linear:org-acme' } },
      { type: 'sync-command', command: { op: 'refresh', account: 'google:1045', source: 'google-calendar' } },
      { type: 'sync-command', command: { op: 'set-cadence', account: 'linear:org-acme', minutes: 30 } },
      {
        type: 'sync-command',
        command: { op: 'set-also-after-other-sources', account: 'teams:tenant-1:u-sam', enabled: false },
      },
      { type: 'system-state', awake: false, online: true },
    ]);
  });

  it('keeps the Core’s latest status per Account and says when it changed', () => {
    const { sync } = channel();
    const changed = vi.fn();
    sync.onChange(changed);

    expect(sync.handle({ type: 'sync-status', accounts: [status] })).toBe(true);

    expect(sync.status('linear:org-acme')).toEqual(status);
    expect(sync.status('linear:org-nope')).toBeNull();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('passes on sign-ins the Source refused', () => {
    const { sync, refused } = channel();
    expect(sync.handle({ type: 'account-refused', account: 'linear:org-acme' })).toBe(true);
    expect(refused).toEqual(['linear:org-acme']);
  });

  it('ignores other messages, and drops malformed sync status', () => {
    const { sync } = channel();
    expect(sync.handle({ type: 'heartbeat', beats: 1, at: 1 })).toBe(false);
    expect(sync.handle({ type: 'sync-status', accounts: [{ account: 'x' }] })).toBe(true);
    expect(sync.status('x')).toBeNull();
  });
});
