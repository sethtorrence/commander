// @vitest-environment jsdom
import type {
  AccountSyncStatus,
  AccountsState,
  BackupsStatus,
  CoreMessage,
  CoreStatus,
  Diagnostics as DiagnosticsInfo,
  DiagnosticsReport,
  DiagnosticsRequest,
  SyncRunInfo,
} from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Diagnostics } from './Diagnostics';
import { coreHealth, databaseText, LATE_BEAT_MS, runText } from './diagnostics';

// Settings → Diagnostics in plain words (#207), against a stand-in bridge. Times are made in local
// time and read back in it, so the tests pass in any time zone and just after midnight.

const at = (hours: number, minutes: number) => new Date(2026, 9, 6, hours, minutes).getTime();
const NOW = at(0, 2);

const running: CoreStatus = {
  state: 'running',
  restartAt: null,
  restarts: 0,
  lastStop: null,
  database: { state: 'ok' },
};

const run = (fields: Partial<SyncRunInfo> = {}): SyncRunInfo => ({
  account: 'linear:1',
  source: 'linear',
  trigger: 'scheduled',
  startedAt: at(0, 1),
  finishedAt: at(0, 1) + 1_200,
  outcome: 'synced',
  created: 3,
  updated: 2,
  tombstoned: 0,
  unchanged: 10,
  requests: 4,
  error: null,
  ...fields,
});

describe('coreHealth', () => {
  it('is healthy while the Core runs and beats', () => {
    expect(coreHealth(running, NOW - 1_000, NOW)).toEqual({ word: 'Healthy', well: true, detail: null });
  });

  it('says when the Core has stopped answering, is starting again, or stopped for good', () => {
    expect(coreHealth(running, NOW - LATE_BEAT_MS - 2_000, NOW)).toMatchObject({
      word: 'Not answering',
      well: false,
      detail: expect.stringContaining('No heartbeat for 7 s'),
    });
    expect(coreHealth({ ...running, state: 'restarting', restartAt: at(0, 3) }, null, NOW)).toMatchObject({
      word: 'Starting again',
      detail: 'It stopped; a new one starts at 00:03.',
    });
    expect(coreHealth({ ...running, state: 'stopped' }, null, NOW)).toMatchObject({
      word: 'Stopped',
      well: false,
    });
    expect(coreHealth(running, null, NOW)).toMatchObject({ word: 'Starting', well: false });
    expect(
      coreHealth(
        {
          ...running,
          database: { state: 'damaged', problem: 'page 4 is broken', snapshot: null, restoreFailed: null },
        },
        NOW,
        NOW,
      ),
    ).toMatchObject({ word: 'Limited', well: false });
  });
});

describe('databaseText', () => {
  it('says how the database is', () => {
    const now = new Date(NOW);
    expect(databaseText({ state: 'ok' }, now)).toBe('Healthy');
    expect(databaseText({ state: 'disk-full', since: at(0, 1) }, now)).toBe('Disk full since 00:01');
    expect(databaseText(null, now)).toBe('…');
  });
});

describe('runText', () => {
  it('says what a run did, or why it didn’t finish', () => {
    expect(runText(run())).toEqual({ outcome: 'Synced', what: 'on schedule · 3 new, 2 updated' });
    expect(runText(run({ created: 0, updated: 0, trigger: 'refresh' }))).toEqual({
      outcome: 'Synced',
      what: 'asked for · nothing new',
    });
    expect(runText(run({ outcome: 'failed', error: 'Linear didn’t answer' }))).toEqual({
      outcome: 'Failed',
      what: 'on schedule · Linear didn’t answer',
    });
  });
});

const info: DiagnosticsInfo = {
  displayServer: 'wayland',
  displaySource: 'compositor',
  passwordStore: 'gnome-libsecret',
  version: '0.1.0',
  electron: '44.5.1',
  chrome: '150.0.0.0',
  node: '24.1.0',
  os: 'linux 7.2.7 (x64)',
};

const linearSync: AccountSyncStatus = {
  account: 'linear:1',
  source: 'linear',
  activity: 'idle',
  cadenceMinutes: 15,
  cadenceChoices: [15, 30, 60],
  lastSyncedAt: at(0, 1),
  nextSyncAt: at(0, 16),
  itemCount: 12,
  problem: null,
  outgoing: { pending: 0, failed: 0 },
};

const accounts: AccountsState = {
  sources: [],
  accounts: [
    {
      id: 'linear:1',
      source: 'linear',
      name: 'Acme',
      method: 'api-key',
      status: 'connected',
      user: null,
      sync: linearSync,
      urlKey: 'acme',
    },
  ],
};

const report: DiagnosticsReport = {
  runs: [
    run({ outcome: 'failed', error: 'Linear didn’t answer', startedAt: at(0, 1) }),
    run({ startedAt: at(0, 0) }),
  ],
  syncs: [linearSync],
  database: { migration: '0055_conversation_made', migrated: [] },
  couldntSync: [
    { account: 'linear:1', source: 'linear', count: 2, error: 'The issue is locked for editing.' },
  ],
  snapshots: [],
  snapshotProblems: [],
  settings: {},
};

const backups: BackupsStatus = {
  snapshots: [
    { name: 'commander-2026-10-06.db', kind: 'daily', day: '2026-10-06', time: null, size: 48_000 },
  ],
  problems: [],
  restored: null,
  restoreFailed: null,
  export: null,
};

let requests: DiagnosticsRequest[];
let coreListeners: ((message: CoreMessage) => void)[];

beforeEach(() => {
  requests = [];
  coreListeners = [];
  vi.stubGlobal('commander', {
    diagnostics: async () => info,
    coreStatus: async () => running,
    onCoreStatus: () => () => {},
    onCoreMessage: (listener: (message: CoreMessage) => void) => {
      coreListeners.push(listener);
      return () => {};
    },
    accounts: async () => ({ ok: true, state: accounts }),
    onAccountsChanged: () => () => {},
    backups: async () => ({ ok: true, status: backups }),
    diagnosticsReport: async (request: DiagnosticsRequest) => {
      requests.push(request);
      return request.op === 'export'
        ? { ok: true, report, exported: '/home/alex/Documents/commander-diagnostics.md' }
        : { ok: true, report };
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings → Diagnostics', () => {
  it('says the Core is healthy once it beats, with each Account’s syncs, recent runs and versions', async () => {
    render(<Diagnostics no="01" />);
    const health = screen.getByTestId('core-health');
    act(() => {
      for (const listener of coreListeners) listener({ type: 'heartbeat', beats: 7, at: Date.now() });
    });
    await waitFor(() => expect(health.textContent).toContain('Healthy'));
    expect(health.getAttribute('data-beats')).toBe('7');
    expect(screen.getByTestId('diagnostics-database').textContent).toContain('Healthy');
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-migration').textContent).toContain('0055_conversation_made'),
    );

    const account = await screen.findByTestId('diagnostics-account');
    expect(account.textContent).toContain('Acme · Linear');
    expect(within(account).getByTestId('diagnostics-account-synced').textContent).toMatch(
      /^Synced (\d+ \w+ )?00:01 · 12 issues$/,
    );
    expect(within(account).getByTestId('diagnostics-account-next').textContent).toMatch(
      /^Next sync (\d+ \w+ )?00:16$/,
    );

    expect(within(account).getByTestId('diagnostics-account-couldnt-sync').textContent).toBe(
      'Couldn’t sync: 2 changes · The issue is locked for editing.',
    );

    const runs = screen.getAllByTestId('diagnostics-run');
    expect(runs.map((each) => each.getAttribute('data-outcome'))).toEqual(['failed', 'synced']);
    expect(runs[0]?.textContent).toContain('Acme · Linear');
    expect(runs[0]?.textContent).toContain('Failed on schedule · Linear didn’t answer');

    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-snapshot').textContent).toContain('Tue 6 Oct 2026'),
    );
    expect(screen.getByTestId('diagnostics-version').textContent).toContain('0.1.0');
    expect(screen.getByTestId('password-store').textContent).toContain('gnome-libsecret');
  });

  it('exports diagnostics through main, and says where', async () => {
    render(<Diagnostics no="01" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics…' }));
    expect((await screen.findByTestId('diagnostics-exported')).textContent).toContain(
      'Exported to /home/alex/Documents/commander-diagnostics.md',
    );
    expect(requests.map((request) => request.op)).toContain('export');
  });

  it('says when there are no Accounts or runs yet', async () => {
    vi.stubGlobal('commander', {
      ...window.commander,
      accounts: async () => ({ ok: true, state: { sources: [], accounts: [] } }),
      diagnosticsReport: async () => ({ ok: true, report: { ...report, runs: [] } }),
    });
    render(<Diagnostics no="01" />);
    expect((await screen.findByTestId('diagnostics-no-accounts')).textContent).toContain('No Accounts yet.');
    expect((await screen.findByTestId('diagnostics-no-runs')).textContent).toContain('None yet.');
  });
});
