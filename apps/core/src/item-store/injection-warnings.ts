// Steering warnings (#69), kept by the Item store: an outside Item holding instructions aimed at
// Ares gets the warning mark (shown wherever it is) and an injection-warning activity entry, by
// Ares, which the Update counts. Nothing else happens: no pop-up, and nothing Ares does changes.
//
// - `check` runs on every Item saved from a Source (saveFromSource), with the pattern check
//   (safety/steering.ts). Instructions found that weren't found before record an entry; when none
//   are left, the mark goes.
// - `flag` is a job's steering flag: the model said an outside Item it was shown tries to steer
//   Ares. It marks the Item once, and only an untrusted one (a model can't mark the User's words);
//   the mark goes when the Item's words change and the patterns find nothing.
import { createHash } from 'node:crypto';
import { type ActivityEntry, type CausedBy, type Item, injectionWarningText } from '@commander/domain';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { findSteering } from '../safety/steering';
import { trustOf } from '../safety/trust';
import * as schema from './schema';

export type InjectionWarningStore = {
  // A job's steering flag on an outside Item: marks it and returns the entry, or null when it was
  // marked already, is the User's own, or doesn't exist.
  flag(itemId: string): ActivityEntry | null;
  // The injection-warning entries recorded after an activity entry (all of them, from null), oldest
  // first: what the Update counts.
  since(after: number | null): ActivityEntry[];
};

type Warning = { itemId: string; why: string; causedBy: CausedBy | null; after: unknown };

export type InjectionWarnings = InjectionWarningStore & {
  // Checks an Item just saved from its Source. `causedBy` is the save's activity entry; `extra`, text
  // it holds outside its detail (an email's body).
  check(item: Item, at: number, causedBy: number | null, extra?: string): void;
  // When each of these Items was marked.
  marked(itemIds: readonly string[]): Map<string, number>;
};

// Every word an Item holds: its title and each piece of text in its detail.
function wordsOf(item: Item): string {
  const words = [item.title];
  const collect = (value: unknown) => {
    if (typeof value === 'string') words.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(item.detail);
  return words.join('\n');
}

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

export function injectionWarningsIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    readItem,
    record,
    toEntry,
  }: {
    now: () => number;
    readItem: (itemId: string) => Item | undefined;
    // Logs an injection-warning entry, by Ares.
    record: (warning: Warning, at: number) => ActivityEntry;
    toEntry: (row: typeof schema.activity.$inferSelect) => ActivityEntry;
  },
): InjectionWarnings {
  const { injectionWarnings, activity } = schema;
  const rowOf = (itemId: string) =>
    db.select().from(injectionWarnings).where(eq(injectionWarnings.itemId, itemId)).get();

  function warn(item: Item, found: string[], causedBy: number | null, at: number): ActivityEntry {
    return record(
      {
        itemId: item.id,
        why: injectionWarningText(item.kind),
        causedBy: causedBy ? { entryId: causedBy } : null,
        after: { found },
      },
      at,
    );
  }

  return {
    check(item, at, causedBy, extra) {
      const words = extra ? `${wordsOf(item)}\n${extra}` : wordsOf(item);
      const found = findSteering(words);
      const row = rowOf(item.id);
      if (!found.length) {
        if (row && (row.via === 'pattern' || row.contentHash !== fingerprint(words))) {
          db.delete(injectionWarnings).where(eq(injectionWarnings.itemId, item.id)).run();
        }
        return;
      }
      const fresh = found.filter((snippet) => !row?.found.includes(snippet));
      const entry = !row || fresh.length ? warn(item, fresh.length ? fresh : found, causedBy, at) : null;
      const values = {
        itemId: item.id,
        at: row?.at ?? at,
        entryId: entry?.id ?? (row?.entryId as number),
        via: 'pattern' as const,
        found,
        contentHash: fingerprint(words),
      };
      db.insert(injectionWarnings)
        .values(values)
        .onConflictDoUpdate({ target: injectionWarnings.itemId, set: values })
        .run();
    },

    flag(itemId) {
      const item = readItem(itemId);
      if (!item || trustOf(item) === 'trusted' || rowOf(itemId)) return null;
      const at = now();
      const entry = warn(item, [], null, at);
      db.insert(injectionWarnings)
        .values({
          itemId,
          at,
          entryId: entry.id,
          via: 'ares',
          found: [],
          contentHash: fingerprint(wordsOf(item)),
        })
        .run();
      return entry;
    },

    since(after) {
      return db
        .select()
        .from(activity)
        .where(
          and(eq(activity.action, 'injection-warning'), after === null ? undefined : gt(activity.id, after)),
        )
        .orderBy(asc(activity.id))
        .all()
        .map(toEntry);
    },

    marked(itemIds) {
      const marked = new Map<string, number>();
      const ids = [...new Set(itemIds)];
      // In batches, well under SQLite's limit on bound values.
      for (let at = 0; at < ids.length; at += 500) {
        const rows = db
          .select({ itemId: injectionWarnings.itemId, at: injectionWarnings.at })
          .from(injectionWarnings)
          .where(inArray(injectionWarnings.itemId, ids.slice(at, at + 500)))
          .all();
        for (const row of rows) marked.set(row.itemId, row.at);
      }
      return marked;
    },
  };
}
