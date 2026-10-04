import { z } from 'zod';
import {
  type AccessToken,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  SourceUnavailable,
  type SyncCost,
  WriteRejected,
} from '../source';

// One conversation with Linear's GraphQL API (a sync, or one Item's write): every request carries a
// token borrowed for it, adds to the cost Linear reports, and turns Linear's answers into the
// Source errors the sync engine understands. Rate limits drive back-off: RATELIMITED answers and
// 429s become RateLimited, and the next request is refused before it is sent when the X-RateLimit
// headers say it would run out.

export type LinearClientOptions = {
  apiUrl: () => string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  accessToken(): Promise<AccessToken>;
  signal: AbortSignal;
};

export type LinearQuery = <T>(
  document: string,
  operationName: string,
  variables: Record<string, unknown>,
  data: z.ZodType<T>,
  // For writes: Linear refusing the request itself (an unknown id, a value it won't take) is a
  // WriteRejected, which retrying won't fix, rather than a passing problem.
  options?: { write?: boolean },
) => Promise<T>;

type GraphQLError = {
  message?: unknown;
  extensions?: { code?: unknown; userPresentableMessage?: unknown };
};

const errorsOf = (body: unknown): GraphQLError[] => {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? (errors as GraphQLError[]) : [];
};

const headerNumber = (headers: Headers, name: string): number | null => {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// What Linear said about a refused request, in its own words where it has some for people.
function refusal(errors: GraphQLError[]): string {
  const [first] = errors;
  const said = first?.extensions?.userPresentableMessage ?? first?.message;
  return typeof said === 'string' && said.trim()
    ? `Linear refused the change: ${said}`
    : 'Linear refused the change.';
}

export function connectLinear({ apiUrl, fetch, now, accessToken, signal }: LinearClientOptions) {
  const cost: SyncCost = { requests: 0, complexity: null };
  // Set when the last answer said the next request would exceed a limit: when it resets.
  let throttledUntil: number | null = null;

  // How long to wait after a rate limit: Retry-After, or else when the exhausted limit resets.
  function waitFor(headers: Headers): number | null {
    const retryAfter = retryAfterMs(headers.get('retry-after'), now());
    if (retryAfter !== null) return retryAfter;
    const resets = (['requests', 'complexity'] as const)
      .filter((limit) => headerNumber(headers, `x-ratelimit-${limit}-remaining`) === 0)
      .map((limit) => headerNumber(headers, `x-ratelimit-${limit}-reset`))
      .filter((reset): reset is number => reset !== null);
    if (resets.length === 0) return null;
    return Math.max(0, Math.max(...resets) - now());
  }

  // When the limits left can't pay for another request like the last one, the reset time.
  function nextRequestThrottle(headers: Headers, lastComplexity: number | null): number | null {
    const requestsLeft = headerNumber(headers, 'x-ratelimit-requests-remaining');
    const complexityLeft = headerNumber(headers, 'x-ratelimit-complexity-remaining');
    if (requestsLeft !== null && requestsLeft < 1) {
      return headerNumber(headers, 'x-ratelimit-requests-reset') ?? now() + 60 * 60_000;
    }
    if (complexityLeft !== null && lastComplexity !== null && complexityLeft < lastComplexity) {
      return headerNumber(headers, 'x-ratelimit-complexity-reset') ?? now() + 60 * 60_000;
    }
    return null;
  }

  const query: LinearQuery = async (document, operationName, variables, data, options = {}) => {
    if (throttledUntil !== null) {
      throw new RateLimited(
        'Commander paused to stay within Linear’s rate limit.',
        Math.max(0, throttledUntil - now()),
        cost,
      );
    }
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetch(apiUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: token.kind === 'oauth' ? `Bearer ${token.token}` : token.token,
        },
        body: JSON.stringify({ query: document, operationName, variables }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach Linear.', cost);
    }
    cost.requests += 1;
    const { headers } = response;
    const complexity = headerNumber(headers, 'x-complexity');
    if (complexity !== null) cost.complexity = (cost.complexity ?? 0) + complexity;
    const body: unknown = await response.json().catch(() => null);
    const errors = errorsOf(body);
    const codes = errors.map((error) => String(error?.extensions?.code ?? ''));

    if (response.status === 429 || codes.includes('RATELIMITED')) {
      throw new RateLimited('Linear asked Commander to slow down.', waitFor(headers), cost);
    }
    if (response.status === 401 || codes.includes('AUTHENTICATION_ERROR')) {
      throw new SignInRefused('Linear refused this Account’s sign-in.');
    }
    // Linear answers a request it refuses with errors (and a 200 or 400), not a server failure.
    if (options.write && errors.length && response.status < 500) throw new WriteRejected(refusal(errors));
    if (!response.ok) {
      throw new SourceUnavailable(`Linear couldn’t answer just now (HTTP ${response.status}).`, cost);
    }
    const parsed = z.object({ data }).safeParse(body);
    if (!parsed.success) {
      throw new SourceUnavailable('Linear sent an answer Commander didn’t understand.', cost);
    }
    throttledUntil = nextRequestThrottle(headers, complexity);
    return parsed.data.data;
  };

  return { query, cost };
}
