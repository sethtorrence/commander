import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupsStatus, CoreBackupsReply, DatabaseRecovery } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { EXPORT_README_LIMITED } from './export';
import { latestGoodSnapshot, openOrRecover, stayInRecovery } from './recovery';
import { applyPendingRestore, pendingRestore } from './restore';

// The Core's limited state (#203): a database that fails its check, or that this version couldn't
// update, keeps the Core up without an Item store, offering the snapshot to restore (and, after a
// failed update, Export everything) until the User chooses.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const PAGE = 4096;
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let clock: number;
const stores: ItemStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-recovery-'));
  // Local noon, so snapshot names read the same in every time zone.
  clock = new Date(2026, 9, 4, 12).getTime();
});

afterEach(() => {
  closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const options = (folder = migrationsFolder) => ({
  path: join(dir, 'commander.db'),
  snapshotDir: join(dir, 'snapshots'),
  migrationsFolder: folder,
  now: () => clock,
});

function open() {
  const store = openItemStore(options());
  stores.push(store);
  return store;
}

function closeAll() {
  for (const store of stores.splice(0)) store.close();
}

const emails = (store: ItemStore) =>
  store
    .query({ kinds: ['email'] })
    .map((item) => item.title)
    .sort();

// A day's work: emails saved, then that day's snapshot taken (as the next start would take it).
function day(titles: string[]) {
  const store = open();
  store.saveFromSource({
    source: 'gmail',
    account: 'work@example.com',
    items: titles.map((title) => ({
      externalId: title,
      kind: 'email' as const,
      title: `${title} ${'with a subject long enough to fill pages '.repeat(6)}`,
    })),
  });
  store.takeDailySnapshot();
  closeAll();
}

function damageDatabase() {
  const fd = openSync(join(dir, 'commander.db'), 'r+');
  writeSync(fd, Buffer.alloc(PAGE * 12, 0x5a), 0, PAGE * 12, PAGE * 8);
  closeSync(fd);
}

function withFailingMigration() {
  const folder = join(dir, 'drizzle-next');
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1) as (typeof journal.entries)[number];
  const tag = `${String(last.idx + 1).padStart(4, '0')}_breaks`;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), 'SELECT * FROM no_such_table;');
  return { folder, tag };
}

// The limited Core, on a stand-in for its parent port.
function limited(health: DatabaseRecovery) {
  const posted: unknown[] = [];
  let deliver: (data: unknown) => void = () => {};
  const stop = vi.fn();
  void stayInRecovery({
    health,
    port: {
      on: (_event, listener) => {
        deliver = (data) => listener({ data });
      },
      postMessage: (message) => posted.push(message),
    },
    signals: { on: (_event, listener) => stop.mockImplementation(listener) },
    dataDir: dir,
    snapshotDir: join(dir, 'snapshots'),
    attachmentsDir: join(dir, 'attachments'),
    restored: null,
  });
  let id = 0;
  const ask = (request: unknown) => {
    id += 1;
    deliver({ type: 'backups-request', id, request });
    return (
      posted.findLast((message) => (message as CoreBackupsReply).type === 'backups-reply') as CoreBackupsReply
    ).response;
  };
  return { posted, ask };
}

describe('opening, or the limited state', () => {
  it('opens a sound database as before', () => {
    day(['Monday']);
    const opened = openOrRecover(options());
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(emails(opened.store)).toHaveLength(1);
      opened.store.close();
    }
  });

  it('offers the newest snapshot that passes the check for a damaged database', () => {
    day(['Monday']);
    clock += DAY;
    day(['Tuesday']);
    clock += DAY;
    day(['Wednesday']);
    damageDatabase();
    // Wednesday's snapshot is damaged too: Tuesday's is the latest good one.
    const check = (path: string) => (path.endsWith('2026-10-06.db') ? 'page 3 is never used' : null);

    const opened = openOrRecover(options(), { check });
    expect(opened).toEqual({
      ok: false,
      health: {
        state: 'damaged',
        problem: expect.any(String),
        snapshot: expect.objectContaining({
          name: 'commander-2026-10-05.db',
          kind: 'daily',
          day: '2026-10-05',
        }),
        restoreFailed: null,
      },
    });
    expect(latestGoodSnapshot(join(dir, 'snapshots'), () => 'bad')).toBeNull();
  });

  it('offers nothing when no snapshot passes, and says why a restore failed', () => {
    day(['Monday']);
    rmSync(join(dir, 'snapshots'), { recursive: true });
    damageDatabase();
    const opened = openOrRecover(options(), {
      restored: {
        ok: false,
        name: 'commander-2026-10-03.db',
        at: clock,
        reason: 'That snapshot is no longer there.',
      },
    });
    expect(opened).toMatchObject({
      ok: false,
      health: { state: 'damaged', snapshot: null, restoreFailed: 'That snapshot is no longer there.' },
    });
  });

  it('offers the pre-update snapshot when a migration fails', () => {
    day(['Monday']);
    const { folder, tag } = withFailingMigration();
    const opened = openOrRecover(options(folder));
    expect(opened).toEqual({
      ok: false,
      health: {
        state: 'update-failed',
        migration: tag,
        reason: 'no such table: no_such_table',
        snapshot: expect.objectContaining({ kind: 'before-update', day: '2026-10-04', time: '12:00' }),
        snapshotProblem: null,
        restoreFailed: null,
      },
    });
  });

  it('says why there is no pre-update snapshot when it couldn’t be taken', () => {
    day(['Monday']);
    const { folder } = withFailingMigration();
    const opened = openOrRecover({ ...options(folder), checkSnapshot: () => 'page 3 is never used' });
    expect(opened).toMatchObject({
      ok: false,
      health: {
        state: 'update-failed',
        snapshot: null,
        snapshotProblem: 'The copy failed its integrity check: page 3 is never used',
      },
    });
  });

  it('keeps the last 3 pre-update snapshots while the update keeps failing', () => {
    day(['Monday']);
    const { folder } = withFailingMigration();
    for (let start = 0; start < 5; start++) {
      clock += 60_000;
      expect(openOrRecover(options(folder)).ok).toBe(false);
    }
    expect(
      readdirSync(join(dir, 'snapshots'))
        .filter((name) => name.includes('before-update'))
        .sort(),
    ).toEqual([
      'commander-before-update-2026-10-04-120300.db',
      'commander-before-update-2026-10-04-120400.db',
      'commander-before-update-2026-10-04-120500.db',
    ]);
  });
});

describe('the limited Core', () => {
  it('says so, and restores the latest good snapshot over a damaged database on the relaunch', () => {
    day(['Monday']);
    clock += DAY;
    day(['Tuesday']);
    damageDatabase();
    const opened = openOrRecover(options());
    if (opened.ok) throw new Error('It should not have opened');
    const core = limited(opened.health);
    expect(core.posted).toEqual([{ type: 'database-health', health: opened.health }]);

    expect(core.ask({ op: 'recover' })).toMatchObject({ ok: true });
    expect(pendingRestore(dir)).toBe('commander-2026-10-05.db');

    // The relaunch: the restore is made before the database is opened, and it opens.
    clock += 60_000;
    expect(applyPendingRestore({ dataDir: dir, now: () => clock })).toMatchObject({ ok: true });
    const reopened = openOrRecover(options());
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      stores.push(reopened.store);
      expect(emails(reopened.store).map((title) => title.split(' ')[0])).toEqual(['Monday', 'Tuesday']);
    }
    // The damaged database is kept aside, as it was.
    expect(readdirSync(join(dir, 'snapshots'))).toContain('commander-before-restore-2026-10-05-120100.db');
  });

  it('refuses to recover when there is nothing to restore', () => {
    day(['Monday']);
    rmSync(join(dir, 'snapshots'), { recursive: true });
    damageDatabase();
    const opened = openOrRecover(options());
    if (opened.ok) throw new Error('It should not have opened');
    expect(limited(opened.health).ask({ op: 'recover' })).toMatchObject({
      ok: false,
      error: 'There is no snapshot to restore.',
    });
    expect(pendingRestore(dir)).toBeNull();
  });

  it('exports everything after a failed update, without the Item store', async () => {
    day(['Monday']);
    const { folder } = withFailingMigration();
    const opened = openOrRecover(options(folder));
    if (opened.ok) throw new Error('It should not have opened');
    const core = limited(opened.health);
    const into = join(dir, 'Backups');
    mkdirSync(into);

    expect(core.ask({ op: 'export', folder: into })).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      const last = core.posted.findLast(
        (message) => (message as { type?: string }).type === 'backups-status',
      ) as { status: BackupsStatus } | undefined;
      expect(last?.status.export?.state).toBe('done');
    });
    const [exported] = readdirSync(into);
    const files = readdirSync(join(into, exported as string)).sort();
    expect(files).toEqual(['README.txt', 'commander.db']);
    expect(readFileSync(join(into, exported as string, 'README.txt'), 'utf8')).toContain(
      EXPORT_README_LIMITED.trim(),
    );
    // The copy is the database as the previous version left it, which that version opens.
    rmSync(join(dir, 'commander.db'));
    for (const suffix of ['-wal', '-shm']) rmSync(join(dir, `commander.db${suffix}`), { force: true });
    cpSync(join(into, exported as string, 'commander.db'), join(dir, 'commander.db'));
    expect(emails(open()).map((title) => title.split(' ')[0])).toEqual(['Monday']);
    expect(existsSync(join(dir, 'restore-pending.json'))).toBe(false);
  });
});
