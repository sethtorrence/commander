// Daily copies of the database: one per calendar day (local time), keeping the most recent few.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

export const snapshotsKept = 7;
const snapshotName = /^commander-\d{4}-\d{2}-\d{2}\.db$/;

export type Snapshot = { path: string; removed: string[] };

function localDay(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function takeDailySnapshot(sqlite: BetterSqlite3.Database, dir: string, at: number): Snapshot | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `commander-${localDay(at)}.db`);
  if (existsSync(path)) return null;

  // VACUUM INTO writes a consistent, compacted copy; writing aside then renaming means a crash
  // never leaves a half-written snapshot under a real name.
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  sqlite.prepare('VACUUM INTO ?').run(partial);
  renameSync(partial, path);

  const removed = readdirSync(dir)
    .filter((name) => snapshotName.test(name))
    .sort()
    .reverse()
    .slice(snapshotsKept)
    .map((name) => join(dir, name));
  for (const old of removed) rmSync(old, { force: true });
  return { path, removed };
}

/** The snapshots kept in a folder, oldest first. */
export function keptSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => snapshotName.test(name))
    .sort()
    .map((name) => join(dir, name));
}
