/*
  The Core's limited state (#203). Opening the database can fail in two ways that starting the Core
  again would never mend (core-supervisor.ts would see it fail the same way four times, then stop):

  - damaged: the database fails its integrity check, or isn't a database (item-store/
    database-health.ts). Offered: the newest snapshot that passes the check.
  - update-failed: one of this version's migrations failed; they run all or none, so the database is
    as the previous version left it. Offered: the snapshot taken before the update, and Export
    everything.

  The Core then stays up without an Item store. It keeps beating, so main never restarts it; it
  tells main the database's health, so the window shows the recovery screen instead of Commander;
  and it answers only the recovery screen, through backups (index.ts): the status, Export
  everything, and Restore, which marks the snapshot offered for the relaunch exactly as Settings →
  Data's Restore does (the next Core keeps the database as it is aside, then swaps the snapshot in).
  Nothing else runs: no sync, no Agent, no snapshots of its own.
*/
import { basename, join } from 'node:path';
import {
  type CoreDatabaseHealth,
  type DatabaseRecovery,
  DISK_FULL,
  type SnapshotInfo,
} from '@commander/domain';
import {
  DatabaseDamaged,
  type ItemStore,
  type ItemStoreOptions,
  isDiskFull,
  MigrationFailed,
  openItemStore,
} from '../item-store';
import { integrityProblem, listSnapshots } from '../item-store/snapshots';
import { type BackupsOptions, setUpBackups } from './index';
import { markForRestore, type RestoreOutcome } from './restore';

type Check = (path: string) => string | null;

export type Opened = { ok: true; store: ItemStore } | { ok: false; health: DatabaseRecovery };

/** The newest snapshot that passes its integrity check, or null when none does. */
export function latestGoodSnapshot(
  snapshotDir: string,
  check: Check = integrityProblem,
): SnapshotInfo | null {
  return listSnapshots(snapshotDir).find((snapshot) => !check(join(snapshotDir, snapshot.name))) ?? null;
}

/**
 * Opens the Item store, or says why the Core must stay in its limited state: the database is
 * damaged, or this version couldn't update it. Any other failure throws, as before.
 */
export function openOrRecover(
  options: ItemStoreOptions,
  { restored = null, check = integrityProblem }: { restored?: RestoreOutcome | null; check?: Check } = {},
): Opened {
  const restoreFailed = restored && !restored.ok ? restored.reason : null;
  try {
    return { ok: true, store: openItemStore(options) };
  } catch (error) {
    if (error instanceof DatabaseDamaged) {
      console.warn('The database is damaged:', error.problem);
      return {
        ok: false,
        health: {
          state: 'damaged',
          problem: error.problem,
          snapshot: latestGoodSnapshot(options.snapshotDir, check),
          restoreFailed,
        },
      };
    }
    if (error instanceof MigrationFailed) {
      console.warn(error.message);
      const before = error.preUpdateSnapshot;
      const name = before?.ok ? basename(before.path) : null;
      return {
        ok: false,
        health: {
          state: 'update-failed',
          migration: error.migration,
          reason: isDiskFull(error.cause) ? `${DISK_FULL} (${error.reason})` : error.reason,
          snapshot:
            (name && listSnapshots(options.snapshotDir).find((snapshot) => snapshot.name === name)) || null,
          snapshotProblem: before && !before.ok ? before.reason : null,
          restoreFailed,
        },
      };
    }
    throw error;
  }
}

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
};

/**
 * Keeps the Core in its limited state: tells main the database's health and answers the recovery
 * screen, for as long as the Core runs. Never resolves, so nothing after it runs (index.ts).
 */
export function stayInRecovery({
  health,
  port,
  signals = process,
  ...backups
}: {
  health: DatabaseRecovery;
  port: ParentPort;
  // Where SIGTERM is heard (tests stand in for the process).
  signals?: { on(event: 'SIGTERM', listener: () => void): unknown };
} & Pick<BackupsOptions, 'dataDir' | 'snapshotDir' | 'attachmentsDir' | 'restored'>): Promise<never> {
  const send = (message: unknown) => port.postMessage(message);
  const recovery = setUpBackups({
    ...backups,
    store: null,
    send,
    queue: () => undefined,
    recover() {
      if (!health.snapshot) throw new Error('There is no snapshot to restore.');
      markForRestore(backups.dataDir, health.snapshot.name);
    },
  });
  port.on('message', ({ data }) => {
    recovery.handle(data);
  });
  send({ type: 'database-health', health } satisfies CoreDatabaseHealth);
  // Quit stops the Core with SIGTERM: an unfinished export's folder goes first.
  signals.on('SIGTERM', () => {
    recovery.stop();
    process.exit(0);
  });
  return new Promise<never>(() => {});
}
