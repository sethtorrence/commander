import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// The snapshot before an update (#202): when a new version of Commander has migrations to run, the
// database is copied (and checked) before any of them runs, so the copy is the database exactly as
// the previous version left it.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

let dir: string;
let olderMigrations: string;
const stores: ItemStore[] = [];
// Local times, so the names read the same in every time zone.
const updatedAt = new Date(2026, 9, 6, 9, 15, 2).getTime();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-pre-update-'));
  // The previous version of Commander: every migration but the latest.
  olderMigrations = join(dir, 'older-drizzle');
  cpSync(migrationsFolder, olderMigrations, { recursive: true });
  const journalPath = join(olderMigrations, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries.pop();
  writeFileSync(journalPath, JSON.stringify(journal));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(folder: string, options: Partial<Parameters<typeof openItemStore>[0]> = {}) {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: folder,
    now: () => updatedAt,
    ...options,
  });
  stores.push(store);
  return store;
}

function closeAll() {
  for (const store of stores.splice(0)) store.close();
}

const migrationsRun = (path: string) => {
  const sqlite = new Database(path, { readonly: true });
  try {
    return sqlite.prepare('SELECT COUNT(*) FROM __drizzle_migrations').pluck().get();
  } finally {
    sqlite.close();
  }
};
const snapshots = () =>
  existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')).sort() : [];

describe('the snapshot before an update', () => {
  it('copies the database before any migration runs, as the previous version left it', () => {
    expect(open(olderMigrations).preUpdateSnapshot).toBeNull();
    closeAll();
    // Written as the previous version would have (this version's code expects the latest schema).
    const previous = new Database(join(dir, 'commander.db'));
    previous
      .prepare(
        `INSERT INTO items (id, kind, title, people, status, created_at, updated_at)
         VALUES ('m1', 'email', 'Before the update', '[]', 'open', 1, 1)`,
      )
      .run();
    previous.close();

    const updated = open(migrationsFolder);
    const name = 'commander-before-update-2026-10-06-091502.db';
    expect(updated.preUpdateSnapshot).toEqual({ ok: true, path: join(dir, 'snapshots', name) });
    expect(snapshots()).toEqual([name]);

    const total = readdirSync(migrationsFolder).filter((file) => file.endsWith('.sql')).length;
    expect(migrationsRun(join(dir, 'snapshots', name))).toBe(total - 1);
    expect(migrationsRun(join(dir, 'commander.db'))).toBe(total);
    const copy = new Database(join(dir, 'snapshots', name), { readonly: true });
    expect(copy.prepare('SELECT title FROM items').pluck().all()).toEqual(['Before the update']);
    copy.close();
  });

  it('takes none for a new database, nor for one already up to date', () => {
    expect(open(migrationsFolder).preUpdateSnapshot).toBeNull();
    closeAll();
    expect(open(migrationsFolder).preUpdateSnapshot).toBeNull();
    expect(snapshots()).toEqual([]);
  });

  it('discards a copy that fails its check, says why, and still updates the database', () => {
    open(olderMigrations);
    closeAll();

    const updated = open(migrationsFolder, { checkSnapshot: () => 'page 12 is never used' });
    expect(updated.preUpdateSnapshot).toEqual({
      ok: false,
      at: updatedAt,
      reason: 'The copy failed its integrity check: page 12 is never used',
    });
    expect(snapshots()).toEqual([]);
    const total = readdirSync(migrationsFolder).filter((file) => file.endsWith('.sql')).length;
    expect(migrationsRun(join(dir, 'commander.db'))).toBe(total);
  });
});
