import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupsStatus, CoreBackupsReply, CoreBackupsRequest } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackupsChannel } from './backups-channel';

// Settings → Data's snapshots and Export everything, in the main process (#202): Restore only after
// the typed confirmation, and only then relaunching; the export's folder only from the system picker,
// checked before the Core hears of it.

let root: string;
let userData: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'commander-backups-main-')));
  userData = join(root, 'userData');
  mkdirSync(userData);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

const status: BackupsStatus = {
  snapshots: [],
  problems: [],
  restored: null,
  restoreFailed: null,
  export: null,
};

type Answer = (request: CoreBackupsRequest['request']) => CoreBackupsReply['response'];
const accepts: Answer = () => ({ ok: true, status });

// A channel whose Core answers every request at once, as `answer` says.
function channel({ chosen = null as string | null, answer = accepts } = {}) {
  const sent: CoreBackupsRequest['request'][] = [];
  const relaunch = vi.fn();
  const backups = createBackupsChannel({
    userData,
    chooseFolder: async () => chosen,
    relaunch,
    relaunchAfterMs: 50,
    send(message) {
      sent.push(message.request);
      queueMicrotask(() =>
        backups.settle({ type: 'backups-reply', id: message.id, response: answer(message.request) }),
      );
    },
  });
  return { backups, sent, relaunch };
}

describe('Restore', () => {
  it('needs the typed confirmation before the Core hears of it', async () => {
    const { backups, sent, relaunch } = channel();
    for (const confirmation of ['', 'yes', 'restor'])
      expect(
        await backups.request({ op: 'restore', name: 'commander-2026-10-03.db', confirmation }),
      ).toMatchObject({ ok: false, error: 'Type “restore” to confirm.' });
    expect(sent.every((request) => request.op === 'status')).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('relaunches Commander once the Core has marked the snapshot, after answering the window', async () => {
    vi.useFakeTimers();
    const { backups, sent, relaunch } = channel();
    const response = await backups.request({
      op: 'restore',
      name: 'commander-2026-10-03.db',
      confirmation: ' Restore ',
    });
    expect(response).toEqual({ ok: true, status, relaunching: true });
    expect(sent).toEqual([{ op: 'restore', name: 'commander-2026-10-03.db' }]);
    expect(relaunch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('never relaunches when the Core refuses the snapshot', async () => {
    vi.useFakeTimers();
    const { backups, relaunch } = channel({
      answer: () => ({ ok: false, error: 'That snapshot is no longer there.', status }),
    });
    expect(
      await backups.request({ op: 'restore', name: 'commander-2026-10-03.db', confirmation: 'restore' }),
    ).toEqual({ ok: false, error: 'That snapshot is no longer there.', status });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a snapshot’s', async () => {
    const { backups, sent } = channel();
    for (const name of ['../secrets.json', 'commander-2026-10-03.db/../../x', 'secrets.json'])
      expect((await backups.request({ op: 'restore', name, confirmation: 'restore' })).ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('the recovery screen’s Restore (#203)', () => {
  it('asks the Core to mark the snapshot it offers, with no typed confirmation, then relaunches', async () => {
    vi.useFakeTimers();
    const { backups, sent, relaunch } = channel();
    expect(await backups.request({ op: 'recover' })).toEqual({ ok: true, status, relaunching: true });
    expect(sent).toEqual([{ op: 'recover' }]);
    await vi.advanceTimersByTimeAsync(50);
    expect(relaunch).toHaveBeenCalledOnce();
    // Once is enough.
    expect(await backups.request({ op: 'recover' })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(1);
  });

  it('never relaunches when there is nothing to restore', async () => {
    vi.useFakeTimers();
    const { backups, relaunch } = channel({
      answer: () => ({ ok: false, error: 'There is no snapshot to restore.', status }),
    });
    expect(await backups.request({ op: 'recover' })).toEqual({
      ok: false,
      error: 'There is no snapshot to restore.',
      status,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('Export everything', () => {
  it('exports into the folder chosen in the system picker', async () => {
    const folder = join(root, 'Backups');
    mkdirSync(folder);
    const { backups, sent } = channel({ chosen: folder });
    expect(await backups.request({ op: 'export' })).toEqual({ ok: true, status });
    expect(sent).toEqual([{ op: 'export', folder }]);
  });

  it('does nothing when the picker is cancelled', async () => {
    const { backups, sent } = channel({ chosen: null });
    expect(await backups.request({ op: 'export' })).toEqual({ ok: true, status });
    expect(sent).toEqual([{ op: 'status' }]);
  });

  it('refuses Commander’s own data folder, and anything in it', async () => {
    mkdirSync(join(userData, 'snapshots'));
    for (const chosen of [userData, join(userData, 'snapshots')]) {
      const { backups, sent } = channel({ chosen });
      expect(await backups.request({ op: 'export' })).toEqual({
        ok: false,
        error: 'That is Commander’s own data folder. Choose a folder outside it, such as one in Documents.',
        status,
      });
      expect(sent).toEqual([{ op: 'status' }]);
    }
  });

  it('passes Cancel on', async () => {
    const { backups, sent } = channel();
    await backups.request({ op: 'cancel-export' });
    expect(sent).toEqual([{ op: 'cancel-export' }]);
  });
});
