/*
  A full disk (#203). When a write through the Item store fails because the disk is full (SQLite's
  SQLITE_FULL, or ENOSPC from a file it writes, a pasted image say):

  - Nothing is half-written: every change runs in a transaction, which SQLite rolls back.
  - The Item store stops writing: the connection goes query-only, so every write after it fails at
    once (as DiskFull) without touching the file, while reads go on. Sync, Ares's jobs and the rest
    see a failed write, as for any other error, and try again later.
  - The failure reaches its caller as DiskFull, whose message is DISK_FULL: the window recognises
    it, holds the User's edits in memory (tryAgainLater) and shows its banner.
  - Every few seconds it looks for space again (at least MIN_FREE_BYTES free in the database's
    folder). Once there is, writing starts again and `onChange(false)` says so: the window clears
    its banner and saves what it held.
*/
import { statfsSync } from 'node:fs';
import { DISK_FULL } from '@commander/domain';
import type Database from 'better-sqlite3';

/** A write the Item store refused, or that failed, because the disk is full. Nothing was changed. */
export class DiskFull extends Error {
  override name = 'DiskFull';
  constructor() {
    super(DISK_FULL);
  }
}

// What there must be free before writing starts again: room for the WAL to grow and a checkpoint.
export const MIN_FREE_BYTES = 32 * 1024 * 1024;
// How often it looks for space while the disk is full.
export const DISK_CHECK_MS = 5_000;

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** Whether an error says the disk is full: SQLite's SQLITE_FULL, or ENOSPC from the file system. */
export function isDiskFull(error: unknown): boolean {
  if (error instanceof DiskFull) return true;
  const code = codeOf(error);
  return code === 'SQLITE_FULL' || code === 'ENOSPC';
}

/** Whether the folder's disk has room to write again. */
export function hasSpaceIn(dir: string): boolean {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize >= MIN_FREE_BYTES;
  } catch {
    return false;
  }
}

export type DiskFullWatch = {
  // The error a failed write should throw: DiskFull when the disk is full (holding writes from now
  // on), or the error itself.
  failed(error: unknown): unknown;
  full(): boolean;
  stop(): void;
};

export function watchDiskFull({
  sqlite,
  hasSpace,
  onChange = () => {},
  checkMs = DISK_CHECK_MS,
  now = Date.now,
}: {
  sqlite: Database.Database;
  hasSpace: () => boolean;
  onChange?: (full: boolean, at: number) => void;
  checkMs?: number;
  now?: () => number;
}): DiskFullWatch {
  let timer: ReturnType<typeof setInterval> | null = null;

  function release() {
    if (!timer || !hasSpace()) return;
    clearInterval(timer);
    timer = null;
    sqlite.pragma('query_only = OFF');
    onChange(false, now());
  }

  return {
    failed(error) {
      // A write refused while writes are held (the connection is query-only).
      if (timer && codeOf(error) === 'SQLITE_READONLY') return new DiskFull();
      if (!isDiskFull(error)) return error;
      if (!timer) {
        sqlite.pragma('query_only = ON');
        timer = setInterval(release, checkMs);
        timer.unref?.();
        onChange(true, now());
      }
      return error instanceof DiskFull ? error : new DiskFull();
    },
    full: () => timer !== null,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * The Item store with every function on it (and on the stores it holds, one level down) passing
 * its errors through `failed`, so a full disk is noticed whichever write hit it, and reaches the
 * caller as DiskFull. Results, and every other error, pass through unchanged.
 */
export function guardWrites<T extends object>(store: T, failed: (error: unknown) => unknown): T {
  const wrap =
    (fn: (...args: unknown[]) => unknown, self: object) =>
    (...args: unknown[]) => {
      let result: unknown;
      try {
        result = fn.apply(self, args);
      } catch (error) {
        throw failed(error);
      }
      if (result instanceof Promise)
        return result.catch((error: unknown) => {
          throw failed(error);
        });
      return result;
    };
  const guard = (target: Record<string, unknown>, depth: number): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        typeof value === 'function'
          ? wrap(value as (...args: unknown[]) => unknown, target)
          : depth > 0 && isPlainObject(value)
            ? guard(value, depth - 1)
            : value,
      ]),
    );
  return guard(store as Record<string, unknown>, 1) as T;
}
