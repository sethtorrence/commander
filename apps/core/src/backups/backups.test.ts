import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupsStatus, CoreBackupsReply, CoreMessage, Enqueue } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createUpdateQueue } from '../updates/queue';
import { setUpBackups } from '.';
import { pendingRestore } from './restore';

// The Core's side of Settings → Data (#202): the daily snapshot's failures reported (in the status
// Diagnostics shows, and in Ares's queue for the Update) until one succeeds, a restore marked, and an
// export run through the main process's requests.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dir: string;
let clock: number;
let failing: string | null;
let store: ItemStore;
let sent: (CoreMessage | CoreBackupsReply)[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-backups-'));
  // Local noon, so snapshot names read the same in every time zone.
  clock = new Date(2026, 9, 6, 12).getTime();
  failing = null;
  sent = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
    checkSnapshot: () => failing,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function backups({
  queueReady = true,
  restored = null,
}: {
  queueReady?: boolean;
  restored?: Parameters<typeof setUpBackups>[0]['restored'];
} = {}) {
  const queue = createUpdateQueue({ store: store.updates, now: () => clock });
  let ready = queueReady;
  const set = setUpBackups({
    store,
    dataDir: dir,
    snapshotDir: join(dir, 'snapshots'),
    attachmentsDir: join(dir, 'attachments'),
    send: (message) => sent.push(message),
    restored,
    queue: () => (ready ? queue : undefined),
    now: () => clock,
  });
  return {
    backups: set,
    queue,
    makeReady() {
      ready = true;
      set.queueReady();
    },
  };
}

const lastStatus = (): BackupsStatus | undefined =>
  sent.flatMap((message) => (message.type === 'backups-status' ? [message.status] : [])).at(-1);
const reply = (id: number) =>
  sent.find((message): message is CoreBackupsReply => message.type === 'backups-reply' && message.id === id);

describe('the daily snapshot, reported', () => {
  it('reports a copy that failed its check in the status and the Update, until a later one succeeds', () => {
    const { backups: set, queue } = backups();
    failing = '*** in database main *** Page 7 is never used';
    set.takeDaily();

    expect(readdirSync(join(dir, 'snapshots'))).toEqual([]);
    expect(lastStatus()?.problems).toEqual([
      {
        kind: 'daily',
        at: clock,
        reason: 'The copy failed its integrity check: *** in database main *** Page 7 is never used',
      },
    ]);
    const [line] = queue.list();
    expect(line?.about).toEqual<Enqueue['about']>({
      kind: 'backup-failed',
      what: 'daily-snapshot',
      at: clock,
      reason: 'The copy failed its integrity check: *** in database main *** Page 7 is never used',
    });
    expect(line).toMatchObject({ group: 'fyi', section: 'ares', mergeKey: 'backup-failed:daily-snapshot' });

    // Failing again an hour later is still one line.
    clock += HOUR;
    set.takeDaily();
    expect(queue.list()).toHaveLength(1);

    // The next good one clears it, from the status and from the queue.
    failing = null;
    clock += HOUR;
    set.takeDaily();
    expect(readdirSync(join(dir, 'snapshots'))).toContain('commander-2026-10-06.db');
    expect(lastStatus()?.problems).toEqual([]);
    expect(queue.list()).toEqual([]);
    expect(lastStatus()?.snapshots.map((snapshot) => snapshot.name)).toEqual(['commander-2026-10-06.db']);
  });

  it('keeps a failure from before Ares’s queue was set up, and queues it once it is', () => {
    const { backups: set, queue, makeReady } = backups({ queueReady: false });
    failing = 'database disk image is malformed';
    set.takeDaily();
    expect(queue.list()).toEqual([]);
    makeReady();
    expect(queue.list().map((line) => line.about.kind)).toEqual(['backup-failed']);
  });

  it('never throws, whatever goes wrong', () => {
    const { backups: set } = backups();
    vi.spyOn(store, 'takeDailySnapshot').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(() => set.takeDaily()).not.toThrow();
    expect(lastStatus()?.problems[0]?.reason).toBe('ENOSPC: no space left on device');
  });
});

describe('a restore made at this start', () => {
  it('says which snapshot was restored and where the database as it was went', () => {
    const { backups: set } = backups({
      restored: {
        ok: true,
        name: 'commander-2026-10-05.db',
        at: clock,
        keptAside: join(dir, 'snapshots', 'commander-before-restore-2026-10-06-120000.db'),
        missingImages: 0,
      },
    });
    expect(set.status()).toMatchObject({
      restored: {
        name: 'commander-2026-10-05.db',
        at: clock,
        keptAside: 'commander-before-restore-2026-10-06-120000.db',
      },
      restoreFailed: null,
    });
  });

  it('reports one that failed in the status and the Update', () => {
    const { backups: set, queue } = backups({
      restored: {
        ok: false,
        name: 'commander-2026-10-05.db',
        at: clock,
        reason: 'That snapshot is no longer there.',
      },
    });
    expect(set.status().restoreFailed).toBe('That snapshot is no longer there.');
    expect(queue.list().map((line) => line.about)).toEqual([
      { kind: 'backup-failed', what: 'restore', at: clock, reason: 'That snapshot is no longer there.' },
    ]);
  });
});

describe('requests from the main process', () => {
  it('marks a snapshot for the relaunch to restore, and refuses one that is not there', () => {
    const { backups: set } = backups();
    set.takeDaily();
    clock += DAY;
    set.takeDaily();

    expect(
      set.handle({
        type: 'backups-request',
        id: 1,
        request: { op: 'restore', name: 'commander-2026-10-06.db' },
      }),
    ).toBe(true);
    expect(reply(1)?.response.ok).toBe(true);
    expect(pendingRestore(dir)).toBe('commander-2026-10-06.db');

    set.handle({
      type: 'backups-request',
      id: 2,
      request: { op: 'restore', name: 'commander-2026-09-01.db' },
    });
    expect(reply(2)?.response).toMatchObject({ ok: false, error: 'That snapshot is no longer there.' });
    expect(set.handle({ type: 'something-else' })).toBe(false);
  });

  it('runs an export, pushing its progress, and says where it went', async () => {
    const { backups: set } = backups();
    const into = join(dir, 'chosen');
    mkdirSync(into);
    set.handle({ type: 'backups-request', id: 1, request: { op: 'export', folder: into } });
    expect(reply(1)?.response.ok).toBe(true);
    expect(lastStatus()?.export?.state).toBe('running');

    await vi.waitFor(() => expect(lastStatus()?.export?.state).toBe('done'));
    expect(lastStatus()?.export?.folder).toBe(join(into, 'Commander export 2026-10-06 12.00'));
    expect(readdirSync(into)).toEqual(['Commander export 2026-10-06 12.00']);

    // Another while one runs is refused.
    set.handle({ type: 'backups-request', id: 2, request: { op: 'export', folder: into } });
    set.handle({ type: 'backups-request', id: 3, request: { op: 'export', folder: into } });
    expect(reply(3)?.response).toMatchObject({ ok: false, error: 'An export is already running.' });
    await vi.waitFor(() => expect(lastStatus()?.export?.state).toBe('done'));
  });

  it('removes an unfinished export when the Core stops (Commander quitting, say)', async () => {
    const { backups: set } = backups();
    const into = join(dir, 'chosen');
    mkdirSync(into);
    const copy = store.copyDatabaseTo;
    vi.spyOn(store, 'copyDatabaseTo').mockImplementation((path) => {
      copy(path);
      set.stop();
    });
    set.handle({ type: 'backups-request', id: 1, request: { op: 'export', folder: into } });
    await vi.waitFor(() => expect(lastStatus()?.export?.state).toBe('cancelled'));
    expect(readdirSync(into)).toEqual([]);
  });
});
