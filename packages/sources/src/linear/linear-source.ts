import type { LinearComment, LinearIssueDetail, LinearUser, SourceItem } from '@commander/domain';
import { z } from 'zod';
import {
  type AccessToken,
  type Cadence,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  type SyncCost,
  type SyncRequest,
} from '../source';
import { CHANGED_COMMENTS, ISSUE_COMMENTS, ISSUES } from './graphql';

// Linear's read side: polls Linear's GraphQL API over fetch (not @linear/sdk, which ships breaking
// majors weekly and has no token refresh) and turns issues into `linear-issue` Items.
//
// - First sync: every issue the Account can see that is open, plus those completed or cancelled in
//   the last 30 days.
// - After that: issues updated since the cursor (archived and deleted ones too, which become
//   tombstones), plus issues whose comments changed, with cursor pagination throughout.
// - Linear's rate limits drive back-off: RATELIMITED answers and 429s become RateLimited, and a
//   sync stops early, before the next request, when the X-RateLimit headers say it would run out.

export const LINEAR_CADENCE: Cadence = { defaultMinutes: 15, choices: [15, 30, 60] };

export type LinearSourceOptions = {
  // Linear's GraphQL endpoint; read per sync, so the end-to-end tests can point it at a fake.
  apiUrl: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const PAGE_SIZE = 50;
const FIRST_SYNC_DAYS = 30;
// With nothing to go on (an empty workspace), the first cursor starts a little before now, so a
// clock running ahead of Linear's misses nothing.
const CLOCK_MARGIN_MS = 10 * 60_000;

export type LinearCursor = { issuesUpdatedAfter: string; commentsUpdatedAfter: string };
const linearCursor = z.object({
  issuesUpdatedAfter: z.iso.datetime(),
  commentsUpdatedAfter: z.iso.datetime(),
});

// What Linear answers, validated before anything is translated.
const user = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  email: z.string().nullish(),
});
const comment = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  user: user.nullish(),
});
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });
const comments = z.object({ nodes: z.array(comment), pageInfo });
const issue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullish(),
  priority: z.number(),
  estimate: z.number().nullish(),
  dueDate: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  canceledAt: z.string().nullish(),
  archivedAt: z.string().nullish(),
  trashed: z.boolean().nullish(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  state: z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() }),
  assignee: user.nullish(),
  creator: user.nullish(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })) }),
  cycle: z
    .object({
      id: z.string(),
      number: z.number(),
      name: z.string().nullish(),
      startsAt: z.string(),
      endsAt: z.string(),
    })
    .nullish(),
  project: z.object({ id: z.string(), name: z.string() }).nullish(),
  comments,
});
type Issue = z.infer<typeof issue>;
const issuesData = z.object({ issues: z.object({ nodes: z.array(issue), pageInfo }) });
const issueCommentsData = z.object({ issue: z.object({ comments }) });
const changedCommentsData = z.object({
  comments: z.object({
    nodes: z.array(z.object({ updatedAt: z.string(), issue: z.object({ id: z.string() }).nullish() })),
    pageInfo,
  }),
});

const errorCodes = (body: unknown): string[] => {
  const errors = (body as { errors?: { extensions?: { code?: unknown } }[] } | null)?.errors;
  return Array.isArray(errors) ? errors.map((error) => String(error?.extensions?.code ?? '')) : [];
};

const headerNumber = (headers: Headers, name: string): number | null => {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const time = (iso: string) => Date.parse(iso);
const optionalTime = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
const later = (a: string | null, b: string) => (a === null || time(b) > time(a) ? b : a);

function toUser(from: z.infer<typeof user>): LinearUser {
  return { id: from.id, name: from.name, displayName: from.displayName, email: from.email ?? null };
}

function toComment(from: z.infer<typeof comment>): LinearComment {
  return {
    id: from.id,
    author: from.user ? toUser(from.user) : null,
    body: from.body,
    createdAt: time(from.createdAt),
    updatedAt: time(from.updatedAt),
  };
}

// People involved, as handles: each Linear user, and their email where Linear gives it.
function handles(...users: (z.infer<typeof user> | null | undefined)[]): string[] {
  const all = users.flatMap((who) => (who ? [`linear:${who.id}`, ...(who.email ? [who.email] : [])] : []));
  return [...new Set(all)];
}

function toItem(from: Issue, allComments: z.infer<typeof comment>[]): SourceItem {
  const detail: LinearIssueDetail = {
    kind: 'linear-issue',
    identifier: from.identifier,
    url: from.url,
    team: from.team,
    state: from.state,
    priority: from.priority,
    assignee: from.assignee ? toUser(from.assignee) : null,
    creator: from.creator ? toUser(from.creator) : null,
    labels: [...from.labels.nodes].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    cycle: from.cycle
      ? {
          id: from.cycle.id,
          number: from.cycle.number,
          name: from.cycle.name ?? null,
          startsAt: time(from.cycle.startsAt),
          endsAt: time(from.cycle.endsAt),
        }
      : null,
    linearProject: from.project ?? null,
    dueDate: from.dueDate ?? null,
    estimate: from.estimate ?? null,
    description: from.description ?? null,
    comments: allComments
      .map(toComment)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    createdAt: time(from.createdAt),
    updatedAt: time(from.updatedAt),
    startedAt: optionalTime(from.startedAt),
    completedAt: optionalTime(from.completedAt),
    canceledAt: optionalTime(from.canceledAt),
  };
  const done = from.state.type === 'completed' || from.state.type === 'canceled';
  return {
    externalId: from.id,
    kind: 'linear-issue',
    title: from.title,
    people: handles(from.assignee, from.creator),
    status: done ? 'done' : 'open',
    detail,
  };
}

export function createLinearSource({
  apiUrl,
  fetch = globalThis.fetch,
  now = Date.now,
}: LinearSourceOptions): SourceAdapter {
  return {
    source: 'linear',
    cadence: LINEAR_CADENCE,

    async sync(request: SyncRequest) {
      const cost: SyncCost = { requests: 0, complexity: null };
      // Set when the last answer said the next request would exceed a limit: when it resets.
      let throttledUntil: number | null = null;

      async function query<T>(
        document: string,
        operationName: string,
        variables: Record<string, unknown>,
        data: z.ZodType<T>,
      ): Promise<T> {
        if (throttledUntil !== null) {
          throw new RateLimited(
            'Commander paused to stay within Linear’s rate limit.',
            Math.max(0, throttledUntil - now()),
            cost,
          );
        }
        const token: AccessToken = await request.accessToken();
        let response: Response;
        try {
          response = await fetch(apiUrl(), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: token.kind === 'oauth' ? `Bearer ${token.token}` : token.token,
            },
            body: JSON.stringify({ query: document, operationName, variables }),
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal.aborted) throw error;
          throw new SourceUnavailable('Commander couldn’t reach Linear.', cost);
        }
        cost.requests += 1;
        const { headers } = response;
        const complexity = headerNumber(headers, 'x-complexity');
        if (complexity !== null) cost.complexity = (cost.complexity ?? 0) + complexity;
        const body: unknown = await response.json().catch(() => null);
        const codes = errorCodes(body);

        if (response.status === 429 || codes.includes('RATELIMITED')) {
          throw new RateLimited('Linear asked Commander to slow down.', waitFor(headers), cost);
        }
        if (response.status === 401 || codes.includes('AUTHENTICATION_ERROR')) {
          throw new SignInRefused('Linear refused this Account’s sign-in.');
        }
        if (!response.ok) {
          throw new SourceUnavailable(`Linear couldn’t answer just now (HTTP ${response.status}).`, cost);
        }
        const parsed = z.object({ data }).safeParse(body);
        if (!parsed.success) {
          throw new SourceUnavailable('Linear sent an answer Commander didn’t understand.', cost);
        }
        throttledUntil = nextRequestThrottle(headers, complexity);
        return parsed.data.data;
      }

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

      async function remainingComments(from: Issue): Promise<z.infer<typeof comment>[]> {
        const all = [...from.comments.nodes];
        let page = from.comments.pageInfo;
        while (page.hasNextPage) {
          const data = await query(
            ISSUE_COMMENTS,
            'CommanderIssueComments',
            { id: from.id, after: page.endCursor ?? null },
            issueCommentsData,
          );
          all.push(...data.issue.comments.nodes);
          page = data.issue.comments.pageInfo;
        }
        return all;
      }

      // Fetches every page of issues matching the filter, hands each over, and returns what it saw.
      async function issues(filter: unknown, includeArchived: boolean) {
        const seen = new Set<string>();
        let newest: string | null = null;
        let newestComment: string | null = null;
        let after: string | null = null;
        do {
          const data: z.infer<typeof issuesData> = await query(
            ISSUES,
            'CommanderIssues',
            { filter, first: PAGE_SIZE, after, includeArchived },
            issuesData,
          );
          const page = { items: [] as SourceItem[], deleted: [] as string[] };
          for (const node of data.issues.nodes) {
            seen.add(node.id);
            newest = later(newest, node.updatedAt);
            if (node.archivedAt || node.trashed) {
              page.deleted.push(node.id);
              continue;
            }
            const all = await remainingComments(node);
            for (const each of all) newestComment = later(newestComment, each.updatedAt);
            page.items.push(toItem(node, all));
          }
          request.save(page);
          after = data.issues.pageInfo.hasNextPage ? (data.issues.pageInfo.endCursor ?? null) : null;
        } while (after !== null);
        return { seen, newest, newestComment };
      }

      const previous = linearCursor.safeParse(request.cursor);
      if (!previous.success) {
        const since = new Date(now() - FIRST_SYNC_DAYS * 24 * 60 * 60_000).toISOString();
        const window = {
          or: [
            { state: { type: { nin: ['completed', 'canceled'] } } },
            { completedAt: { gt: since } },
            { canceledAt: { gt: since } },
          ],
        };
        const { newest, newestComment } = await issues(window, false);
        const start = newest ?? new Date(now() - CLOCK_MARGIN_MS).toISOString();
        const cursor: LinearCursor = {
          issuesUpdatedAfter: start,
          commentsUpdatedAfter: newestComment === null ? start : later(start, newestComment),
        };
        return { cursor, cost };
      }

      const { issuesUpdatedAfter, commentsUpdatedAfter } = previous.data;
      const changed = await issues({ updatedAt: { gt: issuesUpdatedAfter } }, true);

      // Issues whose comments changed, that the first query didn't already bring.
      const commented = new Set<string>();
      let newestComment: string | null = null;
      let after: string | null = null;
      do {
        const data: z.infer<typeof changedCommentsData> = await query(
          CHANGED_COMMENTS,
          'CommanderChangedComments',
          { filter: { updatedAt: { gt: commentsUpdatedAfter } }, first: PAGE_SIZE, after },
          changedCommentsData,
        );
        for (const node of data.comments.nodes) {
          newestComment = later(newestComment, node.updatedAt);
          if (node.issue && !changed.seen.has(node.issue.id)) commented.add(node.issue.id);
        }
        after = data.comments.pageInfo.hasNextPage ? (data.comments.pageInfo.endCursor ?? null) : null;
      } while (after !== null);
      const ids = [...commented];
      for (let i = 0; i < ids.length; i += PAGE_SIZE) {
        await issues({ id: { in: ids.slice(i, i + PAGE_SIZE) } }, true);
      }

      const cursor: LinearCursor = {
        issuesUpdatedAfter:
          changed.newest === null ? issuesUpdatedAfter : later(issuesUpdatedAfter, changed.newest),
        commentsUpdatedAfter:
          newestComment === null ? commentsUpdatedAfter : later(commentsUpdatedAfter, newestComment),
      };
      return { cursor, cost };
    },
  };
}
