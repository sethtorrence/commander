import type { SourceItem } from '@commander/domain';
import { z } from 'zod';
import type { Cadence, SourceAdapter, SyncRequest, WriteRequest } from '../source';
import { connectLinear } from './client';
import { CHANGED_COMMENTS, ISSUES } from './graphql';
import { allComments, changedCommentsData, issuesData, later, toItem } from './shapes';
import { fetchCatalog, writeIssue } from './write';

// Linear as a Source: polls Linear's GraphQL API over fetch (not @linear/sdk, which ships breaking
// majors weekly and has no token refresh), turns issues into `linear-issue` Items, and writes the
// User's changes back (Two-way sync, see write.ts).
//
// - First sync: every issue the Account can see that is open, plus those completed or cancelled in
//   the last 30 days.
// - After that: issues updated since the cursor (archived and deleted ones too, which become
//   tombstones), plus issues whose comments changed, with cursor pagination throughout.
// - Each sync also fetches what the detail pane's pickers offer (each team's states, members,
//   labels, cycles and Linear projects); a sync whose issues arrived never fails for want of it.
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

export function createLinearSource({
  apiUrl,
  fetch = globalThis.fetch,
  now = Date.now,
}: LinearSourceOptions): SourceAdapter {
  return {
    source: 'linear',
    cadence: LINEAR_CADENCE,

    async sync(request: SyncRequest) {
      const { query, cost } = connectLinear({
        apiUrl,
        fetch,
        now,
        accessToken: request.accessToken,
        signal: request.signal,
      });

      // What the pickers offer, after the issues: kept from the last sync if it can't be fetched now.
      async function catalog() {
        if (!request.saveCatalog) return;
        try {
          request.saveCatalog(await fetchCatalog(query, now()));
        } catch (error) {
          if (request.signal.aborted) throw error;
        }
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
            const all = await allComments(query, node);
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
        await catalog();
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
      await catalog();
      return { cursor, cost };
    },

    async write(request: WriteRequest) {
      const { query, cost } = connectLinear({
        apiUrl,
        fetch,
        now,
        accessToken: request.accessToken,
        signal: request.signal,
      });
      return { ...(await writeIssue(query, request)), cost };
    },
  };
}
