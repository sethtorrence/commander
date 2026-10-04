// @vitest-environment jsdom
import type {
  AccountSyncStatus,
  AccountsRequest,
  LinearAccountSummary,
  TeamsAccountSummary,
} from '@commander/domain/ipc';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSync } from './AccountSync';

// One Account's sync in Settings → Accounts: Teams shows its last check, its next full sync, and the
// switch for checking whenever another Source syncs, with Microsoft's caveat under it.

const at = (hours: number, minutes: number, day = 3) => new Date(2026, 9, day, hours, minutes).getTime();

const status: AccountSyncStatus = {
  account: 'teams:tenant-1:u-sam',
  source: 'teams',
  activity: 'idle',
  cadenceMinutes: 1440,
  cadenceChoices: [1440],
  lastSyncedAt: at(14, 2),
  nextSyncAt: at(9, 0, 4),
  itemCount: 12,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
  alsoAfterOtherSources: true,
};

const teams: TeamsAccountSummary = {
  id: 'teams:tenant-1:u-sam',
  source: 'teams',
  name: 'Teams · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  method: 'oauth',
  status: 'connected',
  user: { id: 'u-sam', name: 'Sam Rivera' },
  sync: status,
};

const linear: LinearAccountSummary = {
  id: 'linear:org-acme',
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'oauth',
  status: 'connected',
  user: null,
  sync: {
    ...status,
    account: 'linear:org-acme',
    source: 'linear',
    cadenceMinutes: 15,
    cadenceChoices: [15, 30, 60],
    alsoAfterOtherSources: undefined,
  },
};

// The fixtures happen on 3 October 2026; pin today there so times read as "today" on any date.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 3, 15, 0));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function show(account: TeamsAccountSummary | LinearAccountSummary) {
  const requests: AccountsRequest[] = [];
  render(<AccountSync account={account} request={(request) => requests.push(request)} />);
  return requests;
}

describe('a Teams Account’s sync', () => {
  it('shows the last check, the next full sync, and that it syncs fully once a day', () => {
    show(teams);

    expect(screen.getByTestId('account-synced').textContent).toBe('Checked 14:02 · 12 chats');
    expect(screen.getByTestId('account-next-sync').textContent).toMatch(/^Next full sync /);
    expect(screen.getByText('Full sync once a day')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('offers the switch, on by default, with Microsoft’s caveat, and turns it off', () => {
    const requests = show(teams);
    const toggle = screen.getByRole('switch', { name: 'Also check whenever another Source syncs' });

    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText(
        'Microsoft asks apps to check Teams about once a day. Checking more often risks slower or paused Teams access for Commander.',
      ),
    ).toBeTruthy();
    fireEvent.click(toggle);

    expect(requests).toEqual([
      { op: 'set-sync-also-after-other-sources', accountId: teams.id, enabled: false },
    ]);
  });

  it('checks at once on Sync now', () => {
    const requests = show(teams);

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(requests).toEqual([{ op: 'sync-now', accountId: teams.id }]);
  });
});

describe('a Linear Account’s sync', () => {
  it('offers its cadence choices and no switch', () => {
    show(linear);

    expect(screen.getByRole('combobox', { name: 'How often to sync Acme' })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('a GitHub Account’s sync', () => {
  it('syncs every 15 minutes, the only choice, and shows the last hour’s use of GitHub’s limits', () => {
    show({
      ...linear,
      name: 'octocat',
      sync: {
        ...linear.sync,
        account: 'github:583231',
        source: 'github',
        cadenceChoices: [15],
        hourUse: { requests: 3, complexity: 41, requestLimit: 5000, complexityLimit: 5000 },
      },
    } as unknown as LinearAccountSummary);

    expect(screen.getByText('Syncs every 15 min')).toBeTruthy();
    expect(screen.getByTestId('account-hour-use').textContent).toBe(
      'Last hour: 3 of 5,000 REST requests · 41 of 5,000 GraphQL points',
    );
  });
});
