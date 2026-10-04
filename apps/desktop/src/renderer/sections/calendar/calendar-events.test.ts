import type { AccountSummary, AccountsRequest, AccountsState } from '@commander/domain/ipc';
import { describe, expect, it } from 'vitest';
import { calendarAccountsIn, calendarSyncLine } from './calendar-events';

// The calendar Accounts as the Calendar Section sees them: Google Accounts with Google Calendar on
// and Outlook Accounts with Outlook Calendar on, each refreshed through its own calendar Source.

const base = { method: 'oauth', status: 'connected', user: null, sync: null } as const;
const google = (calendar: boolean): AccountSummary => ({
  ...base,
  id: 'google:1',
  source: 'google',
  name: 'Google · alex@gmail.test',
  email: 'alex@gmail.test',
  sources: [
    { source: 'gmail', granted: true, enabled: true },
    { source: 'google-calendar', granted: true, enabled: calendar },
  ],
});
const outlook = (calendar: boolean): AccountSummary => ({
  ...base,
  id: 'outlook:t:u',
  source: 'outlook',
  name: 'Outlook · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  sources: [
    { source: 'outlook', granted: true, enabled: true },
    { source: 'outlook-calendar', granted: true, enabled: calendar },
  ],
});
const teams: AccountSummary = {
  ...base,
  id: 'teams:t:u',
  source: 'teams',
  name: 'Teams · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
};

function bridge(accounts: AccountSummary[]) {
  const asked: AccountsRequest[] = [];
  const state: AccountsState = { accounts, sources: [] };
  return {
    asked,
    accounts: async (request: AccountsRequest) => {
      asked.push(request);
      return { ok: true as const, state };
    },
    onAccountsChanged: () => () => {},
  };
}

describe('the calendar Accounts', () => {
  it('lists Google and Outlook Accounts with their calendar Source on, and nothing else', async () => {
    const client = calendarAccountsIn(bridge([google(true), outlook(true), teams, outlook(false)]));
    expect((await client.list()).map((account) => account.id)).toEqual(['google:1', 'outlook:t:u']);
    const off = calendarAccountsIn(bridge([google(false), outlook(false)]));
    expect(await off.list()).toEqual([]);
  });

  it('refreshes each Account through its own calendar Source', async () => {
    const accounts = bridge([google(true), outlook(true)]);
    const client = calendarAccountsIn(accounts);
    await client.refresh('outlook:t:u');
    await client.refresh('google:1');
    expect(accounts.asked.filter((request) => request.op === 'sync-now')).toEqual([
      { op: 'sync-now', accountId: 'outlook:t:u', source: 'outlook-calendar' },
      { op: 'sync-now', accountId: 'google:1', source: 'google-calendar' },
    ]);
  });

  it('says when no calendar is connected', () => {
    expect(calendarSyncLine([], new Date())).toEqual({ text: 'No calendar connected', problem: false });
  });
});
