/*
  Opening the database safely (#203), before the Item store reads anything from it:

  - The check: SQLite's quick integrity check (`PRAGMA quick_check`: well under a second on a
    database of several hundred MB). A file that isn't a database, or one that fails the check,
    throws DatabaseDamaged, so the Core never carries on with damaged data (backups/recovery.ts).
    A new, empty file has nothing to check.
  - The migrations: every migration this version has to run, in one transaction, so a failure
    leaves the database exactly as the previous version left it (that version can still open it).
    Drizzle's own migrator also runs them in one transaction, but makes its bookkeeping table outside
    it, can't say which migration failed, and its ROLLBACK throws (hiding the reason) when SQLite has
    already rolled back by itself, as it does when the disk is full. This one keeps drizzle's
    bookkeeping exactly (`__drizzle_migrations`: each migration's hash and folder time), so nothing
    changes for a database either has migrated. As before, a migration's `PRAGMA foreign_keys` lines
    do nothing inside the transaction.
*/
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/** The database failed its integrity check, or isn't a database. `problem`: what SQLite found. */
export class DatabaseDamaged extends Error {
  override name = 'DatabaseDamaged';
  constructor(readonly problem: string) {
    super(`The database is damaged: ${problem}`);
  }
}

// The snapshot taken before this open migrated the database (#202): taken, or failed (the migration
// went ahead regardless, and the failure is for the Update and Diagnostics: the database passed its
// check on open, and the migrations run all or none, so a failed update leaves it as it was).
export type PreUpdateSnapshot = { ok: true; path: string } | { ok: false; at: number; reason: string };

/** A migration failed; the database is as it was. `migration`: its name, e.g. 0053_memory. */
export class MigrationFailed extends Error {
  override name = 'MigrationFailed';
  // The snapshot the open took before migrating (null when it took none), for the recovery screen.
  preUpdateSnapshot: PreUpdateSnapshot | null = null;
  constructor(
    readonly migration: string,
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`The migration ${migration} failed: ${reason}`, { cause });
  }
}

// SQLite's word for a damaged file, or one that isn't a database.
const DAMAGE_CODES = /^SQLITE_(CORRUPT|NOTADB)/;
const isDamage = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === 'string' &&
  DAMAGE_CODES.test((error as { code: string }).code);

// At most this many of SQLite's findings in the reason.
const PROBLEMS_SHOWN = 3;

/** What the quick check finds wrong with an open database, or null when it passes. */
export function quickCheckProblem(sqlite: Database.Database): string | null {
  const rows = sqlite.pragma('quick_check') as { quick_check: string }[];
  const problems = rows.map((row) => row.quick_check).filter((line) => line !== 'ok');
  return problems.length ? problems.slice(0, PROBLEMS_SHOWN).join('; ') : null;
}

/**
 * Opens the database file (made when missing) in WAL mode with foreign keys on, once it passes the
 * quick check. Throws DatabaseDamaged, with nothing left open, when it doesn't.
 */
export function openCheckedDatabase(path: string): Database.Database {
  const isNew = !existsSync(path) || statSync(path).size === 0;
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(path);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    const problem = isNew ? null : quickCheckProblem(sqlite);
    if (problem) throw new DatabaseDamaged(problem);
    return sqlite;
  } catch (error) {
    sqlite?.close();
    if (isDamage(error)) throw new DatabaseDamaged(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

const MIGRATIONS_TABLE = '__drizzle_migrations';

// The migrations' names, in the journal's order (readMigrationFiles reads them in the same order).
function migrationNames(migrationsFolder: string): string[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((entry) => entry.tag);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs the migrations the database hasn't run yet, all in one transaction. Throws MigrationFailed
 * (the database left exactly as it was) when one fails. Returns the names of those it ran.
 */
export function migrateAtomically(sqlite: Database.Database, migrationsFolder: string): string[] {
  let migrations: ReturnType<typeof readMigrationFiles>;
  let names: string[];
  try {
    migrations = readMigrationFiles({ migrationsFolder });
    names = migrationNames(migrationsFolder);
  } catch (error) {
    throw new MigrationFailed('(the migrations folder)', reasonOf(error), error);
  }
  const ran: string[] = [];
  let current = '(the migrations table)';
  try {
    sqlite.transaction(() => {
      sqlite.exec(
        `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
      );
      const last = sqlite
        .prepare(`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`)
        .pluck()
        .get() as number | string | null | undefined;
      const record = sqlite.prepare(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`);
      for (const [index, migration] of migrations.entries()) {
        // As drizzle decides: any migration made after the last one this database ran.
        if (last !== null && last !== undefined && !(Number(last) < migration.folderMillis)) continue;
        current = names[index] ?? `migration ${index + 1}`;
        for (const statement of migration.sql) if (statement.trim()) sqlite.exec(statement);
        record.run(migration.hash, migration.folderMillis);
        ran.push(current);
      }
    })();
  } catch (error) {
    throw new MigrationFailed(current, reasonOf(error), error);
  }
  return ran;
}
