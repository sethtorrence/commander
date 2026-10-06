/*
  Restoring a snapshot (#202). Swapping the database can't happen under an open connection, so it is
  done while nothing has it open:

  - Settings → Data's Restore (typed confirmation) reaches the running Core, which checks the snapshot
    and marks it (`restore-pending.json` in the data folder, `markForRestore`); the main process then
    relaunches Commander, and the new Core makes the restore (`applyPendingRestore`) before it opens
    the database.
  - `restoreSnapshot` itself needs no Item store, so a recovery screen (#203) can call it directly
    on a database that won't open.

  A restore keeps the current database aside first, as one more snapshot (`before-restore`, checked;
  copied as it is when it can't be read, so nothing is ever lost), then swaps the chosen snapshot in
  (written beside the database and renamed over it, its old WAL gone first so SQLite can't replay it
  onto the restored file), and puts back the pasted images it uses from `snapshots/attachments/`.

  Changes waiting to reach a Source in the restored copy may since have gone (a sent message, say),
  so each one is held as Couldn't sync, for the User to Retry once they've looked; sync then catches
  up from each Source.
*/
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { attachmentsUsedInFile } from '../item-store/attachments';
import {
  integrityProblem,
  listSnapshots,
  rotateBeforeRestore,
  snapshotName,
  takeExtraSnapshot,
} from '../item-store/snapshots';

export const RESTORE_MARKER = 'restore-pending.json';

// Where a data folder keeps what a restore touches (as the Core lays it out, index.ts).
export function dataLayout(dataDir: string) {
  return {
    database: join(dataDir, 'commander.db'),
    snapshots: join(dataDir, 'snapshots'),
    attachments: join(dataDir, 'attachments'),
    marker: join(dataDir, RESTORE_MARKER),
  };
}

/** A snapshot that can't be restored, with the reason for the User. */
export class RestoreRefused extends Error {
  override name = 'RestoreRefused';
}

// What the restored copy's held changes say, for the Outbox and Couldn't sync.
export const HELD_AFTER_RESTORE =
  'Held after a restore: this change may have reached the Source before the snapshot was restored. Check it there, then Retry.';

export type RestoreOutcome =
  | { ok: true; name: string; at: number; keptAside: string | null; missingImages: number }
  | { ok: false; name: string; at: number; reason: string };

type Check = (path: string) => string | null;

/** The snapshot's path, once it is one of the folder's and passes its integrity check. */
function checkedSnapshot(snapshotsDir: string, name: string, check: Check): string {
  if (!listSnapshots(snapshotsDir).some((snapshot) => snapshot.name === name))
    throw new RestoreRefused('That snapshot is no longer there.');
  const path = join(snapshotsDir, name);
  const problem = check(path);
  if (problem)
    throw new RestoreRefused(`That snapshot fails its integrity check, so it can’t be restored: ${problem}`);
  return path;
}

/** Checks a snapshot can be restored, and marks it for the next start. Throws RestoreRefused. */
export function markForRestore(
  dataDir: string,
  name: string,
  { check = integrityProblem }: { check?: Check } = {},
) {
  const layout = dataLayout(dataDir);
  checkedSnapshot(layout.snapshots, name, check);
  const partial = `${layout.marker}.partial`;
  writeFileSync(partial, JSON.stringify({ name }));
  renameSync(partial, layout.marker);
}

const marker = z.object({ name: z.string().regex(/^commander-[a-z0-9-]+\.db$/) });

/** The snapshot marked to be restored, if any. */
export function pendingRestore(dataDir: string): string | null {
  const { marker: path } = dataLayout(dataDir);
  if (!existsSync(path)) return null;
  try {
    return marker.parse(JSON.parse(readFileSync(path, 'utf8'))).name;
  } catch {
    return null;
  }
}

// Keeps the database as it is now, as a before-restore snapshot. One that can't be read is copied
// as it is (with its WAL beside it), unchecked: it is still the User's data.
function keepAside(database: string, snapshotsDir: string, at: number, check: Check): string | null {
  if (!existsSync(database)) return null;
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(database, { fileMustExist: true });
    return takeExtraSnapshot(sqlite, snapshotsDir, 'before-restore', at, { check }).path;
  } catch {
    mkdirSync(snapshotsDir, { recursive: true });
    const path = join(snapshotsDir, snapshotName('before-restore', at));
    copyFileSync(database, path);
    if (existsSync(`${database}-wal`)) copyFileSync(`${database}-wal`, `${path}-wal`);
    rotateBeforeRestore(snapshotsDir);
    return path;
  } finally {
    sqlite?.close();
  }
}

// Changes waiting to reach a Source in the restored copy are held as Couldn't sync.
function holdOutgoing(path: string) {
  const sqlite = new Database(path, { fileMustExist: true });
  try {
    const queued = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outgoing_changes'")
      .get();
    if (queued)
      sqlite
        .prepare("UPDATE outgoing_changes SET status = 'failed', next_attempt_at = NULL, error = ?")
        .run(HELD_AFTER_RESTORE);
  } finally {
    sqlite.close();
  }
}

// The pasted images the restored database uses, back from beside the snapshots where they're missing.
// Returns how many couldn't be found.
function restoreImages(database: string, snapshotsDir: string, attachmentsDir: string): number {
  let missing = 0;
  const copies = join(snapshotsDir, 'attachments');
  for (const name of attachmentsUsedInFile(database)) {
    const live = join(attachmentsDir, name);
    if (existsSync(live)) continue;
    const copy = join(copies, name);
    if (!existsSync(copy)) {
      missing += 1;
      continue;
    }
    mkdirSync(attachmentsDir, { recursive: true });
    try {
      linkSync(copy, live);
    } catch {
      copyFileSync(copy, live);
    }
  }
  return missing;
}

/**
 * Restores a snapshot over the data folder's database. Nothing may have the database open. Keeps the
 * current one aside first; on any failure before the swap the database is left as it was.
 */
export function restoreSnapshot({
  dataDir,
  name,
  now = Date.now,
  check = integrityProblem,
}: {
  dataDir: string;
  name: string;
  now?: () => number;
  check?: Check;
}): RestoreOutcome {
  const at = now();
  const layout = dataLayout(dataDir);
  const incoming = `${layout.database}.restoring`;
  try {
    const snapshot = checkedSnapshot(layout.snapshots, name, check);
    rmSync(incoming, { force: true });
    copyFileSync(snapshot, incoming);
    holdOutgoing(incoming);
    const keptAside = keepAside(layout.database, layout.snapshots, at, check);
    // The old database's WAL and shared memory go before the swap: replayed onto the restored file
    // they would corrupt it.
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${layout.database}${suffix}`, { force: true });
    renameSync(incoming, layout.database);
    const missingImages = restoreImages(layout.database, layout.snapshots, layout.attachments);
    return { ok: true, name, at, keptAside, missingImages };
  } catch (error) {
    rmSync(incoming, { force: true });
    return { ok: false, name, at, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * At start-up, before the database is opened: makes the restore marked before the relaunch, if any.
 * The mark goes first, so a restore that fails is never tried again on every start.
 */
export function applyPendingRestore({
  dataDir,
  now,
  check,
}: {
  dataDir: string;
  now?: () => number;
  check?: Check;
}): RestoreOutcome | null {
  const layout = dataLayout(dataDir);
  if (!existsSync(layout.marker)) return null;
  const name = pendingRestore(dataDir);
  rmSync(layout.marker, { force: true });
  if (!name)
    return {
      ok: false,
      name: 'unknown',
      at: (now ?? Date.now)(),
      reason: 'The restore mark couldn’t be read.',
    };
  return restoreSnapshot({ dataDir, name, ...(now && { now }), ...(check && { check }) });
}
