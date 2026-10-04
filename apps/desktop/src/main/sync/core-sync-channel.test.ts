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
  it('sends the Accounts to sync, with whether each needs reconnecting', () => {
    const { sync, sent } = channel();
    sync.setAccounts([
      { id: 'linear:org-acme', source: 'linear', status: 'connected' },
      { id: 'linear:org-globex', source: 'linear', status: 'needs-reconnect' },
    ]);

    expect(sent).toEqual([
      {
        type: 'sync-accounts',
        accounts: [
          { id: 'linear:org-acme', source: 'linear', needsReconnect: false },
          { id: 'linear:org-globex', source: 'linear', needsReconnect: true },
        ],
        endpoints,
      },
    ]);
  });

  it('relays Sync now, cadence changes and the machine’s state', () => {
    const { sync, sent } = channel();
    sync.refresh('linear:org-acme');
    sync.setCadence('linear:org-acme', 30);
    sync.systemState({ awake: false, online: true });

    expect(sent).toEqual([
      { type: 'sync-command', command: { op: 'refresh', account: 'linear:org-acme' } },
      { type: 'sync-command', command: { op: 'set-cadence', account: 'linear:org-acme', minutes: 30 } },
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
