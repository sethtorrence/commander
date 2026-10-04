import type {
  SourceCatalog as DomainSourceCatalog,
  GitHubWatch,
  ItemDetail,
  ItemStatus,
  Source,
  SourceItem,
} from '@commander/domain';

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

// How far a long sync has got: Items done of about how many.
export type SyncProgress = { done: number; total: number };

// One page of a sync: Items new or changed at the Source, and the external ids it deleted.
export type SyncPage = { items: SourceItem[]; deleted: string[] };

export type SyncRequest = {
  account: string;
  // What the Account's last successful sync returned; null for its first sync (or a full re-sync).
  cursor: unknown;
  mode: SyncMode;
  // Who the User is at the Source in the Account (their Teams user id), when known.
  me?: string | null;
  // When the User connected the Account (Gmail downloads the 30 days before it), when known.
  connectedAt?: number | null;
  // The Account's Items Commander holds with these external ids (tombstones aside), as last saved:
  // for Sources that fetch only part of an Item when it changes (a Chat's new messages).
  stored?(externalIds: string[]): StoredItem[];
  // The external ids of every live Item Commander holds from this Account and Source: for a re-sync
  // to tell what the Source no longer has (Gmail, after its history expired).
  heldIds?(): string[];
  // Saves where a long sync has got to (Gmail's first download), so that if it stops (a restart, a
  // rate limit) the next sync is handed this as its cursor and carries on from there.
  checkpoint?(cursor: unknown): void;
  // How far a long sync has got, for the User ("Downloading 30 days: 1,240 of ~3,000"); null once
  // there is nothing to report.
  progress?(progress: SyncProgress | null): void;
  // A current access token. Ask for it per request rather than holding on to it.
  accessToken(): Promise<AccessToken>;
  // Hands a page to the engine, which saves it through the Item store at once. Saving the same
  // Items twice is harmless, so a sync that fails half-way can simply run again.
  save(page: SyncPage): void;
  // Hands over what the Source keeps beside its Items, per Account: the detail pane's pickers (Linear,
  // Two-way sync) or repo health (GitHub).
  saveCatalog?(catalog: SourceCatalog): void;
  // The catalog the Account's last sync handed over, for Sources that update it bit by bit (GitHub's
  // repo health, for the repos pushed to since).
  catalog?: SourceCatalog | null;
  // GitHub: what the Account watches (Settings → GitHub), with the logins GitHub last listed as orgs
  // the Account reaches. null: nothing chosen yet, so nothing is watched.
  watch?: SyncWatch | null;
  // External ids to read again on every sync whatever changed (the issues behind open Linear Todos,
  // as a reassignment may not show among what changed). Ones the Source no longer has go in `deleted`.
  recheck?: string[];
  // External ids the User excluded from Commander (Teams Chats): fetch nothing for them, and hand
  // none of them over. Not deletions: an excluded Chat comes back once the User includes it again.
  excluded?: string[];
  // Aborted when the sync is no longer wanted (the Account was removed).
  signal: AbortSignal;
};

// What a Source keeps beside its Items (Linear: each team's states, members, labels, cycles and Linear
// projects, for its synced fields' pickers; GitHub: each watched repo's health).
export type SourceCatalog = DomainSourceCatalog;

// A GitHub Account's watch list as a sync reads it: the selection, and which owners are orgs.
export type SyncWatch = { selection: GitHubWatch; orgs: readonly string[] };

// What a Source reports a sync cost it, for comparing with its limits. Linear: every request, and the
// complexity it reported. GitHub: the REST requests counted against its hourly limit (a 304 is free),
// and the GraphQL points it charged.
export type SyncCost = { requests: number; complexity: number | null };

// A finished sync: the cursor the next sync starts from, and what it cost.
export type SyncResult = { cursor: unknown; cost: SyncCost };

// Two-way sync: one change the User made to a synced field (see the domain's synced-fields.ts), as
// the outgoing queue hands it over: the field's new value, the Source's value when last synced, and
// when the User made it (an edit made offline carries the time it was made, not sent).
// `attemptedAt`: when an earlier attempt to send it began, if one did. Its outcome isn't known (it
// timed out, the connection dropped, Commander quit mid-way), so before sending again what the
// Source can't take twice (a Teams message), the adapter checks whether that attempt got through.
export type FieldChange = {
  field: string;
  value: unknown;
  synced: unknown;
  madeAt: number;
  attemptedAt?: number | null;
};

export type WriteRequest = {
  account: string;
  // The Source's id for the Item.
  externalId: string;
  // The Item's queued changes, one per field (oldest first).
  changes: FieldChange[];
  // Who the User is at the Source in the Account (their Teams user id), when known.
  me?: string | null;
  // The Account's Items Commander holds with these external ids, as last saved: for Sources whose
  // write answers with only part of the Item (a Teams Chat's new message, not its whole history, or
  // a calendar event without the calendar it is on).
  stored?(externalIds: string[]): StoredItem[];
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

// The email reader (#134): one part of a message (an attachment, or an inline image named by its
// Content-ID), fetched on demand. Never during sync, and never handed to Ares.
export type PartRequest = {
  account: string;
  // The message's external id.
  externalId: string;
  part: { partId: string } | { contentId: string };
  // Larger parts are refused (PartTooLarge) before their bytes are fetched where the Source says
  // their size.
  maxBytes: number;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

export type FetchedPart = { partId: string; name: string; type: string; bytes: Uint8Array };

// The message, or the part asked for, isn't there (any more).
export class PartNotFound extends Error {
  override name = 'PartNotFound';
}

export class PartTooLarge extends Error {
  override name = 'PartTooLarge';
}

export type SourceAdapter = {
  source: Source;
  cadence: Cadence;
  // Sources with hourly limits (GitHub: 5,000 REST requests and 5,000 GraphQL points, shared with the
  // User's other tools): Settings → Accounts shows the last hour's use against them.
  hourlyLimits?: { requests: number; complexity: number };
  // Fetches what changed since `cursor` and hands it over page by page. Rejects with RateLimited,
  // SignInRefused, CursorExpired, or any other error (treated as passing, and retried with back-off).
  sync(request: SyncRequest): Promise<SyncResult>;
  // Two-way sync: writes one Item's queued changes to the Source, sending only the fields that
  // changed, after checking the Source's history for newer changes to them. Safe to run again with
  // the same changes. Rejects with WriteRejected when the Source refuses the change itself, and
  // otherwise as `sync` does. Sources without it are read-only.
  write?(request: WriteRequest): Promise<WriteResult>;
  // Email Sources: one part of a message, for the reader. Rejects with PartNotFound, PartTooLarge,
  // or as `sync` does.
  fetchPart?(request: PartRequest): Promise<FetchedPart>;
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
