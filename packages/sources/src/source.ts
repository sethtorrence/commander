import type { ItemDetail, ItemStatus, LinearCatalog, Source, SourceItem } from '@commander/domain';

// The one Source interface every Source adapter implements (Linear now; GitHub, Calendar, Email
// and Teams later). An adapter only translates: it reads the Source and hands over Items, and
// later (Two-way sync) turns Item changes into Source writes. It never touches the database, never
// schedules itself, and never keeps a token: the sync engine in the Core does all of that, writing
// through the Item store.

// A borrowed access token: OAuth tokens go as "Bearer <token>", API keys as they are.
export type AccessToken = { token: string; kind: 'oauth' | 'api-key' };

// Minutes between syncs: the Source's default, and the choices the User has (per Account).
// `alsoAfterOtherSources`: the Source also has a cheap light sync (a check), which runs whenever
// another Source's Account finishes syncing (unless the User switches it off) and on refresh; its
// cadence then runs full syncs, counted from the last full one (Teams: once a day).
export type Cadence = { defaultMinutes: number; choices: readonly number[]; alsoAfterOtherSources?: boolean };

// A full sync, or a light one (only a cheap check and what it finds changed). Only Sources whose
// cadence has `alsoAfterOtherSources` are ever asked for a light sync.
export type SyncMode = 'full' | 'light';

// An Item from this Account as Commander last saved it.
export type StoredItem = {
  externalId: string;
  title: string;
  people: string[];
  status: ItemStatus;
  detail: ItemDetail | null;
};

// One page of a sync: Items new or changed at the Source, and the external ids it deleted.
export type SyncPage = { items: SourceItem[]; deleted: string[] };

export type SyncRequest = {
  account: string;
  // What the Account's last successful sync returned; null for its first sync (or a full re-sync).
  cursor: unknown;
  mode: SyncMode;
  // Who the User is at the Source in the Account (their Teams user id), when known.
  me?: string | null;
  // The Account's Items Commander holds with these external ids (tombstones aside), as last saved:
  // for Sources that fetch only part of an Item when it changes (a Chat's new messages).
  stored?(externalIds: string[]): StoredItem[];
  // A current access token. Ask for it per request rather than holding on to it.
  accessToken(): Promise<AccessToken>;
  // Hands a page to the engine, which saves it through the Item store at once. Saving the same
  // Items twice is harmless, so a sync that fails half-way can simply run again.
  save(page: SyncPage): void;
  // Hands over what the Source offers the detail pane's pickers, kept per Account (Two-way sync).
  saveCatalog?(catalog: SourceCatalog): void;
  // External ids to read again on every sync whatever changed (the issues behind open Linear Todos,
  // as a reassignment may not show among what changed). Ones the Source no longer has go in `deleted`.
  recheck?: string[];
  // Aborted when the sync is no longer wanted (the Account was removed).
  signal: AbortSignal;
};

// What a Source offers for its synced fields' pickers (Linear: each team's states, members, labels,
// cycles and Linear projects).
export type SourceCatalog = LinearCatalog;

// What a Source reports a sync cost it, for comparing with its limits.
export type SyncCost = { requests: number; complexity: number | null };

// A finished sync: the cursor the next sync starts from, and what it cost.
export type SyncResult = { cursor: unknown; cost: SyncCost };

// Two-way sync: one change the User made to a synced field (see the domain's synced-fields.ts), as
// the outgoing queue hands it over: the field's new value, the Source's value when last synced, and
// when the User made it (an edit made offline carries the time it was made, not sent).
export type FieldChange = { field: string; value: unknown; synced: unknown; madeAt: number };

export type WriteRequest = {
  account: string;
  // The Source's id for the Item.
  externalId: string;
  // The Item's queued changes, one per field (oldest first).
  changes: FieldChange[];
  // A current access token: every write runs as the User.
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

// A change the adapter didn't write because the Source changed that field after the User did: the
// newer change wins, per field. Who made the Source's change (a name, when known) and when.
export type Superseded = { field: string; by: string | null; at: number };

export type WriteResult = {
  // The Item as the Source has it once the write is done, to save at once (null if unknown).
  item: SourceItem | null;
  superseded: Superseded[];
  cost: SyncCost;
};

export type SourceAdapter = {
  source: Source;
  cadence: Cadence;
  // Fetches what changed since `cursor` and hands it over page by page. Rejects with RateLimited,
  // SignInRefused, CursorExpired, or any other error (treated as passing, and retried with back-off).
  sync(request: SyncRequest): Promise<SyncResult>;
  // Two-way sync: writes one Item's queued changes to the Source, sending only the fields that
  // changed, after checking the Source's history for newer changes to them. Safe to run again with
  // the same changes. Rejects with WriteRejected when the Source refuses the change itself, and
  // otherwise as `sync` does. Sources without it are read-only.
  write?(request: WriteRequest): Promise<WriteResult>;
};

// The Source asked Commander to slow down: a 429, or a quota answer under another status (Gmail
// says 403). The engine waits at least `retryAfterMs` when given (Retry-After, or the limit's reset).
export class RateLimited extends Error {
  override name = 'RateLimited';
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly cost: SyncCost | null = null,
  ) {
    super(message);
  }
}

// The Source refused the Account's sign-in (revoked API key or token): it may need reconnecting.
export class SignInRefused extends Error {
  override name = 'SignInRefused';
}

// The Source refused the change itself (an id it doesn't know, a value it won't take): trying again
// won't help, so the change stops as Couldn't sync at once. The message is User-facing.
export class WriteRejected extends Error {
  override name = 'WriteRejected';
}

// The Source no longer accepts the cursor (Gmail historyId expired, a 410): sync again from scratch.
export class CursorExpired extends Error {
  override name = 'CursorExpired';
}

// A passing problem worth retrying (the Source is down, or unreachable), with a User-facing message.
export class SourceUnavailable extends Error {
  override name = 'SourceUnavailable';
  constructor(
    message: string,
    readonly cost: SyncCost | null = null,
  ) {
    super(message);
  }
}

// How long a Retry-After header asks to wait: seconds, or an HTTP date. null when absent or garbled.
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
