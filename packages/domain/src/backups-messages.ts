import { z } from 'zod';

/*
  Backups you can restore (#202): Settings → Data lists the database's snapshots (the Core's
  item-store/snapshots.ts), restores one, and exports everything to a folder.

  - Restore asks for typed confirmation (RESTORE_WORD). The Core checks the snapshot and marks it to
    be restored; the main process then relaunches Commander, and the new Core puts the current
    database aside as one more snapshot ("before restore") and swaps the chosen one in, with its
    pasted images, before it opens anything.
  - Export everything writes into a folder the User picks with the system folder picker (shown by
    the main process: the window never names a folder). Its progress comes as `backups-status` core
    messages, and it can be cancelled. Never secrets, tokens or keys: those live in the keyring and
    `secrets.json`, which the export never reads.
*/

const requestId = z.number().int().positive();
const timestamp = z.number().int().nonnegative();

export const snapshotKinds = ['daily', 'before-update', 'before-restore'] as const;
export const snapshotKind = z.enum(snapshotKinds);
export type SnapshotKind = z.infer<typeof snapshotKind>;

// One snapshot: its file name in the snapshots folder, its kind, its local day, its local time (for
// the copies taken before an update or a restore; null for a daily one) and its size in bytes.
export const snapshotInfo = z.object({
  name: z.string().min(1),
  kind: snapshotKind,
  day: z.iso.date(),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  size: z.number().int().nonnegative(),
});
export type SnapshotInfo = z.infer<typeof snapshotInfo>;

// A snapshot that failed: it couldn't be written, or its copy failed the integrity check and was
// discarded. Shown until a later one of that kind succeeds.
export const snapshotProblem = z.object({ kind: snapshotKind, at: timestamp, reason: z.string().min(1) });
export type SnapshotProblem = z.infer<typeof snapshotProblem>;

// The parts of an export, in the order it writes them.
export const exportSteps = ['database', 'daily-notes', 'images', 'attachments', 'readme'] as const;
export type ExportStep = (typeof exportSteps)[number];

// Where Export everything stands. `folder`: the export's own folder (inside the one chosen), once
// done; `done` of `total`: the current step's progress.
export const exportProgress = z.object({
  state: z.enum(['running', 'done', 'cancelled', 'failed']),
  step: z.enum(exportSteps),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  folder: z.string().min(1).nullable(),
  error: z.string().nullable(),
  startedAt: timestamp,
});
export type ExportProgress = z.infer<typeof exportProgress>;

export const backupsStatus = z.object({
  // Newest first.
  snapshots: z.array(snapshotInfo),
  problems: z.array(snapshotProblem),
  // A restore this start of the Core made, or one it couldn't (the database was left as it was).
  restored: z.object({ name: z.string().min(1), at: timestamp, keptAside: z.string().nullable() }).nullable(),
  restoreFailed: z.string().nullable(),
  // The latest export since the Core started, if any.
  export: exportProgress.nullable(),
});
export type BackupsStatus = z.infer<typeof backupsStatus>;

// What the User types to confirm a restore.
export const RESTORE_WORD = 'restore';
export const confirmsRestore = (typed: string) => typed.trim().toLowerCase() === RESTORE_WORD;

const snapshotFileName = z
  .string()
  .min(1)
  .regex(/^commander-[a-z0-9-]+\.db$/);

// The window → main process.
export const backupsRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }),
  // Restores a snapshot, by its file name, once the User typed RESTORE_WORD; Commander relaunches.
  z.object({ op: z.literal('restore'), name: snapshotFileName, confirmation: z.string() }),
  // Shows the system folder picker; the export goes into the folder chosen (if any).
  z.object({ op: z.literal('export') }),
  z.object({ op: z.literal('cancel-export') }),
]);
export type BackupsRequest = z.input<typeof backupsRequest>;

// `relaunching`: a restore was accepted, and Commander is about to relaunch to make it.
export type BackupsResponse =
  | { ok: true; status: BackupsStatus; relaunching?: boolean }
  | { ok: false; error: string; status: BackupsStatus | null };

// Main process → Core. `folder`: an absolute path the main process has checked.
export const coreBackupsRequest = z.object({
  type: z.literal('backups-request'),
  id: requestId,
  request: z.discriminatedUnion('op', [
    z.object({ op: z.literal('status') }),
    z.object({ op: z.literal('restore'), name: snapshotFileName }),
    z.object({ op: z.literal('export'), folder: z.string().min(1) }),
    z.object({ op: z.literal('cancel-export') }),
  ]),
});
export type CoreBackupsRequest = z.input<typeof coreBackupsRequest>;

// Core → main process.
export const coreBackupsReply = z.object({
  type: z.literal('backups-reply'),
  id: requestId,
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), status: backupsStatus }),
    z.object({ ok: z.literal(false), error: z.string(), status: backupsStatus }),
  ]),
});
export type CoreBackupsReply = z.infer<typeof coreBackupsReply>;
