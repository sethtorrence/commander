import type { Source, SourceItem } from '@commander/domain';

// The one Source interface every Source adapter implements (Linear now; GitHub, Calendar, Email
// and Teams later). An adapter only translates: it reads the Source and hands over Items, and
// later (Two-way sync) turns Item changes into Source writes. It never touches the database, never
// schedules itself, and never keeps a token: the sync engine in the Core does all of that, writing
// through the Item store.

// A borrowed access token: OAuth tokens go as "Bearer <token>", API keys as they are.
export type AccessToken = { token: string; kind: 'oauth' | 'api-key' };

// Minutes between syncs: the Source's default, and the choices the User has (per Account).
export type Cadence = { defaultMinutes: number; choices: readonly number[] };

// One page of a sync: Items new or changed at the Source, and the external ids it deleted.
export type SyncPage = { items: SourceItem[]; deleted: string[] };

export type SyncRequest = {
  account: string;
  // What the Account's last successful sync returned; null for its first sync (or a full re-sync).
  cursor: unknown;
  // A current access token. Ask for it per request rather than holding on to it.
  accessToken(): Promise<AccessToken>;
  // Hands a page to the engine, which saves it through the Item store at once. Saving the same
  // Items twice is harmless, so a sync that fails half-way can simply run again.
  save(page: SyncPage): void;
  // Aborted when the sync is no longer wanted (the Account was removed).
  signal: AbortSignal;
};

// What a Source reports a sync cost it, for comparing with its limits.
export type SyncCost = { requests: number; complexity: number | null };

// A finished sync: the cursor the next sync starts from, and what it cost.
export type SyncResult = { cursor: unknown; cost: SyncCost };

export type SourceAdapter = {
  source: Source;
  cadence: Cadence;
  // Fetches what changed since `cursor` and hands it over page by page. Rejects with RateLimited,
  // SignInRefused, CursorExpired, or any other error (treated as passing, and retried with back-off).
  sync(request: SyncRequest): Promise<SyncResult>;
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
