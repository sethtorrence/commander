import type { z } from 'zod';
import {
  type AccessToken,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  SourceUnavailable,
  type SyncCost,
} from '../source';

// One sync's conversation with Microsoft Graph (v1.0): every request carries a token borrowed for
// it, counts towards the sync's cost, waits so no Chat gets more than one request a second (Teams'
// limit), follows `@odata.nextLink` only back to Graph itself, and turns Graph's answers into the
// Source errors the sync engine understands. 429s, and 503s with Retry-After, are rate limits: the
// sync stops at once and the engine waits at least as long as Microsoft asked.

export type GraphOptions = {
  // Graph's base, like https://graph.microsoft.com/v1.0 (a fake on this machine in tests).
  graphUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

// Graph refused one Chat's resource (403 or 404: no longer allowed to read it, or gone).
export class ChatUnreadable extends Error {
  override name = 'ChatUnreadable';
}

// Teams allows one request a second per Chat.
export const PER_CHAT_GAP_MS = 1_000;

export type GraphPage<T> = { value: T[]; '@odata.nextLink'?: string | undefined };

export function connectGraph({ graphUrl, fetch, now, sleep, accessToken, signal }: GraphOptions) {
  const cost: SyncCost = { requests: 0, complexity: null };
  const base = graphUrl.replace(/\/$/, '');
  const lastRequestAt = new Map<string, number>();

  // Waits until the Chat may have another request.
  async function pace(chatId: string) {
    const last = lastRequestAt.get(chatId);
    if (last !== undefined) {
      const wait = last + PER_CHAT_GAP_MS - now();
      if (wait > 0) await sleep(wait, signal);
    }
    lastRequestAt.set(chatId, now());
  }

  // GETs a path under Graph's base (or a nextLink Graph gave), parsed with `shape`. `chatId`: the
  // Chat the request is about, for pacing and for treating a refusal as that Chat's alone.
  async function get<T>(pathOrLink: string, shape: z.ZodType<T>, chatId?: string): Promise<T> {
    const url = pathOrLink.startsWith('/') ? `${base}${pathOrLink}` : pathOrLink;
    // A nextLink anywhere else would carry the User's token off Graph.
    if (!url.startsWith(`${base}/`)) {
      throw new SourceUnavailable('Microsoft Teams sent a link Commander didn’t expect.', cost);
    }
    if (chatId) await pace(chatId);
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${token.token}`, accept: 'application/json' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach Microsoft Teams.', cost);
    }
    cost.requests += 1;
    const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
    if (response.status === 429 || (response.status === 503 && retryAfter !== null)) {
      throw new RateLimited('Microsoft asked Commander to check Teams less often.', retryAfter, cost);
    }
    if (response.status === 401) {
      throw new SignInRefused('Microsoft refused this Teams Account’s sign-in.');
    }
    if ((response.status === 403 || response.status === 404) && chatId) {
      throw new ChatUnreadable(`Teams wouldn’t share chat ${chatId} (HTTP ${response.status}).`);
    }
    if (response.status === 403) {
      throw new SignInRefused('Microsoft no longer lets Commander read this Account’s Teams Chats.');
    }
    if (!response.ok) {
      throw new SourceUnavailable(
        `Microsoft Teams couldn’t answer just now (HTTP ${response.status}).`,
        cost,
      );
    }
    const parsed = shape.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new SourceUnavailable('Microsoft Teams sent an answer Commander didn’t understand.', cost);
    }
    return parsed.data;
  }

  // Every item of a paged collection, page by page, until `enough` says to stop.
  async function all<T>(
    path: string,
    page: z.ZodType<GraphPage<T>>,
    options: { chatId?: string; enough?: (sofar: T[]) => boolean } = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const data: GraphPage<T> = await get(next, page, options.chatId);
      items.push(...data.value);
      if (options.enough?.(items)) break;
      next = data['@odata.nextLink'];
    }
    return items;
  }

  return { get, all, cost };
}

export type Graph = ReturnType<typeof connectGraph>;
