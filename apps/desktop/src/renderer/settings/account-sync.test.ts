import type { AccountSyncStatus } from '@commander/domain/ipc';
import { describe, expect, it } from 'vitest';
import { describeSync } from './account-sync';

// How Settings → Accounts puts an Account's sync into plain words.

const now = new Date(2026, 9, 3, 14, 10);
const at = (hours: number, minutes: number, day = 3) => new Date(2026, 9, day, hours, minutes).getTime();
const idle: AccountSyncStatus = {
  account: 'linear:org-acme',
  source: 'linear',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [15, 30, 60],
  lastSyncedAt: at(14, 2),
  nextSyncAt: at(14, 17),
  itemCount: 312,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
};

describe('describing an Account’s sync', () => {
  it('says when it last synced, how many issues it holds and when it syncs next', () => {
    expect(describeSync(idle, now)).toEqual({
      synced: 'Synced 14:02 · 312 issues',
      next: 'Next sync 14:17',
      problem: null,
    });
  });

  it('names the day for times not today, and counts one issue', () => {
    expect(describeSync({ ...idle, lastSyncedAt: at(9, 5, 2), itemCount: 1 }, now).synced).toBe(
      'Synced 2 Oct 09:05 · 1 issue',
    );
  });

  it('says so before the first sync, and while syncing', () => {
    expect(
      describeSync({ ...idle, activity: 'syncing', lastSyncedAt: null, itemCount: 0 }, now),
    ).toMatchObject({
      synced: 'Not synced yet',
      next: 'Syncing now…',
    });
  });

  it('explains pauses and back-off in plain words', () => {
    const paused = (activity: AccountSyncStatus['activity']) =>
      describeSync({ ...idle, activity, nextSyncAt: null }, now).next;
    expect(paused('offline')).toBe('Paused while offline');
    expect(paused('asleep')).toBe('Paused while asleep');
    expect(paused('needs-reconnect')).toBe('Paused until reconnected');

    const problem = { kind: 'rate-limited' as const, message: 'Linear asked Commander to slow down.' };
    expect(
      describeSync({ ...idle, activity: 'backing-off', nextSyncAt: at(16, 0), problem }, now),
    ).toMatchObject({
      next: 'Trying again at 16:00',
      problem: 'Linear asked Commander to slow down.',
    });
  });

  it('words a Teams Account as its last check and its next full sync', () => {
    const teams: AccountSyncStatus = {
      ...idle,
      account: 'teams:tenant-1:u-sam',
      source: 'teams',
      cadenceMinutes: 1440,
      cadenceChoices: [1440],
      nextSyncAt: at(9, 0, 4),
      itemCount: 12,
      alsoAfterOtherSources: true,
    };

    expect(describeSync(teams, now)).toEqual({
      synced: 'Checked 14:02 · 12 chats',
      next: 'Next full sync 4 Oct 09:00',
      problem: null,
    });
  });
});
