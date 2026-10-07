import { z } from 'zod';
import { snapshotInfo, snapshotProblem } from './backups-messages';
import { source } from './items';
import { accountSyncStatus, syncOutcomeKind, syncTrigger } from './sync-messages';

/*
  Logs and Diagnostics (#207): Settings → Diagnostics shows how Commander is doing in plain words, and
  Export diagnostics writes a file the User picks (the system save picker, shown by the main process)
  with the logs, versions and the settings that aren't secret, ready to attach to an issue.

  The Core reports what only it knows: recent sync runs, where each Account's syncing stands, the
  database's version and the settings. Never a token, a key, email text or Item content: runs carry
  counts and the plain reason a sync failed, and the export is blanked and checked again before it is
  written (the Core checks its lines for any token or key it holds: `check`).
*/

const requestId = z.number().int().positive();
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

// One sync run, as the Item store recorded it (syncState.recordRun).
export const syncRunInfo = z.object({
  account: z.string().min(1),
  source,
  trigger: syncTrigger,
  startedAt: timestamp,
  finishedAt: timestamp,
  outcome: syncOutcomeKind,
  created: count,
  updated: count,
  tombstoned: count,
  unchanged: count,
  requests: count,
  // The plain reason it didn't finish, as Settings → Accounts shows it.
  error: z.string().nullable(),
});
export type SyncRunInfo = z.infer<typeof syncRunInfo>;

export const diagnosticsReport = z.object({
  // Newest first, every Account's.
  runs: z.array(syncRunInfo),
  // Where each Account's syncing stands, Source by Source.
  syncs: z.array(accountSyncStatus),
  database: z.object({
    // The newest migration this version of Commander has (the database's version once open).
    migration: z.string().nullable(),
    // The migrations this start ran, by name (an update changed the database).
    migrated: z.array(z.string()),
  }),
  // Changes made in Commander that couldn't sync (#206), counted per Account and Source, with the
  // latest plain reason; never what the changes were or which Items.
  couldntSync: z.array(
    z.object({ account: z.string().min(1), source, count: count, error: z.string().nullable() }),
  ),
  // The snapshots kept, newest first, and any that failed (backups-messages.ts).
  snapshots: z.array(snapshotInfo),
  snapshotProblems: z.array(snapshotProblem),
  // Settings that aren't secret: Ares's models and cap, and the Autonomy settings. API keys and
  // sign-in tokens live in the keyring and never come here.
  settings: z.record(z.string(), z.unknown()),
});
export type DiagnosticsReport = z.infer<typeof diagnosticsReport>;

// Main process → Core: the report, or which of the export's lines hold a token or key the Core knows.
export const coreDiagnosticsRequest = z.object({
  type: z.literal('diagnostics-request'),
  id: requestId,
  request: z.discriminatedUnion('op', [
    z.object({ op: z.literal('report') }),
    z.object({ op: z.literal('check'), lines: z.array(z.string()) }),
  ]),
});
export type CoreDiagnosticsRequest = z.input<typeof coreDiagnosticsRequest>;

// Core → main process. `held`: the indexes of the lines holding a token or key.
export const coreDiagnosticsReply = z.object({
  type: z.literal('diagnostics-reply'),
  id: requestId,
  response: z.union([
    z.object({ op: z.literal('report'), report: diagnosticsReport }),
    z.object({ op: z.literal('check'), held: z.array(count) }),
  ]),
});
export type CoreDiagnosticsReply = z.infer<typeof coreDiagnosticsReply>;

// The window → main process: the report for the page, or Export diagnostics (the save picker first).
export const diagnosticsRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('report') }),
  z.object({ op: z.literal('export') }),
]);
export type DiagnosticsRequest = z.input<typeof diagnosticsRequest>;

// `report`: null while the Core is down (or didn't answer). `exported`: the file written, once the
// export is done (null when the User cancelled the picker).
export type DiagnosticsResponse =
  | { ok: true; report: DiagnosticsReport | null; exported?: string | null }
  | { ok: false; error: string; report: DiagnosticsReport | null };
