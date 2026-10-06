import { z } from 'zod';
import type { AccountSyncStatus } from './ipc';
import { source } from './items';

// Source sync across the process seams. The Core runs the sync engine; the main process tells it
// which Accounts exist (and whether they need reconnecting), what the machine is doing (asleep,
// offline), and what the User asked for in Settings → Accounts; the Core reports each Account's
// sync status back, and any sign-in the Source refused.

const accountId = z.string().min(1);

// Why a sync ran: on the Account's cadence, at once (Sync now, opening a Section, after an edit), or
// as a light check after another Source's sync (Teams).
export const syncTrigger = z.enum(['scheduled', 'refresh', 'alongside']);
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
  // Sources with a light sync only (Teams): whether it also checks whenever another Source syncs. Their
  // `nextSyncAt` is then the next full sync, and `lastSyncedAt` the last sync of either kind.
  alsoAfterOtherSources: z.boolean().optional(),
  // Sources with hourly limits only (GitHub): what the Account's syncs used in the last hour (REST
  // requests charged, and GraphQL points), against GitHub's limits, which the User's other tools share.
  hourUse: z
    .object({
      requests: z.number().int().nonnegative(),
      complexity: z.number().int().nonnegative(),
      requestLimit: z.number().int().positive(),
      complexityLimit: z.number().int().positive(),
    })
    .optional(),
  // How far a long sync has got (Gmail's 30-day download), while it runs; null otherwise.
  progress: z
    .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .nullable()
    .optional(),
});
// The zod-free AccountSyncStatus type in ipc.ts (for the preload and window) must match the schema.
type _StatusMatches = [AccountSyncStatus] extends [z.infer<typeof accountSyncStatus>]
  ? [z.infer<typeof accountSyncStatus>] extends [AccountSyncStatus]
    ? true
    : never
  : never;
const _statusMatches: _StatusMatches = true;
void _statusMatches;

// Main process → Core: the Accounts to sync, sent at start-up and whenever they change.
// Most Accounts carry one Source (`source`); an Account carrying several that share its sign-in (a
// Google Account's Gmail and Google Calendar) lists those switched on (`sources`), each synced on its own.
// `name`: what the User sees ("Acme"), for Ares's Reconnect line.
// `connectedAt`: when the User connected the Account (Gmail downloads the 30 days before it).
const syncAccountBase = {
  id: accountId,
  needsReconnect: z.boolean(),
  me: accountId.nullable().optional(),
  name: z.string().optional(),
  connectedAt: z.number().int().nonnegative().nullable().optional(),
  // Who the User is in the Account, as People know them (#117): their own handles there (see the
  // domain's people.ts, ownHandles) and the name the Account has for them.
  own: z.object({ handles: z.array(z.string().min(1)), name: z.string().nullable() }).optional(),
  // Teams (#111): whether to sync Channel posts too (granted and switched on).
  channelPosts: z.boolean().optional(),
};
export const coreSyncAccounts = z.object({
  type: z.literal('sync-accounts'),
  // `me`: who the User is in the Account (their Linear user id), for Linear Todos; null until known.
  accounts: z.array(
    z.union([
      z.object({ ...syncAccountBase, source }),
      z.object({ ...syncAccountBase, sources: z.array(source).min(1) }),
    ]),
  ),
  // Where to reach each Source (the end-to-end tests point Linear and Graph at fakes on this machine).
  // `graph`: Microsoft Graph's base, for Teams. `googleCalendar`: the Google Calendar API's base.
  // `github`: GitHub's REST API base. `gmail`: the Gmail API's base.
  endpoints: z.object({
    linear: z.string().url(),
    graph: z.string().url().optional(),
    googleCalendar: z.string().url().optional(),
    github: z.string().url().optional(),
    gmail: z.string().url().optional(),
  }),
});
export type CoreSyncAccounts = z.infer<typeof coreSyncAccounts>;

// Main process → Core: what the User asked for in Settings → Accounts (or a Section asked for).
export const coreSyncCommand = z.object({
  type: z.literal('sync-command'),
  command: z.discriminatedUnion('op', [
    // `source`: just one of the Sources the Account carries; otherwise all of them. (Opening Email
    // refreshes only each Google Account's Gmail.)
    z.object({ op: z.literal('refresh'), account: accountId, source: source.optional() }),
    z.object({
      op: z.literal('set-cadence'),
      account: accountId,
      source: source.optional(),
      minutes: z.number().int().positive(),
    }),
    z.object({ op: z.literal('set-also-after-other-sources'), account: accountId, enabled: z.boolean() }),
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

// Core → main process: Microsoft refused to share a Teams Account's channel messages for want of
// `ChannelMessage.Read.All` (consent withdrawn, or never really given): Channel posts go back to off,
// with Request access, until the sign-in carries it again.
export const coreChannelPostsRefused = z.object({
  type: z.literal('channel-posts-refused'),
  account: accountId,
});
export type CoreChannelPostsRefused = z.infer<typeof coreChannelPostsRefused>;
