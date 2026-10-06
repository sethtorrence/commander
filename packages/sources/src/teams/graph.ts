import { z } from 'zod';
import {
  type AccessToken,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  SourceUnavailable,
  type SyncCost,
} from '../source';

// One sync's (or one write's) conversation with Microsoft Graph (v1.0): every request carries a
// token borrowed for it, counts towards the cost, waits so no Chat gets more than one request a
// second (Teams' limit), follows `@odata.nextLink` only back to Graph itself, and turns Graph's
// answers into the Source errors the sync engine understands. 429s, and 503s with Retry-After, are
// rate limits: the work stops at once and the engine waits at least as long as Microsoft asked.

export type GraphOptions = {
  // Graph's base, like https://graph.microsoft.com/v1.0 (a fake on this machine in tests).
  graphUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
  // Gives up on a request that takes longer than this (writes, so one stuck answer can't hold up
  // the Account's queue); its outcome is then unknown.
  timeoutMs?: number;
};

// Graph refused one Chat's (or channel's) resource (403 or 404: no longer allowed to read it, or
// gone). `said`: Graph's own error message, which tells a missing permission from a closed door.
export class ChatUnreadable extends Error {
  override name = 'ChatUnreadable';
  constructor(
    message: string,
    readonly status: number,
    readonly said: string | null = null,
  ) {
    super(message);
  }
}

const graphError = z.object({
  error: z.object({ code: z.string().nullish(), message: z.string().nullish() }),
});

// Graph's error message from a refusal's body, if it has one.
async function errorSaid(response: Response): Promise<string | null> {
  try {
    const parsed = graphError.safeParse(await response.json());
    return parsed.success
      ? [parsed.data.error.code, parsed.data.error.message].filter(Boolean).join(': ')
      : null;
  } catch {
    return null;
  }
}

// Graph refused a write as it stands (a 400): sending it again won't help.
export class GraphRefused extends Error {
  override name = 'GraphRefused';
}

// Teams allows one request a second per Chat.
export const PER_CHAT_GAP_MS = 1_000;

export type GraphPage<T> = { value: T[]; '@odata.nextLink'?: string | undefined };

export function connectGraph({ graphUrl, fetch, now, sleep, accessToken, signal, timeoutMs }: GraphOptions) {
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

  // Sends a request to a path under Graph's base (or a nextLink Graph gave) and checks the answer.
  // `chatId`: the Chat the request is about, for pacing and for treating a refusal as that Chat's alone
  // (a channel's requests name it as `channel:<id>`, a team's as `team:<id>`).
  async function send(
    method: 'GET' | 'POST',
    pathOrLink: string,
    chatId: string | undefined,
    body?: unknown,
  ): Promise<Response> {
    const url = pathOrLink.startsWith('/') ? `${base}${pathOrLink}` : pathOrLink;
    // A nextLink anywhere else would carry the User's token off Graph.
    if (!url.startsWith(`${base}/`)) {
      throw new SourceUnavailable('Microsoft Teams sent a link Commander didn’t expect.', cost);
    }
    if (chatId) await pace(chatId);
    const token = await accessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal,
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
      throw new ChatUnreadable(
        `Teams wouldn’t share ${chatId} (HTTP ${response.status}).`,
        response.status,
        await errorSaid(response),
      );
    }
    if (response.status === 403) {
      throw new SignInRefused('Microsoft no longer lets Commander read this Account’s Teams Chats.');
    }
    if (response.status === 400 && method === 'POST') {
      throw new GraphRefused('Microsoft Teams refused this change (HTTP 400).');
    }
    if (!response.ok) {
      throw new SourceUnavailable(
        `Microsoft Teams couldn’t answer just now (HTTP ${response.status}).`,
        cost,
      );
    }
    return response;
  }

  async function parse<T>(response: Response, shape: z.ZodType<T>): Promise<T> {
    let json: unknown = null;
    try {
      json = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const parsed = shape.safeParse(json);
    if (!parsed.success) {
      throw new SourceUnavailable('Microsoft Teams sent an answer Commander didn’t understand.', cost);
    }
    return parsed.data;
  }

  // GETs a path under Graph's base (or a nextLink Graph gave), parsed with `shape`.
  async function get<T>(pathOrLink: string, shape: z.ZodType<T>, chatId?: string): Promise<T> {
    return parse(await send('GET', pathOrLink, chatId), shape);
  }

  // POSTs JSON to a path under Graph's base about one Chat: the answer parsed with `shape`, or
  // nothing (for actions Graph answers with 204).
  async function post<T>(
    path: string,
    body: unknown,
    chatId: string,
    shape?: z.ZodType<T>,
  ): Promise<T | null> {
    const response = await send('POST', path, chatId, body);
    if (!shape) {
      await response.body?.cancel();
      return null;
    }
    return parse(response, shape);
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

  return { get, post, all, cost };
}

export type Graph = ReturnType<typeof connectGraph>;
