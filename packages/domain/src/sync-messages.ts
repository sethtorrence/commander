import { z } from 'zod';
import type { AccountSyncStatus } from './ipc';
import { source } from './items';

// Source sync across the process seams. The Core runs the sync engine; the main process tells it
// which Accounts exist (and whether they need reconnecting), what the machine is doing (asleep,
// offline), and what the User asked for in Settings → Accounts; the Core reports each Account's
// sync status back, and any sign-in the Source refused.

const accountId = z.string().min(1);

// Why a sync ran: on the Account's cadence, or at once (Sync now, opening a Section, after an edit).
export const syncTrigger = z.enum(['scheduled', 'refresh']);
export type SyncTrigger = z.infer<typeof syncTrigger>;

export const syncOutcomeKind = z.enum(['synced', 'rate-limited', 'refused', 'failed']);
export type SyncOutcomeKind = z.infer<typeof syncOutcomeKind>;

// What went wrong with an Account's last sync, in plain words for Settings → Accounts.
export const syncProblem = z.object({
  kind: z.enum(['rate-limited', 'refused', 'failed']),
  message: z.string(),
});
export type SyncProblem = z.infer<typeof syncProblem>;

// What an Account's syncing is doing now.
export const syncActivity = z.enum([
  // Waiting for its next scheduled sync.
  'idle',
  'syncing',
  // Waiting longer after a failure or a rate limit (see `problem` and `nextSyncAt`).
  'backing-off',
  // Offline or asleep: syncing resumes, and catches up once, when the machine is back.
  'offline',
  'asleep',
  // Its sign-in needs reconnecting: skipped until the User reconnects it.
  'needs-reconnect',
]);
export type SyncActivity = z.infer<typeof syncActivity>;

export const accountSyncStatus = z.object({
  account: accountId,
  source,
  activity: syncActivity,
  // Minutes between syncs, and the choices the Source offers (Linear: 15, 30 or 60).
  cadenceMinutes: z.number().int().positive(),
  cadenceChoices: z.array(z.number().int().positive()),
  lastSyncedAt: z.number().int().nonnegative().nullable(),
  nextSyncAt: z.number().int().nonnegative().nullable(),
  // How many of the Account's Items Commander holds (tombstones aside).
  itemCount: z.number().int().nonnegative(),
  problem: syncProblem.nullable(),
  // Two-way sync: the Account's changes made in Commander still on their way to the Source, and those
  // that couldn't sync.
  outgoing: z.object({ pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
});
// The zod-free AccountSyncStatus type in ipc.ts (for the preload and window) must match the schema.
type _StatusMatches = [AccountSyncStatus] extends [z.infer<typeof accountSyncStatus>]
  ? [z.infer<typeof accountSyncStatus>] extends [AccountSyncStatus]
    ? true
    : never
  : never;
const _statusMatches: _StatusMatches = true;
void _statusMatches;

// Main process → Core: the Accounts to sync, sent at start-up and whenever they change. Most carry
// one Source (`source`); an Account carrying several that share its sign-in (a Google Account's Gmail
// and Google Calendar) lists those switched on (`sources`), each synced on its own.
const syncAccountBase = { id: accountId, needsReconnect: z.boolean(), me: accountId.nullable().optional() };
export const coreSyncAccounts = z.object({
  type: z.literal('sync-accounts'),
  // `me`: who the User is in the Account (their Linear user id), for Linear Todos; null until known.
  accounts: z.array(
    z.union([
      z.object({ ...syncAccountBase, source }),
      z.object({ ...syncAccountBase, sources: z.array(source).min(1) }),
    ]),
  ),
  // Where to reach each Source (the end-to-end tests point Linear at a fake on this machine).
  endpoints: z.object({ linear: z.string().url() }),
});
export type CoreSyncAccounts = z.infer<typeof coreSyncAccounts>;

// Main process → Core: what the User asked for in Settings → Accounts (or a Section asked for).
// `source`: just one of the Sources the Account carries; otherwise all of them.
export const coreSyncCommand = z.object({
  type: z.literal('sync-command'),
  command: z.discriminatedUnion('op', [
    z.object({ op: z.literal('refresh'), account: accountId, source: source.optional() }),
    z.object({
      op: z.literal('set-cadence'),
      account: accountId,
      source: source.optional(),
      minutes: z.number().int().positive(),
    }),
  ]),
});
export type CoreSyncCommand = z.infer<typeof coreSyncCommand>;

// Main process → Core: syncing pauses while the machine is asleep or offline.
export const coreSystemState = z.object({
  type: z.literal('system-state'),
  awake: z.boolean(),
  online: z.boolean(),
});
export type CoreSystemState = z.infer<typeof coreSystemState>;

// Core → main process: every Account's sync status, whenever any of it changes.
export const coreSyncStatus = z.object({
  type: z.literal('sync-status'),
  accounts: z.array(accountSyncStatus),
});
export type CoreSyncStatus = z.infer<typeof coreSyncStatus>;

// Core → main process: the Source refused the Account's sign-in (e.g. an API key revoked in
// Linear). The main process checks it and marks the Account Reconnect when it is gone for good.
export const coreAccountRefused = z.object({ type: z.literal('account-refused'), account: accountId });
export type CoreAccountRefused = z.infer<typeof coreAccountRefused>;
