import {
  closeSync,
  cpSync,
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
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseDamaged, type ItemStore, MigrationFailed, openItemStore } from '.';
import { migrateAtomically, openCheckedDatabase } from './database-health';

// Opening the database safely (#203): a quick integrity check before anything reads it, and the
// migrations run all or none, so a failed update leaves the database exactly as it was.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const PAGE = 4096;

let dir: string;
let path: string;
const stores: ItemStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-db-health-'));
  path = join(dir, 'commander.db');
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(folder = migrationsFolder) {
  const store = openItemStore({
    path,
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: folder,
    now: () => new Date(2026, 9, 6, 9, 15, 2).getTime(),
  });
  stores.push(store);
  return store;
}

function closeAll() {
  for (const store of stores.splice(0)) store.close();
}

// A database with enough in it to span many pages, closed so everything is in the main file.
function writeEmails(count = 400) {
  const store = open();
  store.saveFromSource({
    source: 'gmail',
    account: 'work@example.com',
    items: Array.from({ length: count }, (_, n) => ({
      externalId: `m${n}`,
      kind: 'email' as const,
      title: `An email with a long enough subject to fill the pages ${'x'.repeat(200)} ${n}`,
    })),
  });
  closeAll();
}

// Writes over part of the file, as a failing disk or a crash mid-write might.
function overwrite(offset: number, length: number, byte = 0x5a) {
  const fd = openSync(path, 'r+');
  writeSync(fd, Buffer.alloc(length, byte), 0, length, offset);
  closeSync(fd);
}

// Everything in the database that a migration could change: its schema, and every table's rows.
function contents(file = path) {
  const sqlite = new Database(file, { readonly: true });
  try {
    const schema = sqlite
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as { type: string; name: string }[];
    const rows = Object.fromEntries(
      schema
        .filter((entry) => entry.type === 'table')
        .map((entry) => [entry.name, sqlite.prepare(`SELECT * FROM "${entry.name}"`).all()]),
    );
    return { schema, rows };
  } finally {
    sqlite.close();
  }
}

// This version's migrations plus one more, which fails part-way: it makes a table, changes a row,
// then refers to a table that doesn't exist.
function withFailingMigration(failing = 'SELECT * FROM no_such_table') {
  const folder = join(dir, 'drizzle-next');
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const last = journal.entries.at(-1) as (typeof journal.entries)[number];
  const tag = `${String(last.idx + 1).padStart(4, '0')}_breaks_halfway`;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(
    join(folder, `${tag}.sql`),
    [
      'CREATE TABLE `half_made` (`id` text PRIMARY KEY NOT NULL);',
      "UPDATE `items` SET `title` = 'changed by the update';",
      failing,
    ].join('\n--> statement-breakpoint\n'),
  );
  return { folder, tag };
}

describe('the check on open', () => {
  it('opens a new database, and a sound one, without complaint', () => {
    expect(open().query()).toEqual([]);
    closeAll();
    writeEmails(3);
    expect(open().query({ kinds: ['email'] })).toHaveLength(3);
  });

  it('refuses a corrupted database file, leaving it untouched', () => {
    writeEmails();
    // B-tree pages in the middle of the file, written over.
    overwrite(PAGE * 8, PAGE * 12);
    const before = readFileSync(path);

    let thrown: unknown;
    try {
      open();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseDamaged);
    expect((thrown as DatabaseDamaged).problem).not.toBe('');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('refuses a file that isn’t a database at all', () => {
    writeEmails(3);
    overwrite(0, 100, 0x41);
    expect(() => open()).toThrow(DatabaseDamaged);
    expect(() => openCheckedDatabase(path)).toThrow(/not a database/);
  });

  it('leaves nothing open when it refuses one', () => {
    writeEmails();
    overwrite(PAGE * 8, PAGE * 12);
    expect(() => open()).toThrow(DatabaseDamaged);
    // Nothing holds the file: it can be replaced (as a restore does) and opened again.
    rmSync(path);
    expect(open().query()).toEqual([]);
  });
});

describe('migrations', () => {
  it('runs every migration on main into a new database, and nothing on the next open', () => {
    const sqlite = new Database(path);
    const total = readdirSync(migrationsFolder).filter((file) => file.endsWith('.sql')).length;
    expect(migrateAtomically(sqlite, migrationsFolder)).toHaveLength(total);
    expect(sqlite.prepare('SELECT COUNT(*) FROM __drizzle_migrations').pluck().get()).toBe(total);
    expect(migrateAtomically(sqlite, migrationsFolder)).toEqual([]);
    sqlite.close();
  });

  it('keeps drizzle’s bookkeeping, so a database drizzle migrated needs nothing more', async () => {
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    const sqlite = new Database(path);
    migrate(drizzle(sqlite), { migrationsFolder });
    const before = contents();
    expect(migrateAtomically(sqlite, migrationsFolder)).toEqual([]);
    sqlite.close();
    expect(contents()).toEqual(before);
  });

  it('leaves the database exactly as it was when a migration throws, and names it', () => {
    writeEmails(3);
    const before = contents();
    const { folder, tag } = withFailingMigration();

    let thrown: unknown;
    try {
      open(folder);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationFailed);
    expect(thrown).toMatchObject({ migration: tag, reason: expect.stringMatching(/no such table/) });
    // No half-made table, no changed row, no record of the migration.
    expect(contents()).toEqual(before);

    // This version can't open it, but the previous one still can, as it left it.
    expect(() => open(folder)).toThrow(MigrationFailed);
    expect(
      open()
        .query({ kinds: ['email'] })
        .map((item) => item.title),
    ).not.toContain('changed by the update');
  });

  it('says what the snapshot before the failed update is', () => {
    writeEmails(3);
    const { folder } = withFailingMigration();
    let thrown: MigrationFailed | undefined;
    try {
      open(folder);
    } catch (error) {
      thrown = error as MigrationFailed;
    }
    expect(thrown?.preUpdateSnapshot).toEqual({
      ok: true,
      path: join(dir, 'snapshots', 'commander-before-update-2026-10-06-091502.db'),
    });
    // The snapshot is the database as the previous version left it.
    expect(contents(join(dir, 'snapshots', 'commander-before-update-2026-10-06-091502.db'))).toEqual(
      contents(),
    );
  });

  it('rolls back a migration that fills the disk, saying so', () => {
    writeEmails(3);
    const { folder, tag } = withFailingMigration(
      // A recursive insert big enough to run past the cap below, as a full disk would stop it.
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) INSERT INTO `half_made` SELECT 'row ' || i || ' ' || hex(randomblob(64)) FROM n;",
    );
    const before = contents();
    const sqlite = new Database(path);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma(`max_page_count = ${(sqlite.pragma('page_count', { simple: true }) as number) + 50}`);

    let thrown: unknown;
    try {
      migrateAtomically(sqlite, folder);
    } catch (error) {
      thrown = error;
    }
    sqlite.close();
    expect(thrown).toMatchObject({ migration: tag, reason: 'database or disk is full' });
    expect((thrown as MigrationFailed).cause).toMatchObject({ code: 'SQLITE_FULL' });
    expect(contents()).toEqual(before);
  });
});
