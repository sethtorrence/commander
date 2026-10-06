import type { AccountSyncStatus, GoogleAccountSummary, OutlookAccountSummary } from '@commander/domain/ipc';
import { describe, expect, it } from 'vitest';
import { emailAccountsOf, emailAddressOf, emailSyncLine, mailSourceOf, threadTime } from './email';

// The Email Section's wording: its status line, and when each thread last had mail.

const NOW = new Date(2026, 9, 3, 15, 30);

const status = (overrides: Partial<AccountSyncStatus> = {}): AccountSyncStatus => ({
  account: 'google:1',
  source: 'gmail',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [5, 10, 15, 30, 60],
  lastSyncedAt: new Date(2026, 9, 3, 14, 2).getTime(),
  nextSyncAt: null,
  itemCount: 120,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
  ...overrides,
});

const google = (
  id: string,
  email: string,
  sync: AccountSyncStatus | null,
  gmail = true,
): GoogleAccountSummary => ({
  id,
  source: 'google',
  name: `Google · ${email}`,
  email,
  method: 'oauth',
  status: 'connected',
  user: null,
  sync,
  sources: [
    { source: 'gmail', granted: true, enabled: gmail },
    { source: 'google-calendar', granted: true, enabled: true },
  ],
});

describe('emailSyncLine', () => {
  it('says when mail last synced', () => {
    expect(emailSyncLine([google('google:1', 'alex@gmail.test', status())], NOW)).toEqual({
      text: 'Synced 14:02',
      problem: false,
      syncing: false,
    });
  });

  it('shows the first download’s progress', () => {
    const downloading = status({
      activity: 'syncing',
      lastSyncedAt: null,
      progress: { done: 1240, total: 3000 },
    });

    expect(emailSyncLine([google('google:1', 'alex@gmail.test', downloading)], NOW)).toEqual({
      text: 'Downloading 30 days: 1,240 of ~3,000',
      problem: false,
      syncing: true,
    });
  });

  it('says what went wrong, and names each Account when there are several', () => {
    const limited = status({
      account: 'google:2',
      problem: { kind: 'rate-limited', message: 'Gmail asked Commander to slow down.' },
    });

    expect(
      emailSyncLine(
        [google('google:1', 'alex@gmail.test', status()), google('google:2', 'sam@work.test', limited)],
        NOW,
      ),
    ).toEqual({
      text: 'alex@gmail.test synced 14:02 · sam@work.test: Gmail asked Commander to slow down.',
      problem: true,
      syncing: false,
    });
  });

  it('reads Gmail’s own sync when the Account carries several Sources', () => {
    const account = google(
      'google:1',
      'alex@gmail.test',
      status({ source: 'google-calendar', problem: { kind: 'failed', message: 'Calendar trouble' } }),
    );
    account.sources = [
      { source: 'gmail', granted: true, enabled: true, sync: status() },
      { source: 'google-calendar', granted: true, enabled: true, sync: account.sync },
    ];

    expect(emailSyncLine([account], NOW).text).toBe('Synced 14:02');
  });

  it('says when no email Account is connected', () => {
    expect(emailSyncLine([], NOW).text).toBe('No email Account connected');
  });
});

const outlook = (
  id: string,
  upn: string,
  sync: AccountSyncStatus | null,
  mail = true,
): OutlookAccountSummary => ({
  id,
  source: 'outlook',
  name: `Outlook · ${upn}`,
  userPrincipalName: upn,
  method: 'oauth',
  status: 'connected',
  user: null,
  sync,
  sources: [
    { source: 'outlook', granted: true, enabled: mail, sync },
    { source: 'outlook-calendar', granted: true, enabled: true, sync: null },
  ],
});

describe('emailAccountsOf', () => {
  it('keeps the Google Accounts with Gmail on and the Outlook Accounts with mail on (#136)', () => {
    const accounts = [
      google('google:1', 'alex@gmail.test', null),
      google('google:2', 'sam@x.test', null, false),
      outlook('outlook:1', 'sam@contoso.test', null),
      outlook('outlook:2', 'sam@fabrikam.test', null, false),
    ];

    const kept = emailAccountsOf(accounts);
    expect(kept.map((account) => account.id)).toEqual(['google:1', 'outlook:1']);
    expect(kept.map(emailAddressOf)).toEqual(['alex@gmail.test', 'sam@contoso.test']);
    expect(kept.map(mailSourceOf)).toEqual(['gmail', 'outlook']);
  });

  it('names each Account by its address in the status line, its mail’s sync whichever Source it carries', () => {
    const line = emailSyncLine(
      [
        google('google:1', 'alex@gmail.test', status()),
        outlook(
          'outlook:1',
          'sam@contoso.test',
          status({ account: 'outlook:1', source: 'outlook', progress: { done: 3, total: 9 } }),
        ),
      ],
      NOW,
    );
    expect(line.text).toBe('alex@gmail.test synced 14:02 · sam@contoso.test downloading 30 days: 3 of ~9');
  });
});

describe('threadTime', () => {
  it('shows the time today, then the day, then the year', () => {
    expect(threadTime(new Date(2026, 9, 3, 9, 5).getTime(), NOW)).toBe('09:05');
    expect(threadTime(new Date(2026, 9, 2, 23, 0).getTime(), NOW)).toBe('Yesterday');
    expect(threadTime(new Date(2026, 8, 28, 10, 0).getTime(), NOW)).toBe('28 Sep');
    expect(threadTime(new Date(2025, 11, 30, 10, 0).getTime(), NOW)).toBe('30 Dec 2025');
  });
});
