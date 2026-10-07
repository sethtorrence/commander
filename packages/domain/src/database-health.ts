import { z } from 'zod';
import { snapshotInfo } from './backups-messages';

/*
  The database's health (#203), as the Core reports it to the main process once it has opened the
  database (or couldn't), and again whenever it changes. Main keeps the latest in the CoreStatus it
  gives the window (ipc.ts).

  - ok: the database opened, passed its check and is up to date.
  - disk-full: a write failed because the disk is full. The Item store has stopped writing (nothing
    half-written; reads go on), the window holds the User's edits and shows its banner, and both
    carry on once there is space again.
  - damaged: the database failed its integrity check on start (or isn't a database at all). The Core
    stays up in its limited state and the window shows the recovery screen: Restore the newest
    snapshot that passes the check (`snapshot`, null when none does), or Quit.
  - update-failed: one of this version's migrations failed (`migration`, by its name, with the
    reason). Migrations run all or none, so the database is as the previous version left it. The
    Core stays up in its limited state and the window shows the failed-update screen: Restore the
    pre-update snapshot (`snapshot`; null, with `snapshotProblem`, when it couldn't be taken),
    Export everything, or Quit.

  `restoreFailed`: a restore made at this start (from one of these screens, before the relaunch)
  that didn't work, with the reason; the database was left as it was.
*/

const timestamp = z.number().int().nonnegative();

export const databaseHealth = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok') }),
  z.object({ state: z.literal('disk-full'), since: timestamp }),
  z.object({
    state: z.literal('damaged'),
    problem: z.string().min(1),
    snapshot: snapshotInfo.nullable(),
    restoreFailed: z.string().nullable(),
  }),
  z.object({
    state: z.literal('update-failed'),
    migration: z.string().min(1),
    reason: z.string().min(1),
    snapshot: snapshotInfo.nullable(),
    snapshotProblem: z.string().nullable(),
    restoreFailed: z.string().nullable(),
  }),
]);
export type DatabaseHealth = z.infer<typeof databaseHealth>;
export type DatabaseRecovery = Extract<DatabaseHealth, { state: 'damaged' | 'update-failed' }>;

/** Whether the Core is in its limited state, so the window shows a recovery screen. */
export const needsRecovery = (health: DatabaseHealth | null | undefined): health is DatabaseRecovery =>
  health?.state === 'damaged' || health?.state === 'update-failed';

// Core → main process: the database's health, sent once the database is open (or couldn't be) and
// whenever it changes.
export const coreDatabaseHealth = z.object({ type: z.literal('database-health'), health: databaseHealth });
export type CoreDatabaseHealth = z.infer<typeof coreDatabaseHealth>;
