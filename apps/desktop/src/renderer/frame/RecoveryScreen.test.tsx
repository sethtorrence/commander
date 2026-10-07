// @vitest-environment jsdom
import type {
  BackupsRequest,
  BackupsResponse,
  BackupsStatus,
  CoreMessage,
  DatabaseRecovery,
} from '@commander/domain';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryScreen } from './RecoveryScreen';

// The recovery screen (#203), against a stand-in bridge: what happened in plain words, Restore of
// the snapshot the Core offers (relaunching Commander), Export everything after a failed update, and
// Quit.

const status: BackupsStatus = {
  snapshots: [],
  problems: [],
  restored: null,
  restoreFailed: null,
  export: null,
};

const damaged: DatabaseRecovery = {
  state: 'damaged',
  problem: 'Tree 12 page 40: btreeInitPage() returns error code 11',
  snapshot: { name: 'commander-2026-10-05.db', kind: 'daily', day: '2026-10-05', time: null, size: 48_000 },
  restoreFailed: null,
};

const updateFailed: DatabaseRecovery = {
  state: 'update-failed',
  migration: '0056_new_things',
  reason: 'no such table: no_such_table',
  snapshot: {
    name: 'commander-before-update-2026-10-06-091502.db',
    kind: 'before-update',
    day: '2026-10-06',
    time: '09:15',
    size: 5_400_000,
  },
  snapshotProblem: null,
  restoreFailed: null,
};

let requests: BackupsRequest[];
let answer: (request: BackupsRequest) => BackupsResponse;
let listeners: ((message: CoreMessage) => void)[];
const quit = vi.fn(async () => {});

beforeEach(() => {
  requests = [];
  listeners = [];
  quit.mockClear();
  answer = (request) => ({ ok: true, status, ...(request.op === 'recover' ? { relaunching: true } : {}) });
  vi.stubGlobal('commander', {
    backups: async (request: BackupsRequest) => {
      requests.push(request);
      return answer(request);
    },
    onCoreMessage: (listener: (message: CoreMessage) => void) => {
      listeners.push(listener);
      return () => {};
    },
    quit,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const button = (name: string | RegExp) => screen.queryByRole('button', { name });

describe('the recovery screen', () => {
  it('says the database is damaged, offers the latest good snapshot and Quit, and nothing else', async () => {
    render(<RecoveryScreen health={damaged} />);
    await act(async () => {});
    expect(screen.getByRole('heading').textContent).toBe('Commander’s database is damaged');
    expect(screen.getByTestId('recovery-offer').textContent).toContain(
      'the daily snapshot of Mon 5 Oct 2026',
    );
    expect(screen.getByTestId('recovery-problem').textContent).toBe(damaged.problem);
    expect(button(/Export/)).toBeNull();

    act(() => button('Restore the latest good snapshot')?.click());
    expect(await screen.findByTestId('recovery-relaunching')).toBeTruthy();
    expect(requests).toEqual([{ op: 'status' }, { op: 'recover' }]);
    expect(button('Restore the latest good snapshot')).toHaveProperty('disabled', true);

    act(() => button('Quit')?.click());
    expect(quit).toHaveBeenCalledOnce();
  });

  it('offers only Quit when no snapshot passes the check', async () => {
    render(<RecoveryScreen health={{ ...damaged, snapshot: null }} />);
    await act(async () => {});
    expect(screen.getByTestId('recovery-offer').textContent).toContain('nothing to restore');
    expect(screen.getAllByRole('button').map((element) => element.textContent)).toEqual(['Quit']);
  });

  it('says the update failed and nothing changed, with Restore, Export everything and Quit', async () => {
    render(<RecoveryScreen health={updateFailed} />);
    await act(async () => {});
    expect(screen.getByRole('heading').textContent).toBe('Commander couldn’t update its database');
    expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
    expect(screen.getByTestId('recovery-offer').textContent).toContain(
      'the snapshot taken just before the update (Tue 6 Oct 2026 · 09:15)',
    );
    expect(screen.getByTestId('recovery-problem').textContent).toBe('no such table: no_such_table');
    expect(screen.getByText('What failed · 0056_new_things')).toBeTruthy();
    expect(screen.getAllByRole('button').map((element) => element.textContent)).toEqual([
      'Restore the pre-update snapshot',
      'Export everything…',
      'Quit',
    ]);

    act(() => button('Export everything…')?.click());
    await act(async () => {});
    expect(requests.at(-1)).toEqual({ op: 'export' });
    act(() => {
      for (const listener of listeners)
        listener({
          type: 'backups-status',
          status: {
            ...status,
            export: {
              state: 'done',
              step: 'readme',
              done: 1,
              total: 1,
              folder: '/home/me/Backups/Commander export 2026-10-06 09.20',
              error: null,
              startedAt: 1,
            },
          },
        });
    });
    expect(screen.getByTestId('recovery-export-done').textContent).toContain(
      'Commander export 2026-10-06 09.20',
    );
  });

  it('says why there is no pre-update snapshot, and why a restore failed', async () => {
    render(
      <RecoveryScreen
        health={{
          ...updateFailed,
          snapshot: null,
          snapshotProblem: 'The copy couldn’t be written: database or disk is full',
          restoreFailed: 'That snapshot fails its integrity check, so it can’t be restored: page 3',
        }}
      />,
    );
    await act(async () => {});
    expect(screen.getByTestId('recovery-offer').textContent).toContain(
      'The snapshot before the update couldn’t be taken: The copy couldn’t be written',
    );
    expect(screen.getByTestId('recovery-restore-failed').textContent).toContain(
      'so the database is as it was',
    );
    expect(button(/Restore/)).toBeNull();
  });
});
