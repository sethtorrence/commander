import { z } from 'zod';
import type { AccountSource, AccountsRequest } from './ipc';
import { type Source, source } from './items';

// Accounts across the process seams. Tokens and API keys live in the main process (the keyring);
// the window only ever sees AccountSummary, and the Core borrows access tokens, in memory only.

// The Sources the User can connect Accounts to so far; the others follow.
export const accountSources = ['linear', 'teams', 'github'] as const satisfies readonly Source[];
export const accountSource = z.enum(accountSources);
// The zod-free AccountSource type in ipc.ts must match.
const _sourceMatches: [AccountSource] extends [z.infer<typeof accountSource>]
  ? [z.infer<typeof accountSource>] extends [AccountSource]
    ? true
    : never
  : never = true;
void _sourceMatches;

// Window → main process: Settings → Accounts. An API key passes this way once, to be checked and
// stored; nothing secret ever comes back. Linear takes API keys, GitHub tokens (and gh's sign-in).
export const accountsRequest = z.union([
  z.object({ op: z.literal('list') }),
  z.object({
    op: z.literal('connect'),
    source: accountSource,
    method: z.literal('oauth'),
    reconnect: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('connect'),
    source: z.enum(['linear', 'github']),
    method: z.literal('api-key'),
    apiKey: z.string().max(500),
    reconnect: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('connect'),
    source: z.literal('github'),
    method: z.literal('cli'),
    reconnect: z.string().min(1).optional(),
  }),
  z.object({ op: z.literal('refresh-details'), accountId: z.string().min(1) }),
  z.object({ op: z.literal('cancel-sign-in') }),
  z.object({ op: z.literal('remove'), accountId: z.string().min(1) }),
  z.object({ op: z.literal('sync-now'), accountId: z.string().min(1) }),
  z.object({
    op: z.literal('set-sync-cadence'),
    accountId: z.string().min(1),
    minutes: z.number().int().positive(),
  }),
]);
// The zod-free AccountsRequest type in ipc.ts (for the preload) must match the schema.
type _RequestMatches = [AccountsRequest] extends [z.infer<typeof accountsRequest>]
  ? [z.infer<typeof accountsRequest>] extends [AccountsRequest]
    ? true
    : never
  : never;
const _requestMatches: _RequestMatches = true;
void _requestMatches;

const requestId = z.number().int().positive();

// Core → main process: a current access token for an Account, for talking to its Source. The main
// process refreshes it first when it is near expiry. The Core keeps it in memory only.
export const coreAccessTokenRequest = z.object({
  type: z.literal('access-token-request'),
  id: requestId,
  account: z.string().min(1),
});
export type CoreAccessTokenRequest = z.infer<typeof coreAccessTokenRequest>;

// Why no token: no such Account; it needs reconnecting (its syncing should pause); or a passing
// problem (offline, keyring locked) worth retrying later.
export const accessTokenFailure = z.enum(['unknown-account', 'needs-reconnect', 'unavailable']);
export type AccessTokenFailure = z.infer<typeof accessTokenFailure>;

export const coreAccessTokenReply = z.object({
  type: z.literal('access-token-reply'),
  id: requestId,
  response: z.discriminatedUnion('ok', [
    // `kind` says how to present it: OAuth tokens as "Bearer <token>", API keys as they are.
    z.object({ ok: z.literal(true), token: z.string().min(1), kind: z.enum(['oauth', 'api-key']) }),
    z.object({ ok: z.literal(false), reason: accessTokenFailure, error: z.string() }),
  ]),
});
export type CoreAccessTokenReply = z.infer<typeof coreAccessTokenReply>;

// Main process → Core: the User removed an Account, so delete (tombstone) its Items.
export const coreRemoveAccountItems = z.object({
  type: z.literal('remove-account-items'),
  id: requestId,
  source,
  account: z.string().min(1),
  // The Account's name, for the activity log's "why".
  name: z.string(),
});
export type CoreRemoveAccountItems = z.infer<typeof coreRemoveAccountItems>;

export const coreRemoveAccountItemsReply = z.object({
  type: z.literal('remove-account-items-reply'),
  id: requestId,
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), removed: z.number().int().nonnegative() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});
export type CoreRemoveAccountItemsReply = z.infer<typeof coreRemoveAccountItemsReply>;
