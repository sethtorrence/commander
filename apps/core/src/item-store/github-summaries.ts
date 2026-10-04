// Ares's GitHub summaries in the Item store (#121): each is an Item of his (kind `github-summary`)
// with its detail kept here, the cadence and the day it was written for as columns, so a daily
// summary and a roll-up are each written once a day whatever restarts in between. When the User first
// opened one is kept beside it, not in the detail, so marking it seen records nothing in the activity
// log (it changes nothing the User wrote: it only stops the Update mentioning it).
import type { GitHubSummaryDetail, Item, SummaryCadence } from '@commander/domain';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ItemRow } from './rows';
import * as schema from './schema';

type Db = BetterSQLite3Database<typeof schema>;

export type GitHubSummaryStore = {
  // The live summaries, newest first (by when written), of these cadences when given.
  list(query?: { cadences?: readonly SummaryCadence[]; limit?: number }): Item[];
  // Whether a live summary of a cadence was written for a day.
  writtenFor(cadence: SummaryCadence, day: string): boolean;
  // Where the latest live daily summary's range ended, or null before the first.
  lastDailyTo(): number | null;
  // The User opened it: seen from now (the first time only). The summary, or null when it isn't one.
  markSeen(itemId: string): Item | null;
};

const CHUNK = 500;
const DEFAULT_LIMIT = 50;

export function githubSummariesIn(
  db: Db,
  { now, withDetails }: { now: () => number; withDetails: (rows: ItemRow[]) => Item[] },
) {
  const { githubSummaryDetails: table, items } = schema;

  function readDetails(itemIds: string[]): Map<string, GitHubSummaryDetail> {
    const details = new Map<string, GitHubSummaryDetail>();
    for (let start = 0; start < itemIds.length; start += CHUNK) {
      const ids = itemIds.slice(start, start + CHUNK);
      for (const row of db.select().from(table).where(inArray(table.itemId, ids)).all()) {
        details.set(row.itemId, {
          kind: 'github-summary',
          ...row.data,
          cadence: row.cadence,
          day: row.day,
          writtenAt: row.writtenAt,
          seenAt: row.seenAt,
        });
      }
    }
    return details;
  }

  // A summary's detail as it is saved; when it was seen stays as it is (only markSeen sets it).
  function writeDetail(itemId: string, detail: GitHubSummaryDetail | null) {
    if (!detail) {
      db.delete(table).where(eq(table.itemId, itemId)).run();
      return;
    }
    const { kind: _kind, cadence, day, writtenAt, seenAt, ...data } = detail;
    const values = { cadence, day, writtenAt, data };
    db.insert(table)
      .values({ itemId, ...values, seenAt })
      .onConflictDoUpdate({ target: table.itemId, set: values })
      .run();
  }

  const live = () => isNull(items.deletedAt);

  const store: GitHubSummaryStore = {
    list({ cadences, limit = DEFAULT_LIMIT } = {}) {
      const rows = db
        .select({ item: items })
        .from(table)
        .innerJoin(items, eq(items.id, table.itemId))
        .where(and(live(), cadences?.length ? inArray(table.cadence, [...cadences]) : undefined))
        // Written at once (a Monday's daily summary and roll-up), the later saved first.
        .orderBy(desc(table.writtenAt), sql`${table}.rowid desc`)
        .limit(limit)
        .all();
      return withDetails(rows.map((row) => row.item));
    },

    writtenFor(cadence, day) {
      return !!db
        .select({ itemId: table.itemId })
        .from(table)
        .innerJoin(items, eq(items.id, table.itemId))
        .where(and(live(), eq(table.cadence, cadence), eq(table.day, day)))
        .get();
    },

    lastDailyTo() {
      const [latest] = store.list({ cadences: ['daily'], limit: 1 });
      return latest?.detail?.kind === 'github-summary' ? latest.detail.range.to : null;
    },

    markSeen(itemId) {
      const row = db
        .select({ seenAt: table.seenAt })
        .from(table)
        .innerJoin(items, eq(items.id, table.itemId))
        .where(and(live(), eq(table.itemId, itemId)))
        .get();
      if (!row) return null;
      if (row.seenAt === null) db.update(table).set({ seenAt: now() }).where(eq(table.itemId, itemId)).run();
      const [item] = withDetails(db.select().from(items).where(eq(items.id, itemId)).all());
      return item ?? null;
    },
  };

  return { ...store, readDetails, writeDetail };
}
