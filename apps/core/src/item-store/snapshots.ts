/*
  Snapshots of the database (#202), in `snapshots/` beside it:

  - Daily: `commander-YYYY-MM-DD.db`, one per calendar day (local time), the last 7 kept.
  - Before an update: `commander-before-update-YYYY-MM-DD-HHMMSS.db`, taken before a new version of
    Commander migrates the database, and kept beside the daily ones until a daily snapshot of a later
    day succeeds (so a pre-update copy always lives at least until the next day).
  - Before a restore: `commander-before-restore-YYYY-MM-DD-HHMMSS.db`, the database as it was when
    the User restored another snapshot over it (restore.ts); the last 3 kept.

  Every copy is written aside (`.partial`), checked (an SQLite integrity check on the copy) and only
  then renamed into place, so a crash or a bad copy never stands under a real name or pushes out a
  good older one. Rotation removes only files with these names: anything else in the folder (or
  beside the database) is left alone.
*/
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SnapshotInfo, SnapshotKind } from '@commander/domain';
import Database from 'better-sqlite3';

export const snapshotsKept = 7;
export const beforeRestoreKept = 3;

const dailyName = /^commander-(\d{4}-\d{2}-\d{2})\.db$/;
const extraName = /^commander-(before-update|before-restore)-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

export type Snapshot = { path: string; removed: string[] };

/** A copy that couldn't be made, or failed its check; it was discarded. */
export class SnapshotFailed extends Error {
  override name = 'SnapshotFailed';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const localTime = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/** A snapshot's file name: by its local day, and for the extra kinds its local time too. */
export function snapshotName(kind: SnapshotKind, at: number): string {
  return kind === 'daily'
    ? `commander-${localDay(at)}.db`
    : `commander-${kind}-${localDay(at)}-${localTime(at)}.db`;
}

/** What a file in the snapshots folder is, by its name; null for anything Commander didn't name. */
export function parseSnapshotName(
  name: string,
): { kind: SnapshotKind; day: string; time: string | null } | null {
  const daily = dailyName.exec(name);
  if (daily) return { kind: 'daily', day: daily[1] as string, time: null };
  const extra = extraName.exec(name);
  if (!extra) return null;
  return { kind: extra[1] as SnapshotKind, day: extra[2] as string, time: `${extra[3]}:${extra[4]}` };
}

/**
 * Why a database file fails SQLite's integrity check, or null when it passes. A file that isn't a
 * database (or can't be opened) fails too.
 */
export function integrityProblem(path: string): string | null {
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    const rows = sqlite.pragma('integrity_check') as { integrity_check: string }[];
    const problems = rows.map((row) => row.integrity_check).filter((line) => line !== 'ok');
    return problems.length ? problems.slice(0, 3).join('; ') : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    sqlite?.close();
  }
}

/**
 * Copies the open database to `path`: a consistent, compacted copy (VACUUM INTO), written aside,
 * checked, then renamed into place. Throws SnapshotFailed (leaving nothing behind) when the copy
 * can't be made or fails its check.
 */
export function copyDatabase(sqlite: Database.Database, path: string, check = integrityProblem): void {
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  try {
    sqlite.prepare('VACUUM INTO ?').run(partial);
  } catch (error) {
    rmSync(partial, { force: true });
    throw new SnapshotFailed(
      `The copy couldn’t be written: ${error instanceof Error ? error.message : error}`,
    );
  }
  const problem = check(partial);
  if (problem) {
    rmSync(partial, { force: true });
    throw new SnapshotFailed(`The copy failed its integrity check: ${problem}`);
  }
  renameSync(partial, path);
}

export type SnapshotOptions = {
  // Stands in for the integrity check (tests make a copy fail it).
  check?: (path: string) => string | null;
};

/**
 * Today's daily snapshot, unless it exists; null then. After it succeeds, daily snapshots past the
 * last 7 go, and so do pre-update copies from earlier days. Throws SnapshotFailed for a bad copy,
 * which is discarded: the older snapshots all stay.
 */
export function takeDailySnapshot(
  sqlite: Database.Database,
  dir: string,
  at: number,
  { check }: SnapshotOptions = {},
): Snapshot | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, snapshotName('daily', at));
  if (existsSync(path)) return null;
  copyDatabase(sqlite, path, check);

  const names = readdirSync(dir);
  const today = localDay(at);
  const removed = [
    ...names
      .filter((name) => dailyName.test(name))
      .sort()
      .reverse()
      .slice(snapshotsKept),
    ...names.filter((name) => {
      const parsed = parseSnapshotName(name);
      return parsed?.kind === 'before-update' && parsed.day < today;
    }),
  ].map((name) => join(dir, name));
  for (const old of removed) rmSync(old, { force: true });
  return { path, removed };
}

/**
 * A snapshot before an update or a restore, named by its kind and time. Before-restore copies past
 * the last 3 go. Throws SnapshotFailed for a bad copy.
 */
export function takeExtraSnapshot(
  sqlite: Database.Database,
  dir: string,
  kind: Exclude<SnapshotKind, 'daily'>,
  at: number,
  { check }: SnapshotOptions = {},
): Snapshot {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, snapshotName(kind, at));
  copyDatabase(sqlite, path, check);
  return { path, removed: kind === 'before-restore' ? rotateBeforeRestore(dir) : [] };
}

/** Removes before-restore copies past the last 3 (with the WAL of one copied as it was, restore.ts). */
export function rotateBeforeRestore(dir: string): string[] {
  const removed = readdirSync(dir)
    .filter((name) => parseSnapshotName(name)?.kind === 'before-restore')
    .sort()
    .reverse()
    .slice(beforeRestoreKept)
    .map((name) => join(dir, name));
  for (const old of removed) {
    rmSync(old, { force: true });
    rmSync(`${old}-wal`, { force: true });
  }
  return removed;
}

/** Every snapshot kept in a folder, of every kind, oldest first (for the images they use). */
export function keptSnapshots(dir: string): string[] {
  return listSnapshots(dir)
    .reverse()
    .map((snapshot) => join(dir, snapshot.name));
}

/** The snapshots in a folder, for Settings → Data: newest first. */
export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];
  const found = readdirSync(dir).flatMap((name) => {
    const parsed = parseSnapshotName(name);
    if (!parsed) return [];
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) return [];
      return [{ name, ...parsed, size: stat.size, modified: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
  // By day, then (within a day) by time: an extra snapshot's own, a daily one's when it was written.
  const timeOf = (snapshot: (typeof found)[number]) =>
    snapshot.time ? `${snapshot.time}` : new Date(snapshot.modified).toTimeString().slice(0, 5);
  return found
    .sort(
      (a, b) =>
        b.day.localeCompare(a.day) || timeOf(b).localeCompare(timeOf(a)) || b.name.localeCompare(a.name),
    )
    .map(({ modified: _modified, ...snapshot }) => snapshot);
}
