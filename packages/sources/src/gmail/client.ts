import type { z } from 'zod';
import {
  type AccessToken,
  CursorExpired,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  SourceUnavailable,
  type SyncCost,
} from '../source';
import { googleError } from './shapes';

// One sync's conversation with the Gmail API (v1, REST over fetch): every request carries a token
// borrowed for it, is paced by Gmail's per-user quota, counts towards the sync's cost (requests, and
// quota units as the Source's own measure), and has Gmail's answers turned into the Source errors the
// sync engine understands.
//
// Quota (decisions #2, #30): Gmail allows 6,000 units a minute per user, and `messages.get` costs 20,
// so at most ~300 messages a minute; the owner's experiment hit the limit after 117 unpaced fetches.
// Requests are paced by a token bucket of units, shared by every sync of the Account: a short burst
// (so the newest mail arrives within seconds), then 5,000 units a minute (250 messages), leaving
// headroom under the limit. Gmail answers a spent quota with 403 `rateLimitExceeded` /
// `userRateLimitExceeded` (or 429): RateLimited, waiting a minute unless told otherwise. Gmail's batch
// endpoint isn't used: each request in a batch costs its own units, so it saves connections, not quota.

// What each call costs in Gmail quota units (Gmail API quota reference; `messages.get` at the 2026
// figure decision #2 records).
export const UNITS = { profile: 1, labels: 1, list: 5, get: 20, history: 2, attachment: 5 } as const;

// The pace: up to BURST units at once, refilled at RATE units a minute.
export const BURST_UNITS = 500;
export const RATE_UNITS_PER_MINUTE = 5_000;
// How long to wait after Gmail's per-minute quota ran out, when it doesn't say.
export const QUOTA_WAIT_MS = 60_000;

// Gmail's reasons for a quota answer (403 or 429).
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);

// A token bucket of quota units. One per Account, kept across its syncs.
export type Pacer = { take(units: number, signal: AbortSignal): Promise<void> };

export function createPacer(
  now: () => number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  { burst = BURST_UNITS, perMinute = RATE_UNITS_PER_MINUTE } = {},
): Pacer {
  let units = burst;
  let at = now();
  const perMs = perMinute / 60_000;
  const refill = () => {
    const time = now();
    units = Math.min(burst, units + (time - at) * perMs);
    at = time;
  };
  return {
    async take(cost, signal) {
      refill();
      if (units < cost) {
        await sleep(Math.ceil((cost - units) / perMs), signal);
        refill();
      }
      units -= cost;
    },
  };
}

// A message Gmail no longer has (deleted between being listed and fetched).
export class MessageGone extends Error {
  override name = 'MessageGone';
}

export type GmailClientOptions = {
  // Gmail's base, like https://gmail.googleapis.com (a fake on this machine in tests).
  gmailUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  pacer: Pacer;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

export type GmailCall = keyof typeof UNITS;

export function connectGmail({ gmailUrl, fetch, now, pacer, accessToken, signal }: GmailClientOptions) {
  const cost: SyncCost = { requests: 0, complexity: 0 };
  const base = `${gmailUrl.replace(/\/$/, '')}/gmail/v1/users/me`;

  async function reasonOf(response: Response): Promise<{ reasons: string[]; message: string | null }> {
    const parsed = googleError.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { reasons: [], message: null };
    const { errors = [], details = [], status, message } = parsed.data.error;
    const reasons = [...errors, ...details].flatMap((each) => (each.reason ? [each.reason] : []));
    return { reasons: status ? [...reasons, status] : reasons, message: message ?? null };
  }

  /** GETs a path under the User's mailbox (`/messages?…`), parsed with `shape`, as one `call`. */
  async function get<T>(call: GmailCall, path: string, shape: z.ZodType<T>): Promise<T> {
    await pacer.take(UNITS[call], signal);
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token.token}`, accept: 'application/json' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach Gmail.', cost);
    }
    cost.requests += 1;
    cost.complexity = (cost.complexity ?? 0) + UNITS[call];
    if (response.ok) {
      const parsed = shape.safeParse(await response.json().catch(() => null));
      if (!parsed.success)
        throw new SourceUnavailable('Gmail sent an answer Commander didn’t understand.', cost);
      return parsed.data;
    }
    const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
    const { reasons } = await reasonOf(response);
    if (
      response.status === 429 ||
      (response.status === 403 && reasons.some((reason) => RATE_REASONS.has(reason)))
    ) {
      throw new RateLimited('Gmail asked Commander to slow down.', retryAfter ?? QUOTA_WAIT_MS, cost);
    }
    if (response.status === 401) throw new SignInRefused('Google refused this Account’s Gmail sign-in.');
    if (response.status === 403) {
      throw new SignInRefused('Google no longer lets Commander read this Account’s Gmail.');
    }
    if (response.status === 404 && call === 'history') {
      throw new CursorExpired('Gmail no longer has the history since Commander’s last sync.');
    }
    if (response.status === 404 && (call === 'get' || call === 'attachment')) throw new MessageGone(path);
    throw new SourceUnavailable(`Gmail couldn’t answer just now (HTTP ${response.status}).`, cost);
  }

  return { get, cost };
}

export type GmailClient = ReturnType<typeof connectGmail>;
