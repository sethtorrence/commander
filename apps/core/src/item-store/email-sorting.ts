// Ares's sorting of email into Buckets (#141), the Item store's side: which mail is his to look at
// (the scope), his suggested Buckets waiting on emails (the dashed Bucket), and the User's answers to
// his sorting.
//
// - The scope: the latest message of each thread in the inbox (never Trash) sent since a given time.
//   A thread's Bucket is its latest message's, so that is the one message he sorts; newest first.
// - A pending "Sort into Buckets" suggestion decorates its email as it is read: `bucketSuggestion`.
// - Whenever the User moves an email Ares sorted, or one with his suggestion waiting, the answer is
//   recorded beside the change, as filing's are (filing-feedback.ts): a `confirmation` when they kept
//   his Bucket, a `correction` otherwise (another Bucket, or Unsorted). Before is his Bucket and after
//   the User's, as `{ bucket }`. They are never undone: they are what he learns from (examples in
//   Memory, and five of one kind suggest a Bucket Rule).
import {
  type ActivityEntry,
  type Actor,
  BUCKET_FIELD,
  type BucketFeedback,
  type BucketSuggestion,
  type CausedBy,
  type EmailBucket,
  type EmailDetail,
  type Item,
  type ItemState,
  SORT_DAYS,
  SORT_INTO_BUCKETS,
  type SortingProgress,
} from '@commander/domain';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ItemRow } from './rows';
import * as schema from './schema';

type NewFeedback = {
  by: Actor;
  action: 'correction' | 'confirmation';
  itemId: string;
  causedBy: CausedBy | null;
  before: { bucket: EmailBucket };
  after: { bucket: EmailBucket | null };
};

export type EmailSortingStore = {
  // The latest message of each thread in the inbox (not in Trash) whose latest message was sent at
  // or after `since`, newest first.
  scope(since: number): Item[];
  // Every correction and confirmation of his sorting, newest first.
  feedback(): BucketFeedback[];
  // How far he has got with the mail in scope, for the Email status line: the threads he may sort
  // (in the inbox, from the last SORT_DAYS days, from Accounts he may read) that have a Bucket, his
  // suggestion waiting, or that he has looked at, of all of them. Nothing while sorting is off.
  progress(): SortingProgress;
  // His suggestions that no longer stand: their email was sorted by the User or a Rule since, is
  // gone, or is no longer its thread's latest message (a reply arrived). A few queries, whatever the
  // number waiting: the Agent asks after every change the User makes.
  staleSuggestions(): number[];
};

const bucketOfState = (state: ItemState): EmailBucket | null =>
  state.detail?.kind === 'email' ? ((state.detail as EmailDetail).bucket ?? null) : null;

export function emailSortingIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    withDetails,
    log,
    now,
    sorting,
  }: {
    withDetails: (rows: ItemRow[]) => Item[];
    log: (entry: NewFeedback, at: number) => ActivityEntry;
    now: () => number;
    // Where Ares's sorting stands, for its progress: whether it runs at all, and whether he may read
    // an Account's mail.
    sorting: {
      on(): boolean;
      mayRead(source: string | null, account: string | null): boolean;
    };
  },
) {
  const { proposals, activity, items, emailDetails, agentSeen } = schema;

  const bucketOfSteps = (steps: unknown): string | null => {
    const step = (steps as { type: string; fields?: Record<string, unknown> }[])[0];
    const bucket = step?.type === 'edit-fields' ? (step.fields?.[BUCKET_FIELD] as EmailBucket | null) : null;
    return bucket?.bucketId ?? null;
  };

  // The pending sorting suggestions on these emails, by email.
  function suggestions(itemIds: readonly string[]): Map<string, BucketSuggestion> {
    const found = new Map<string, BucketSuggestion>();
    for (let i = 0; i < itemIds.length; i += 500) {
      const rows = db
        .select({ id: proposals.id, itemId: proposals.itemId, steps: proposals.itemActions })
        .from(proposals)
        .where(
          and(
            eq(proposals.action, SORT_INTO_BUCKETS),
            eq(proposals.status, 'pending'),
            inArray(proposals.itemId, itemIds.slice(i, i + 500)),
          ),
        )
        .orderBy(desc(proposals.id))
        .all();
      for (const row of rows) {
        const bucketId = bucketOfSteps(row.steps);
        if (bucketId && !found.has(row.itemId)) found.set(row.itemId, { proposalId: row.id, bucketId });
      }
    }
    return found;
  }

  // What Ares said about an email the User is sorting now: his waiting suggestion, else his own sort.
  function aresSaid(itemId: string, before: EmailBucket | null): string | null {
    const waiting = suggestions([itemId]).get(itemId);
    if (waiting) return waiting.bucketId;
    return before?.sortedBy === 'ares' ? before.bucketId : null;
  }

  // Records the User's answer to Ares's sorting, if this change is one.
  function answer(item: Item, before: ItemState, after: ItemState, entry: ActivityEntry, at: number) {
    if (item.kind !== 'email' || entry.by.kind !== 'user') return;
    const was = bucketOfState(before);
    const now = bucketOfState(after);
    if (was?.sortedBy === 'user') return;
    if (was?.bucketId === now?.bucketId && was?.sortedBy === now?.sortedBy) return;
    const suggested = aresSaid(item.id, was);
    if (!suggested) return;
    const chosen = now?.bucketId ?? null;
    log(
      {
        by: entry.by,
        action: chosen === suggested ? 'confirmation' : 'correction',
        itemId: item.id,
        causedBy: { entryId: entry.id },
        before: { bucket: { bucketId: suggested, sortedBy: 'ares' } },
        after: { bucket: now },
      },
      at,
    );
  }

  // Each inbox thread's latest message sent since then, newest first: its id, Source and Account.
  function latestInScope(since: number): { id: string; source: string | null; account: string | null }[] {
    const notTrashed = sql`not ${emailDetails.inTrash}`;
    return db
      .select({
        latest: sql<string>`max(printf('%015d', ${emailDetails.sentAt}) || ${items.id})`,
        latestAt: sql<number>`max(${emailDetails.sentAt})`,
        inbox: sql<number>`max(${emailDetails.inInbox} and ${notTrashed})`,
        source: items.source,
        account: items.account,
      })
      .from(emailDetails)
      .innerJoin(items, eq(items.id, emailDetails.itemId))
      .where(and(isNull(items.deletedAt), eq(items.kind, 'email'), eq(emailDetails.draft, false)))
      .groupBy(items.account, emailDetails.threadKey)
      .all()
      .filter((row) => Number(row.latestAt) >= since && !!row.inbox)
      .sort((a, b) => Number(b.latestAt) - Number(a.latestAt) || b.latest.localeCompare(a.latest))
      .map((row) => ({ id: row.latest.slice(15), source: row.source, account: row.account }));
  }

  function scope(since: number): Item[] {
    // The latest message's id, after its zero-padded time.
    const ids = latestInScope(since).map((row) => row.id);
    const found = new Map<string, Item>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = db
        .select()
        .from(items)
        .where(inArray(items.id, ids.slice(i, i + 500)))
        .all();
      for (const item of withDetails(chunk)) found.set(item.id, item);
    }
    return ids.flatMap((id) => found.get(id) ?? []);
  }

  const DAY_MS = 24 * 60 * 60_000;

  function staleSuggestions(): number[] {
    const pending = db
      .select({ id: proposals.id, itemId: proposals.itemId })
      .from(proposals)
      .where(and(eq(proposals.action, SORT_INTO_BUCKETS), eq(proposals.status, 'pending')))
      .all();
    if (!pending.length) return [];
    const ids = [...new Set(pending.map((row) => row.itemId))];
    // Each email as it is: live or not, its Bucket, and its thread.
    const emails = new Map<
      string,
      { live: boolean; account: string | null; threadKey: string; sortedBy: string | undefined }
    >();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = db
        .select({
          itemId: emailDetails.itemId,
          deletedAt: items.deletedAt,
          account: items.account,
          threadKey: emailDetails.threadKey,
          data: emailDetails.data,
        })
        .from(emailDetails)
        .innerJoin(items, eq(items.id, emailDetails.itemId))
        .where(inArray(emailDetails.itemId, ids.slice(i, i + 500)))
        .all();
      for (const row of rows)
        emails.set(row.itemId, {
          live: row.deletedAt === null,
          account: row.account,
          threadKey: row.threadKey,
          sortedBy: row.data.bucket?.sortedBy,
        });
    }
    // The latest message of each of their threads.
    const threadKeys = [...new Set([...emails.values()].map((email) => email.threadKey))];
    const latest = new Set<string>();
    for (let i = 0; i < threadKeys.length; i += 500) {
      const rows = db
        .select({ latest: sql<string>`max(printf('%015d', ${emailDetails.sentAt}) || ${items.id})` })
        .from(emailDetails)
        .innerJoin(items, eq(items.id, emailDetails.itemId))
        .where(and(isNull(items.deletedAt), inArray(emailDetails.threadKey, threadKeys.slice(i, i + 500))))
        .groupBy(items.account, emailDetails.threadKey)
        .all();
      for (const row of rows) latest.add(row.latest.slice(15));
    }
    return pending
      .filter(({ itemId }) => {
        const email = emails.get(itemId);
        if (!email?.live || !email.account) return true;
        if (email.sortedBy === 'user' || email.sortedBy === 'rule') return true;
        return !latest.has(itemId);
      })
      .map((row) => row.id);
  }

  const store: EmailSortingStore = {
    scope,
    staleSuggestions,
    progress() {
      if (!sorting.on()) return { done: 0, total: 0 };
      // Read in bulk, never Item by Item: the status line asks every few seconds while he sorts.
      const ids = latestInScope(now() - SORT_DAYS * DAY_MS)
        .filter((row) => sorting.mayRead(row.source, row.account))
        .map((row) => row.id);
      const done = new Set(suggestions(ids).keys());
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const sorted = db
          .select({ itemId: emailDetails.itemId })
          .from(emailDetails)
          .where(
            and(
              inArray(emailDetails.itemId, chunk),
              sql`json_type(${emailDetails.data}, '$.bucket') = 'object'`,
            ),
          )
          .all();
        for (const row of sorted) done.add(row.itemId);
        const looked = db
          .selectDistinct({ itemId: agentSeen.itemId })
          .from(agentSeen)
          .where(and(eq(agentSeen.job, SORT_INTO_BUCKETS), inArray(agentSeen.itemId, chunk)))
          .all();
        for (const row of looked) done.add(row.itemId);
      }
      return { done: done.size, total: ids.length };
    },
    feedback() {
      return db
        .select()
        .from(activity)
        .where(inArray(activity.action, ['correction', 'confirmation']))
        .orderBy(desc(activity.id))
        .all()
        .flatMap((row): BucketFeedback[] => {
          const suggested = (row.before as { bucket?: EmailBucket } | null)?.bucket?.bucketId;
          if (!suggested) return [];
          return [
            {
              entryId: row.id,
              at: row.at,
              kind: row.action === 'confirmation' ? 'confirmation' : 'correction',
              itemId: row.itemId,
              suggested,
              chosen: (row.after as { bucket?: EmailBucket | null } | null)?.bucket?.bucketId ?? null,
            },
          ];
        });
    },
  };

  return { suggestions, answer, store };
}
