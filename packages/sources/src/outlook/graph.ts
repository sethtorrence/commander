import type { z } from 'zod';
import {
  type AccessToken,
  CursorExpired,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  SourceUnavailable,
  type SyncCost,
  WriteRejected,
} from '../source';
import type { Gate } from './mailbox-gate';
import { batchAnswer, graphError } from './shapes';

// One sync's (or write's, or part fetch's) conversation with Microsoft Graph v1.0 about the User's
// mail, REST over fetch (decision #8): every request carries a token borrowed for it and asks for
// immutable ids (so a message moved between folders keeps its id), goes through the mailbox's gate
// (no more than 4 at once, mailbox-gate.ts), counts towards the cost, follows links only back to Graph
// itself, and has Graph's answers turned into the Source errors the sync engine understands:
//
// - 429, and 503 with Retry-After: RateLimited, waiting as long as Microsoft asked;
// - an expired or invalid delta link (410, SyncStateNotFound, resyncRequired): CursorExpired;
// - 401: SignInRefused; 403: SignInRefused for reads, WriteRejected for writes;
// - 404: GraphNotFound, for the caller to say what a thing gone means;
// - a write's 400: WriteRejected (Outlook refused the change itself).

export type GraphMailOptions = {
  // Graph's base, like https://graph.microsoft.com/v1.0 (a fake on this machine in tests).
  graphUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  gate: Gate;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

// Mail a page at a time, under immutable ids.
const PAGE_SIZE = 50;
const READ_PREFER = `IdType="ImmutableId", odata.maxpagesize=${PAGE_SIZE}`;
const WRITE_PREFER = 'IdType="ImmutableId"';
// The most requests a JSON batch carries: Graph runs them side by side against the one mailbox, whose
// limit is 4 at once.
export const BATCH_SIZE = 4;

// Graph's ways of saying a delta link can't be used any more.
const RESYNC_CODES = new Set(['syncstatenotfound', 'syncstateinvalid', 'resyncrequired']);

// Graph doesn't have it (any more): a message, folder or attachment.
export class GraphNotFound extends Error {
  override name = 'GraphNotFound';
}

// Graph refused a read as asked (a 400: a query option or property it won't take here), so the caller
// can ask more plainly.
export class GraphBadRequest extends Error {
  override name = 'GraphBadRequest';
}

const THROTTLED = 'Microsoft asked Commander to check Outlook less often.';

type Purpose = 'read' | 'write';

export function connectGraphMail({ graphUrl, fetch, now, gate, accessToken, signal }: GraphMailOptions) {
  const cost: SyncCost = { requests: 0, complexity: null };
  const base = graphUrl.replace(/\/$/, '');

  const urlOf = (pathOrLink: string) => {
    const url = pathOrLink.startsWith('/') ? `${base}${pathOrLink}` : pathOrLink;
    // A link anywhere else would carry the User's token off Graph.
    if (!url.startsWith(`${base}/`))
      throw new SourceUnavailable('Outlook sent a link Commander didn’t expect.', cost);
    return url;
  };

  // A refusal, as the Source error it means.
  function refusal(
    status: number,
    code: string,
    message: string | null,
    retryAfter: number | null,
    purpose: Purpose,
  ) {
    if (status === 429 || (status === 503 && retryAfter !== null))
      return new RateLimited(THROTTLED, retryAfter, cost);
    if (purpose === 'read' && (status === 410 || RESYNC_CODES.has(code)))
      return new CursorExpired('Outlook no longer accepts this folder’s delta link.');
    if (status === 401) return new SignInRefused('Microsoft refused this Outlook Account’s sign-in.');
    if (status === 404) return new GraphNotFound(message ?? 'Outlook doesn’t have that.');
    if (purpose === 'write' && (status === 400 || status === 403))
      return new WriteRejected(`Outlook wouldn’t make this change${message ? `: ${message}` : '.'}`);
    if (status === 400) return new GraphBadRequest(message ?? 'Outlook wouldn’t take that request.');
    if (status === 403)
      return new SignInRefused('Microsoft no longer lets Commander read this Account’s mail.');
    return new SourceUnavailable(`Outlook couldn’t answer just now (HTTP ${status}).`, cost);
  }

  async function exchange(
    method: string,
    pathOrLink: string,
    payload: unknown,
    purpose: Purpose,
    weight = 1,
  ): Promise<Response> {
    const url = urlOf(pathOrLink);
    return gate(async () => {
      signal.throwIfAborted();
      const token = await accessToken();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token.token}`,
            accept: 'application/json',
            prefer: purpose === 'write' ? WRITE_PREFER : READ_PREFER,
            ...(payload !== undefined && { 'content-type': 'application/json' }),
          },
          ...(payload !== undefined && { body: JSON.stringify(payload) }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SourceUnavailable('Commander couldn’t reach Outlook.', cost);
      }
      cost.requests += 1;
      if (!response.ok) {
        const body = graphError.safeParse(await response.json().catch(() => null));
        const error = body.success ? body.data?.error : null;
        const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
        throw refusal(
          response.status,
          (error?.code ?? '').toLowerCase(),
          error?.message ?? null,
          retryAfter,
          purpose,
        );
      }
      return response;
    }, weight);
  }

  async function parsed<T>(response: Response, shape: z.ZodType<T>): Promise<T> {
    const text = await response.text().catch(() => '');
    let answer: unknown;
    try {
      answer = text ? JSON.parse(text) : null;
    } catch {
      answer = undefined;
    }
    const result = shape.safeParse(answer);
    if (!result.success)
      throw new SourceUnavailable('Outlook sent an answer Commander didn’t understand.', cost);
    return result.data;
  }

  /** GETs a path under Graph's base, or a link Graph gave. */
  async function get<T>(pathOrLink: string, shape: z.ZodType<T>): Promise<T> {
    return parsed(await exchange('GET', pathOrLink, undefined, 'read'), shape);
  }

  /** Sends a write (PATCH, POST), or reads for one, and parses its answer. */
  async function send<T>(method: string, path: string, payload: unknown, shape: z.ZodType<T>): Promise<T> {
    return parsed(await exchange(method, path, payload, 'write'), shape);
  }

  /**
   * PUTs one chunk of an attachment to an upload session's URL (#138). The URL is Graph's answer and
   * carries its own authorisation, so the User's token never goes with it.
   */
  async function upload(url: string, chunk: Uint8Array, start: number, total: number): Promise<void> {
    if (!/^https?:\/\//.test(url))
      throw new SourceUnavailable('Outlook sent an upload link Commander didn’t expect.', cost);
    await gate(async () => {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${start + chunk.byteLength - 1}/${total}`,
          },
          body: chunk as Uint8Array<ArrayBuffer>,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SourceUnavailable('Commander couldn’t reach Outlook.', cost);
      }
      cost.requests += 1;
      if (!response.ok) {
        const body = graphError.safeParse(await response.json().catch(() => null));
        const error = body.success ? body.data?.error : null;
        const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
        throw refusal(
          response.status,
          (error?.code ?? '').toLowerCase(),
          error?.message ?? null,
          retryAfter,
          'write',
        );
      }
    });
  }

  /** GETs raw bytes (an attachment's `$value`). */
  async function bytes(path: string): Promise<Uint8Array> {
    const response = await exchange('GET', path, undefined, 'read');
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * GETs several paths in JSON batches of BATCH_SIZE, each holding as many of the mailbox's places as
   * it carries. Answers each path's body, or null where Graph doesn't have it (404); a throttled
   * request throttles the whole call, and a refused sign-in refuses it. `lenient`: any other refusal of
   * one request (a 400, a passing 5xx) answers null for it too, for reads that are only a help.
   */
  async function batch(paths: readonly string[], { lenient = false } = {}): Promise<Map<string, unknown>> {
    const answers = new Map<string, unknown>();
    for (let at = 0; at < paths.length; at += BATCH_SIZE) {
      const chunk = paths.slice(at, at + BATCH_SIZE);
      const requests = chunk.map((url, index) => ({
        id: String(index + 1),
        method: 'GET',
        url,
        headers: { prefer: WRITE_PREFER },
      }));
      const response = await exchange('POST', '/$batch', { requests }, 'read', chunk.length);
      const { responses } = await parsed(response, batchAnswer);
      for (const [index, path] of chunk.entries()) {
        const answer = responses.find((each) => each.id === String(index + 1));
        if (!answer) throw new SourceUnavailable('Outlook left out part of an answer.', cost);
        if (answer.status >= 200 && answer.status < 300) {
          answers.set(path, answer.body ?? null);
          continue;
        }
        const error = graphError.safeParse(answer.body);
        const code = error.success ? (error.data?.error?.code ?? '') : '';
        const message = error.success ? (error.data?.error?.message ?? null) : null;
        const retryAfter = retryAfterMs(
          answer.headers?.['Retry-After'] ?? answer.headers?.['retry-after'] ?? null,
          now(),
        );
        const failure = refusal(answer.status, code.toLowerCase(), message, retryAfter, 'read');
        const fatal = failure instanceof RateLimited || failure instanceof SignInRefused;
        if (failure instanceof GraphNotFound || (lenient && !fatal)) answers.set(path, null);
        else throw failure;
      }
    }
    return answers;
  }

  return { get, send, bytes, batch, upload, cost };
}

export type GraphMail = ReturnType<typeof connectGraphMail>;
