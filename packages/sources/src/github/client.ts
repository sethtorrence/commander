import { z } from 'zod';
import {
  type AccessToken,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  SourceUnavailable,
  type SyncCost,
} from '../source';

/*
  One sync's conversation with GitHub (REST and GraphQL over fetch). Every request carries a token
  borrowed for it ("Bearer <token>") and adds to the sync's cost: REST requests GitHub counts against
  its hourly limit (a 304 answering If-None-Match is free) and the GraphQL points it charged
  (`rateLimit { cost }`, asked for in every query). It remembers the limits GitHub last reported
  (X-RateLimit-* for REST, `rateLimit` for GraphQL) so the adapter can stop before using up what the
  User's other tools share.

  GitHub's answers become the Source errors the sync engine understands:
  - 401: SignInRefused.
  - A primary limit spent (403 or 429 with X-RateLimit-Remaining 0, or GraphQL's RATE_LIMITED) or a
    secondary limit (403 or 429 with Retry-After, or saying so): RateLimited, waiting for Retry-After,
    else until the reset, else a minute (GitHub's advice for secondary limits).
  - Any other 403 or 404: GitHubRefused, for the adapter to treat as out of reach where it can.
  - A GraphQL query that timed out (502 or 504, or GitHub's "may be the result of a timeout"):
    GraphQLTimeout, for the adapter to retry smaller.
  - Anything else: SourceUnavailable, retried with back-off.
*/

export type GitHubClientOptions = {
  // The REST API's base, like https://api.github.com (GraphQL is <apiUrl>/graphql).
  apiUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

// What GitHub last said of one of its limits: what's left of it and when it resets.
export const githubLimit = z.object({ limit: z.number(), remaining: z.number(), resetAt: z.number() });
export type GitHubLimit = z.infer<typeof githubLimit>;
export type GitHubLimits = { rest?: GitHubLimit | undefined; graphql?: GitHubLimit | undefined };

// GitHub refused one resource (403 or 404): no longer reachable, or never was.
export class GitHubRefused extends SourceUnavailable {
  override name = 'GitHubRefused';
  constructor(
    readonly status: number,
    said: string,
    cost: SyncCost,
  ) {
    super(`GitHub refused a request (${said}).`, cost);
  }
}

// A GraphQL query took longer than GitHub allows (10 seconds); a smaller one may do.
export class GraphQLTimeout extends SourceUnavailable {
  override name = 'GraphQLTimeout';
}

// When GitHub asks nothing more precise, how long to wait after a secondary limit.
const SECONDARY_WAIT_MS = 60_000;

// Every query asks for this, so each sync knows what it cost and what's left.
export const RATE_LIMIT_FIELDS = 'rateLimit { cost limit remaining resetAt }';
const rateLimitShape = z
  .object({ cost: z.number(), limit: z.number(), remaining: z.number(), resetAt: z.string() })
  .nullable()
  .optional();

type GraphQLError = { type?: unknown; message?: unknown };

const headerNumber = (headers: Headers, name: string): number | null => {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export type RestAnswer = { status: 200; body: unknown; etag: string | null } | { status: 304 };

export function connectGitHub({ apiUrl, fetch, now, accessToken, signal }: GitHubClientOptions) {
  const cost: SyncCost = { requests: 0, complexity: 0 };
  const limits: GitHubLimits = {};
  const base = apiUrl.replace(/\/$/, '');

  // The limit GitHub reported in this answer's headers, if any.
  function limitFrom(headers: Headers): GitHubLimit | null {
    const limit = headerNumber(headers, 'x-ratelimit-limit');
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (limit === null || remaining === null || reset === null) return null;
    return { limit, remaining, resetAt: reset * 1000 };
  }

  // How long to wait after a limit: Retry-After, else until the limit resets, else a minute.
  function waitFor(headers: Headers): number {
    const retryAfter = retryAfterMs(headers.get('retry-after'), now());
    if (retryAfter !== null) return retryAfter;
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (headerNumber(headers, 'x-ratelimit-remaining') === 0 && reset !== null)
      return Math.max(0, reset * 1000 - now());
    return SECONDARY_WAIT_MS;
  }

  async function send(path: string, init: RequestInit): Promise<Response> {
    const token = await accessToken();
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'Commander',
          ...init.headers,
        },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach GitHub.', cost);
    }
  }

  // Turns a refusal into the error the engine (or the adapter) understands.
  function refusal(response: Response, body: unknown): Error {
    const said = (body as { message?: unknown } | null)?.message;
    const message = typeof said === 'string' ? said : `HTTP ${response.status}`;
    const { status, headers } = response;
    if (status === 401) return new SignInRefused(`GitHub refused this Account’s sign-in: ${message}`);
    const limited =
      status === 429 ||
      (status === 403 &&
        (headerNumber(headers, 'x-ratelimit-remaining') === 0 ||
          headers.get('retry-after') !== null ||
          /rate limit/i.test(message)));
    if (limited) return new RateLimited('GitHub asked Commander to slow down.', waitFor(headers), cost);
    if (status === 403 || status === 404) return new GitHubRefused(status, message, cost);
    return new SourceUnavailable(`GitHub couldn’t answer just now (HTTP ${status}).`, cost);
  }

  // GET a REST path (under the API's base), sending the ETag from last time; a 304 is free.
  async function rest(path: string, etag: string | null = null): Promise<RestAnswer> {
    const response = await send(path, { headers: etag ? { 'if-none-match': etag } : {} });
    const limit = limitFrom(response.headers);
    if (limit && (response.headers.get('x-ratelimit-resource') ?? 'core') === 'core') limits.rest = limit;
    if (response.status === 304) return { status: 304 };
    cost.requests += 1;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw refusal(response, body);
    return { status: 200, body, etag: response.headers.get('etag') };
  }

  // A GraphQL query (which asks for RATE_LIMIT_FIELDS); its rate limit is noted. `allowNotFound`: nodes GitHub no longer
  // has come back null rather than failing the query.
  async function graphql<T>(
    document: string,
    operationName: string,
    variables: Record<string, unknown>,
    data: z.ZodType<T>,
    { allowNotFound = false }: { allowNotFound?: boolean } = {},
  ): Promise<T> {
    const response = await send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: document, operationName, variables }),
    });
    const body: unknown = await response.json().catch(() => null);
    const rateLimit = rateLimitShape.safeParse(
      (body as { data?: { rateLimit?: unknown } } | null)?.data?.rateLimit,
    );
    if (rateLimit.success && rateLimit.data) {
      const { cost: points, limit, remaining, resetAt } = rateLimit.data;
      cost.complexity = (cost.complexity ?? 0) + points;
      limits.graphql = { limit, remaining, resetAt: Date.parse(resetAt) };
    } else {
      const limit = limitFrom(response.headers);
      if (limit) limits.graphql = limit;
    }
    if (response.status === 502 || response.status === 504)
      throw new GraphQLTimeout('GitHub took too long to answer.', cost);
    if (!response.ok) throw refusal(response, body);
    const errors = ((body as { errors?: unknown } | null)?.errors ?? []) as GraphQLError[];
    if (Array.isArray(errors) && errors.length) {
      if (errors.some((error) => error.type === 'RATE_LIMITED')) {
        const resetAt = limits.graphql?.resetAt;
        const wait = resetAt === undefined ? SECONDARY_WAIT_MS : Math.max(0, resetAt - now());
        throw new RateLimited('GitHub asked Commander to slow down.', wait, cost);
      }
      if (errors.some((error) => typeof error.message === 'string' && /timeout/i.test(error.message)))
        throw new GraphQLTimeout('GitHub took too long to answer.', cost);
      const tolerated = allowNotFound && errors.every((error) => error.type === 'NOT_FOUND');
      if (!tolerated) {
        const [first] = errors;
        const said = typeof first?.message === 'string' ? first.message : 'an error';
        throw new SourceUnavailable(`GitHub couldn’t answer Commander’s question (${said}).`, cost);
      }
    }
    const parsed = z.object({ data }).safeParse(body);
    if (!parsed.success)
      throw new SourceUnavailable('GitHub sent an answer Commander didn’t understand.', cost);
    return parsed.data.data;
  }

  return { rest, graphql, cost, limits };
}

export type GitHubClient = ReturnType<typeof connectGitHub>;
