// Steering warnings (#69), kept by the Item store: an outside Item holding instructions aimed at
// Ares gets the warning mark (shown wherever it is) and an injection-warning activity entry, by
// Ares, which the Update counts. Nothing else happens: no pop-up, and nothing Ares does changes.
//
// - `check` runs on every Item saved from a Source (saveFromSource), with the pattern check
//   (safety/steering.ts). Instructions found that weren't found before record an entry; when none
//   are left, the mark goes.
// - `flag` is a job's steering flag: the model said an outside Item it was shown tries to steer
//   Ares, quoting the passage it took as an instruction (#186). It marks the Item once, only an
//   untrusted one (a model can't mark the User's words), and only when the quote is found word for
//   word in the Item's own text: a flag that quotes nothing it can show marks nothing. The mark goes
//   when the Item's words change and the patterns find nothing.
// - `clear` is the User's Not an instruction (#186): the mark goes, logged as their correction, and
//   stays gone while the Item's words stay the same (neither the patterns nor a flag put it back).
// - Marks from flags made before they had to quote (found nothing, quoted nothing) are dropped when
//   the store opens: they don't meet the rule.
import { createHash } from 'node:crypto';
import {
  type ActionContext,
  type ActivityEntry,
  type CausedBy,
  type Item,
  injectionWarningText,
} from '@commander/domain';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { findSteering, passageOf, quotedIn } from '../safety/steering';
import { trustOf } from '../safety/trust';
import * as schema from './schema';

export type InjectionWarningStore = {
  // A job's steering flag on an outside Item, with the passage it took as an instruction: marks it
  // and returns the entry, or null when the quote isn't in the Item's text, it was marked already
  // (or cleared by the User for these words), is the User's own, or doesn't exist.
  flag(itemId: string, quote: string): ActivityEntry | null;
  // The injection-warning entries recorded after an activity entry (all of them, from null), oldest
  // first: what the Update counts.
  since(after: number | null): ActivityEntry[];
  // The mark standing on an Item: what in it read like an instruction, as it is written there
  // (null when nothing can be quoted), or null when it isn't marked.
  warning(itemId: string): { quote: string | null } | null;
  // Not an instruction: the User clears the mark. Returns their correction.
  clear(itemId: string, context: ActionContext): ActivityEntry;
};

type Warning = { itemId: string; why: string; causedBy: CausedBy | null; after: unknown };
type Correction = { itemId: string; context: ActionContext; before: unknown };

export type InjectionWarnings = InjectionWarningStore & {
  // Checks an Item just saved from its Source. `causedBy` is the save's activity entry; `extra`, text
  // it holds outside its detail (an email's body).
  check(item: Item, at: number, causedBy: number | null, extra?: string): void;
  // When each of these Items was marked (the marks standing now).
  marked(itemIds: readonly string[]): Map<string, number>;
};

/** Thrown when there is no mark to clear. */
export class InjectionWarningError extends Error {
  override name = 'InjectionWarningError';
}

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
const MAX_QUOTE = 500;
export const NOT_AN_INSTRUCTION = 'Not an instruction aimed at Ares';

export function injectionWarningsIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    readItem,
    extraOf = () => '',
    record,
    correct,
    toEntry,
  }: {
    now: () => number;
    readItem: (itemId: string) => Item | undefined;
    // What the check reads beyond the Item itself (an email's body).
    extraOf?: (item: Item) => string;
    // Logs an injection-warning entry, by Ares.
    record: (warning: Warning, at: number) => ActivityEntry;
    // Logs the User's Not an instruction, a correction.
    correct: (correction: Correction, at: number) => ActivityEntry;
    toEntry: (row: typeof schema.activity.$inferSelect) => ActivityEntry;
  },
): InjectionWarnings {
  const { injectionWarnings, activity } = schema;
  const rowOf = (itemId: string) =>
    db.select().from(injectionWarnings).where(eq(injectionWarnings.itemId, itemId)).get();
  const allWords = (item: Item, extra = extraOf(item)) =>
    extra ? `${wordsOf(item)}\n${extra}` : wordsOf(item);

  // Flags from before they had to quote don't stand.
  db.delete(injectionWarnings)
    .where(and(eq(injectionWarnings.via, 'ares'), sql`json_array_length(${injectionWarnings.found}) = 0`))
    .run();

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
      const words = allWords(item, extra);
      const hash = fingerprint(words);
      const was = rowOf(item.id);
      // The User said what was found holds no instruction: it stays clear until something new is
      // found (a Chat's later messages don't bring back what they cleared).
      if (was?.clearedAt != null) {
        if (was.contentHash === hash) return;
        if (findSteering(words).every((snippet) => was.found.includes(snippet))) {
          db.update(injectionWarnings)
            .set({ contentHash: hash })
            .where(eq(injectionWarnings.itemId, item.id))
            .run();
          return;
        }
      }
      const row = was?.clearedAt != null ? undefined : was;
      const found = findSteering(words);
      if (!found.length) {
        if (was && (was.via === 'pattern' || was.contentHash !== hash)) {
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
        contentHash: hash,
        clearedAt: null,
        clearEntryId: null,
      };
      db.insert(injectionWarnings)
        .values(values)
        .onConflictDoUpdate({ target: injectionWarnings.itemId, set: values })
        .run();
    },

    flag(itemId, quote) {
      const item = readItem(itemId);
      if (!item || trustOf(item) === 'trusted') return null;
      const words = allWords(item);
      if (!quotedIn(words, quote)) return null;
      const row = rowOf(itemId);
      // Marked already, or the User cleared this very passage (or these very words).
      const cleared = (found: string) => quotedIn(quote, found) || quotedIn(found, quote);
      if (
        row &&
        (row.clearedAt === null || row.contentHash === fingerprint(words) || row.found.some(cleared))
      )
        return null;
      const at = now();
      const found = [quote.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE)];
      const entry = warn(item, found, null, at);
      const values = {
        itemId,
        at,
        entryId: entry.id,
        via: 'ares' as const,
        found,
        contentHash: fingerprint(words),
        clearedAt: null,
        clearEntryId: null,
      };
      db.insert(injectionWarnings)
        .values(values)
        .onConflictDoUpdate({ target: injectionWarnings.itemId, set: values })
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

    warning(itemId) {
      const row = rowOf(itemId);
      if (!row || row.clearedAt !== null) return null;
      const [first] = row.found;
      const item = readItem(itemId);
      if (!first) return { quote: null };
      return { quote: item ? passageOf(allWords(item), first) : first };
    },

    clear(itemId, context) {
      const row = rowOf(itemId);
      if (!row || row.clearedAt !== null) throw new InjectionWarningError('That Item isn’t marked');
      const at = now();
      const entry = correct(
        {
          itemId,
          context: { ...context, why: context.why ?? NOT_AN_INSTRUCTION },
          before: { injectionWarning: { via: row.via, found: row.found } },
        },
        at,
      );
      db.update(injectionWarnings)
        .set({ clearedAt: at, clearEntryId: entry.id })
        .where(eq(injectionWarnings.itemId, itemId))
        .run();
      return entry;
    },

    marked(itemIds) {
      const marked = new Map<string, number>();
      const ids = [...new Set(itemIds)];
      // In batches, well under SQLite's limit on bound values.
      for (let at = 0; at < ids.length; at += 500) {
        const rows = db
          .select({ itemId: injectionWarnings.itemId, at: injectionWarnings.at })
          .from(injectionWarnings)
          .where(
            and(
              inArray(injectionWarnings.itemId, ids.slice(at, at + 500)),
              isNull(injectionWarnings.clearedAt),
            ),
          )
          .all();
        for (const row of rows) marked.set(row.itemId, row.at);
      }
      return marked;
    },
  };
}
