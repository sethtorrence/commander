import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  integrityProblem,
  listSnapshots,
  parseSnapshotName,
  SnapshotFailed,
  snapshotName,
  takeDailySnapshot,
  takeExtraSnapshot,
} from './snapshots';

// Snapshots of the database (#202): each copy checked before it stands, rotation that only removes
// its own files, the copies before an update and before a restore, and the list Settings shows.
// Names go by the local day and time, so clocks here are local times: the same in every time zone.

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let snapshots: string;
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-snapshots-'));
  snapshots = join(dir, 'snapshots');
  sqlite = new Database(join(dir, 'commander.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('Keep me safe');");
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const files = () => (existsSync(snapshots) ? readdirSync(snapshots).sort() : []);
const noteIn = (path: string) => {
  const copy = new Database(path, { readonly: true });
  try {
    return copy.prepare('SELECT text FROM notes').pluck().all();
  } finally {
    copy.close();
  }
};
const fails = () => 'row 3 missing from index';

describe('verified snapshots', () => {
  it('checks each copy and keeps one that passes', () => {
    const at = new Date(2026, 9, 6, 12).getTime();
    const taken = takeDailySnapshot(sqlite, snapshots, at);
    expect(taken?.path).toBe(join(snapshots, 'commander-2026-10-06.db'));
    expect(integrityProblem(taken?.path ?? '')).toBeNull();
    expect(noteIn(taken?.path ?? '')).toEqual(['Keep me safe']);
  });

  it('discards a copy that fails its check, keeping every older snapshot, and says why', () => {
    const first = new Date(2026, 9, 1, 12).getTime();
    for (let day = 0; day < 7; day++) takeDailySnapshot(sqlite, snapshots, first + day * DAY);
    const before = files();
    expect(before).toHaveLength(7);

    expect(() => takeDailySnapshot(sqlite, snapshots, first + 7 * DAY, { check: fails })).toThrow(
      SnapshotFailed,
    );
    expect(() => takeDailySnapshot(sqlite, snapshots, first + 7 * DAY, { check: fails })).toThrow(
      'The copy failed its integrity check: row 3 missing from index',
    );
    // Nothing half-made is left, and the oldest wasn't pushed out by the bad one.
    expect(files()).toEqual(before);

    // The next good one takes its place, and rotation carries on.
    expect(takeDailySnapshot(sqlite, snapshots, first + 7 * DAY)?.removed).toEqual([
      join(snapshots, 'commander-2026-10-01.db'),
    ]);
  });

  it('finds a damaged database file, and one that is no database at all', () => {
    const at = new Date(2026, 9, 6, 12).getTime();
    sqlite.exec(`INSERT INTO notes SELECT hex(randomblob(500)) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) SELECT i FROM n);
      CREATE INDEX notes_text ON notes(text);`);
    const path = takeDailySnapshot(sqlite, snapshots, at)?.path ?? '';
    expect(integrityProblem(path)).toBeNull();

    // Pages in the middle overwritten, as a failing disk might.
    const damaged = join(dir, 'damaged.db');
    copyFileSync(path, damaged);
    const bytes = new Database(damaged, { readonly: true });
    const pageSize = bytes.pragma('page_size', { simple: true }) as number;
    bytes.close();
    const fd = openSync(damaged, 'r+');
    writeSync(fd, Buffer.alloc(pageSize * 3, 0x5a), 0, pageSize * 3, pageSize * 4);
    closeSync(fd);
    expect(integrityProblem(damaged)).not.toBeNull();

    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'not a database at all, but long enough to have a header of some kind');
    expect(integrityProblem(garbage)).toMatch(/not a database/);
  });
});

describe('rotation', () => {
  it('only ever removes its own daily snapshots, never anything else in the folder', () => {
    mkdirSync(snapshots);
    // A copy someone made by hand, under a name close to Commander's own, and other stray files.
    const theirs = [
      'commander-before-update-2026-10-06.db',
      'commander-2026-09-01.db.bak',
      'commander-2026-9-1.db',
      'notes.txt',
    ];
    for (const name of theirs) writeFileSync(join(snapshots, name), 'theirs');
    const first = new Date(2026, 9, 1, 12).getTime();
    for (let day = 0; day < 12; day++) takeDailySnapshot(sqlite, snapshots, first + day * DAY);

    expect(files()).toEqual(
      [
        ...theirs,
        'commander-2026-10-06.db',
        'commander-2026-10-07.db',
        'commander-2026-10-08.db',
        'commander-2026-10-09.db',
        'commander-2026-10-10.db',
        'commander-2026-10-11.db',
        'commander-2026-10-12.db',
      ].sort(),
    );
  });

  it('keeps a pre-update copy beside the daily ones until a daily snapshot of a later day succeeds', () => {
    const update = new Date(2026, 9, 6, 9, 15, 2).getTime();
    takeDailySnapshot(sqlite, snapshots, update - DAY);
    const before = takeExtraSnapshot(sqlite, snapshots, 'before-update', update);
    expect(before.path).toBe(join(snapshots, 'commander-before-update-2026-10-06-091502.db'));

    // The same day's daily snapshot, taken just after the update, keeps it.
    takeDailySnapshot(sqlite, snapshots, update + 1000);
    expect(files()).toContain('commander-before-update-2026-10-06-091502.db');
    // A failed daily snapshot the next day keeps it too.
    expect(() => takeDailySnapshot(sqlite, snapshots, update + DAY, { check: fails })).toThrow();
    expect(files()).toContain('commander-before-update-2026-10-06-091502.db');
    // The next good one lets it go.
    expect(takeDailySnapshot(sqlite, snapshots, update + DAY)?.removed).toEqual([before.path]);
    expect(files()).toEqual([
      'commander-2026-10-05.db',
      'commander-2026-10-06.db',
      'commander-2026-10-07.db',
    ]);
  });

  it('keeps the last 3 copies taken before a restore', () => {
    const at = new Date(2026, 9, 6, 12).getTime();
    for (let n = 0; n < 5; n++) takeExtraSnapshot(sqlite, snapshots, 'before-restore', at + n * 60_000);
    expect(files()).toEqual([
      'commander-before-restore-2026-10-06-120200.db',
      'commander-before-restore-2026-10-06-120300.db',
      'commander-before-restore-2026-10-06-120400.db',
    ]);
  });
});

describe('names, by the local day and time', () => {
  it('names a snapshot taken just after midnight by the new day', () => {
    const justAfter = new Date(2026, 9, 7, 0, 0, 30).getTime();
    expect(snapshotName('daily', justAfter)).toBe('commander-2026-10-07.db');
    expect(snapshotName('before-update', justAfter)).toBe('commander-before-update-2026-10-07-000030.db');
    const justBefore = new Date(2026, 9, 6, 23, 59, 59).getTime();
    expect(snapshotName('daily', justBefore)).toBe('commander-2026-10-06.db');
  });

  it('reads back only the names it makes', () => {
    expect(parseSnapshotName('commander-2026-10-06.db')).toEqual({
      kind: 'daily',
      day: '2026-10-06',
      time: null,
    });
    expect(parseSnapshotName('commander-before-restore-2026-10-06-143205.db')).toEqual({
      kind: 'before-restore',
      day: '2026-10-06',
      time: '14:32',
    });
    for (const name of [
      'commander-before-update-2026-10-06.db',
      'commander.db',
      'commander-2026-10-06.db-wal',
    ])
      expect(parseSnapshotName(name)).toBeNull();
  });
});

describe('the list Settings → Data shows', () => {
  it('lists every kind, newest first, with its size, and nothing else', () => {
    const day = new Date(2026, 9, 5, 12).getTime();
    takeDailySnapshot(sqlite, snapshots, day);
    takeExtraSnapshot(sqlite, snapshots, 'before-update', new Date(2026, 9, 6, 9).getTime());
    takeExtraSnapshot(sqlite, snapshots, 'before-restore', new Date(2026, 9, 6, 13).getTime());
    writeFileSync(join(snapshots, 'notes.txt'), 'theirs');
    mkdirSync(join(snapshots, 'attachments'));

    const listed = listSnapshots(snapshots);
    expect(listed.map(({ name, kind, day, time }) => ({ name, kind, day, time }))).toEqual([
      {
        name: 'commander-before-restore-2026-10-06-130000.db',
        kind: 'before-restore',
        day: '2026-10-06',
        time: '13:00',
      },
      {
        name: 'commander-before-update-2026-10-06-090000.db',
        kind: 'before-update',
        day: '2026-10-06',
        time: '09:00',
      },
      { name: 'commander-2026-10-05.db', kind: 'daily', day: '2026-10-05', time: null },
    ]);
    for (const snapshot of listed) expect(snapshot.size).toBeGreaterThan(0);
  });
});
