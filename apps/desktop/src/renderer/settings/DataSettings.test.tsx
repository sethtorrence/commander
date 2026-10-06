// @vitest-environment jsdom
import type { BackupsRequest, BackupsResponse, BackupsStatus, CoreMessage } from '@commander/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayLabel, ExportSettings, SnapshotSettings, sizeLabel } from './DataSettings';

// Settings → Data's snapshots and Export everything (#202), against a stand-in bridge: the list,
// Restore's typed confirmation, and an export's progress and Cancel.

const status: BackupsStatus = {
  snapshots: [
    {
      name: 'commander-before-update-2026-10-06-091502.db',
      kind: 'before-update',
      day: '2026-10-06',
      time: '09:15',
      size: 5_400_000,
    },
    { name: 'commander-2026-10-05.db', kind: 'daily', day: '2026-10-05', time: null, size: 48_000 },
  ],
  problems: [],
  restored: null,
  restoreFailed: null,
  export: null,
};

let requests: BackupsRequest[];
let answer: (request: BackupsRequest) => BackupsResponse;
let listeners: ((message: CoreMessage) => void)[];

beforeEach(() => {
  requests = [];
  listeners = [];
  answer = () => ({ ok: true, status });
  vi.stubGlobal('commander', {
    backups: async (request: BackupsRequest) => {
      requests.push(request);
      return answer(request);
    },
    onCoreMessage: (listener: (message: CoreMessage) => void) => {
      listeners.push(listener);
      return () => {};
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const push = (next: BackupsStatus) =>
  act(() => {
    for (const listener of listeners) listener({ type: 'backups-status', status: next });
  });

describe('the snapshots', () => {
  it('lists each with its date, kind and size, newest first', async () => {
    render(<SnapshotSettings no="01" />);
    const rows = await screen.findAllByTestId('snapshot');
    expect(rows.map((row) => within(row).getByTestId('snapshot-when').textContent)).toEqual([
      'Tue 6 Oct 2026 · 09:15',
      'Mon 5 Oct 2026',
    ]);
    expect(rows.map((row) => within(row).getByTestId('snapshot-kind').textContent)).toEqual([
      'Before update',
      'Daily',
    ]);
    expect(rows.map((row) => within(row).getByTestId('snapshot-size').textContent)).toEqual([
      '5.1 MB',
      '47 KB',
    ]);
  });

  it('restores only once “restore” is typed, then says Commander is relaunching', async () => {
    answer = (request) =>
      request.op === 'restore' ? { ok: true, status, relaunching: true } : { ok: true, status };
    render(<SnapshotSettings no="01" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Mon 5 Oct 2026' }));
    const confirm = screen.getByTestId('restore-confirm');
    const restore = within(confirm).getByRole('button', { name: 'Restore and relaunch' });
    expect(restore).toHaveProperty('disabled', true);

    fireEvent.change(within(confirm).getByLabelText(/to confirm/), { target: { value: 'restor' } });
    expect(restore).toHaveProperty('disabled', true);
    fireEvent.change(within(confirm).getByLabelText(/to confirm/), { target: { value: 'restore' } });
    expect(restore).toHaveProperty('disabled', false);
    fireEvent.click(restore);

    await screen.findByTestId('restore-relaunching');
    expect(requests.at(-1)).toEqual({
      op: 'restore',
      name: 'commander-2026-10-05.db',
      confirmation: 'restore',
    });
    expect(screen.queryByTestId('restore-confirm')).toBeNull();
  });

  it('shows a snapshot that failed, and a restore made at this start', async () => {
    render(<SnapshotSettings no="01" />);
    await screen.findAllByTestId('snapshot');
    push({
      ...status,
      problems: [{ kind: 'daily', at: new Date(2026, 9, 6, 9, 5).getTime(), reason: 'Disk full.' }],
      restored: {
        name: 'commander-2026-10-05.db',
        at: 1,
        keptAside: 'commander-before-restore-2026-10-06-120000.db',
      },
    });
    expect(screen.getByTestId('snapshot-problem').textContent).toBe(
      'Today’s snapshot failed at 09:05 and was discarded; the older snapshots are all kept. Disk full.',
    );
    expect(screen.getByTestId('restore-done').textContent).toMatch(
      /^Restored the daily snapshot of Mon 5 Oct 2026\. The database as it was is kept as the before restore snapshot of Tue 6 Oct 2026 · 12:00/,
    );
  });
});

describe('Export everything', () => {
  it('shows its progress with Cancel, then where it went', async () => {
    render(<ExportSettings no="02" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export everything…' }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ op: 'export' }));
    const running = {
      state: 'running',
      done: 12,
      total: 140,
      folder: null,
      error: null,
      startedAt: 1,
    } as const;
    push({ ...status, export: { ...running, step: 'daily-notes' } });
    expect(screen.getByTestId('export-step').textContent).toBe('Writing the Daily Notes · 12 of 140');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ op: 'cancel-export' }));

    push({
      ...status,
      export: { ...running, step: 'readme', state: 'done', folder: '/home/me/Commander export' },
    });
    expect(screen.getByTestId('export-folder').textContent).toBe('/home/me/Commander export');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('says why a folder was refused', async () => {
    answer = (request) =>
      request.op === 'export'
        ? { ok: false, error: 'That is Commander’s own data folder.', status }
        : { ok: true, status };
    render(<ExportSettings no="02" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export everything…' }));
    expect((await screen.findByTestId('export-refused')).textContent).toBe(
      'That is Commander’s own data folder.',
    );
  });
});

describe('words', () => {
  it('writes days and sizes plainly', () => {
    expect(dayLabel('2026-10-03')).toBe('Sat 3 Oct 2026');
    expect(sizeLabel(900)).toBe('1 KB');
    expect(sizeLabel(12_400_000)).toBe('12 MB');
    expect(sizeLabel(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
