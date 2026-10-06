// Refusals (#201), kept by the Item store. Ares sends no model an Item holding one of the User's keys
// or sign-in tokens (the prompt builder refuses it, agent/prompt.ts), and the User can see that he
// didn't: a refusal activity entry, by Ares, which the Update counts, and a small note on the Item
// while its words stay as they were. Neither ever holds the secret, nor the Item's own words: the
// entry says only what was skipped and why (refusalWhy), and the row keeps a fingerprint of the words.
//
// - `record` is a job's refusal: each Item it names gets an entry once for the words it has now (a
//   job asking again about the same words adds nothing), and its note.
// - `check` runs on every Item saved from its Source: once its words change, the note goes (the next
//   job to read it refuses it again, if the secret is still there).
import { type ActivityEntry, type Item, refusalWhy } from '@commander/domain';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fingerprint, wordsOf } from './injection-warnings';
import * as schema from './schema';

export type Skipped = { itemId: string; entryId: number; at: number; job: string | null };

export type RefusalStore = {
  // Ares sent these Items to no model, for the job named: each gets a refusal entry (unless one stands
  // for the words it has now) and its note. Returns the new entries.
  record(itemIds: readonly string[], job: string | null): ActivityEntry[];
  // The refusal entries recorded after an activity entry (all of them, from null), oldest first: what
  // the Update counts.
  since(after: number | null): ActivityEntry[];
  // The Items whose note stands, newest first.
  recent(limit?: number): Skipped[];
};

type Refusal = { itemId: string; why: string; after: { job: string | null } };

export type Refusals = RefusalStore & {
  // Checks an Item just saved from its Source. `extra`: text it holds outside its detail (an email's body).
  check(item: Item, extra?: string): void;
  // When each of these Items was skipped (the notes standing now).
  standing(itemIds: readonly string[]): Map<string, number>;
};

const MAX_JOB = 120;

export function refusalsIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    readItem,
    extraOf = () => '',
    record,
    toEntry,
  }: {
    now: () => number;
    readItem: (itemId: string) => Item | undefined;
    // What else of an Item is its words (an email's body).
    extraOf?: (item: Item) => string;
    // Logs a refusal entry, by Ares.
    record: (refusal: Refusal, at: number) => ActivityEntry;
    toEntry: (row: typeof schema.activity.$inferSelect) => ActivityEntry;
  },
): Refusals {
  const { refusals, activity } = schema;
  const hashOf = (item: Item, extra = extraOf(item)) =>
    fingerprint(extra ? `${wordsOf(item)}\n${extra}` : wordsOf(item));
  const rowOf = (itemId: string) => db.select().from(refusals).where(eq(refusals.itemId, itemId)).get();

  return {
    record(itemIds, job) {
      const entries: ActivityEntry[] = [];
      const named = job ? job.slice(0, MAX_JOB) : null;
      for (const itemId of new Set(itemIds)) {
        const item = readItem(itemId);
        if (!item) continue;
        const contentHash = hashOf(item);
        if (rowOf(itemId)?.contentHash === contentHash) continue;
        const at = now();
        const entry = record({ itemId, why: refusalWhy(item), after: { job: named } }, at);
        const values = { itemId, at, entryId: entry.id, job: named, contentHash };
        db.insert(refusals).values(values).onConflictDoUpdate({ target: refusals.itemId, set: values }).run();
        entries.push(entry);
      }
      return entries;
    },

    since(after) {
      return db
        .select()
        .from(activity)
        .where(and(eq(activity.action, 'refusal'), after === null ? undefined : gt(activity.id, after)))
        .orderBy(asc(activity.id))
        .all()
        .map(toEntry);
    },

    recent(limit = 50) {
      return db
        .select({ itemId: refusals.itemId, entryId: refusals.entryId, at: refusals.at, job: refusals.job })
        .from(refusals)
        .orderBy(desc(refusals.at), desc(refusals.entryId))
        .limit(limit)
        .all();
    },

    check(item, extra) {
      const row = rowOf(item.id);
      if (row && row.contentHash !== hashOf(item, extra)) {
        db.delete(refusals).where(eq(refusals.itemId, item.id)).run();
      }
    },

    standing(itemIds) {
      const standing = new Map<string, number>();
      const ids = [...new Set(itemIds)];
      // In batches, well under SQLite's limit on bound values.
      for (let at = 0; at < ids.length; at += 500) {
        const rows = db
          .select({ itemId: refusals.itemId, at: refusals.at })
          .from(refusals)
          .where(inArray(refusals.itemId, ids.slice(at, at + 500)))
          .all();
        for (const row of rows) standing.set(row.itemId, row.at);
      }
      return standing;
    },
  };
}
