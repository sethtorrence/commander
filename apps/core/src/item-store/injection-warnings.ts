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
//   They choose it from the mark itself, the Update or the Flagged Items list (#201), and can undo it
//   (`undo`): the mark comes back, while what was found is still what it was cleared for.
// - `flagged` lists the marks standing, newest first, with what read like an instruction, and those
//   the User cleared lately (#201).
// - Marks from flags made before they had to quote (found nothing, quoted nothing) are dropped when
//   the store opens: they don't meet the rule.
import { createHash } from 'node:crypto';
import {
  type ActionContext,
  type ActivityEntry,
  type CausedBy,
  type FlaggedItems,
  type Item,
  injectionWarningText,
  NOT_AN_INSTRUCTION,
} from '@commander/domain';
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { findSteering, passageOf, quotedIn } from '../safety/steering';
import { trustOf } from '../safety/trust';
import * as schema from './schema';

export type InjectionWarningStore = {
  // A job's steering flag on an outside Item, with the passage it took as an instruction: marks it
  // and returns the entry, or null when the quote isn't in the Item's text, it was marked already
  // (or cleared by the User for these words), is the User's own, or doesn't exist.
  flag(itemId: string, quote: string): ActivityEntry | null;
  // Whether an Item's own words (an email's body among them) hold a quote word for word, as `flag`
  // reads them, whoever wrote it: where a request to change Ares's settings came from (#197).
  quotes(itemId: string, quote: string): boolean;
  // The injection-warning entries recorded after an activity entry (all of them, from null), oldest
  // first: what the Update counts.
  since(after: number | null): ActivityEntry[];
  // The mark standing on an Item: what in it read like an instruction, as it is written there
  // (null when nothing can be quoted), or null when it isn't marked.
  warning(itemId: string): { quote: string | null } | null;
  // Not an instruction: the User clears the mark (a Todo's: the mark of the Item behind it). Returns
  // their correction.
  clear(itemId: string, context: ActionContext): ActivityEntry;
  // The Flagged Items list (#201): every mark standing, newest first, those cleared lately, and the
  // Items Ares skipped lately because they hold a key or token (refusals.ts).
  flaggedItems(): FlaggedItems;
};

export type Flagged = {
  itemId: string;
  quote: string | null;
  at: number;
  via: 'pattern' | 'ares';
  clearedAt: number | null;
  clearEntryId: number | null;
};

type Warning = { itemId: string; why: string; causedBy: CausedBy | null; after: unknown };
type Correction = { itemId: string; context: ActionContext; before: unknown };

export type InjectionWarnings = Omit<InjectionWarningStore, 'flaggedItems'> & {
  // Checks an Item just saved from its Source. `causedBy` is the save's activity entry; `extra`, text
  // it holds outside its detail (an email's body).
  check(item: Item, at: number, causedBy: number | null, extra?: string): void;
  // When each of these Items was marked (the marks standing now).
  marked(itemIds: readonly string[]): Map<string, number>;
  // The marks standing, newest first, and those cleared since `clearedSince`, newest first.
  flagged(clearedSince: number): { marked: Flagged[]; cleared: Flagged[] };
  // Whether an activity entry is the User's Not an instruction.
  isClearing(entry: Pick<typeof schema.activity.$inferSelect, 'action' | 'before'>): boolean;
  // Undoes the User's Not an instruction (its correction entry): the mark comes back, with the undo
  // logged as theirs. Throws when the Item's words changed since (the mark it cleared is gone).
  undo(cleared: typeof schema.activity.$inferSelect, entry: UndoEntry, at: number): ActivityEntry;
};

type UndoEntry = { by: ActionContext['by']; why?: string | null; causedBy?: CausedBy | null };

/** Thrown when there is no mark to clear. */
export class InjectionWarningError extends Error {
  override name = 'InjectionWarningError';
}

// Every word an Item holds: its title and each piece of text in its detail.
export function wordsOf(item: Item): string {
  const words = [item.title];
  const collect = (value: unknown) => {
    if (typeof value === 'string') words.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(item.detail);
  return words.join('\n');
}

export const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_QUOTE = 500;

export function injectionWarningsIn(
  db: BetterSQLite3Database<typeof schema>,
  {
    now,
    readItem,
    extraOf = () => '',
    record,
    correct,
    undone,
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
    // Logs the undoing of one, by whoever undid it.
    undone: (undo: { itemId: string; undoes: number; entry: UndoEntry }, at: number) => ActivityEntry;
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

  // What in a marked Item read like an instruction, as it is written there (null when nothing can be quoted).
  function quoteOf(row: typeof injectionWarnings.$inferSelect): string | null {
    const [first] = row.found;
    if (!first) return null;
    const item = readItem(row.itemId);
    return item ? passageOf(allWords(item), first) : first;
  }

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

    quotes(itemId, quote) {
      const item = readItem(itemId);
      return !!item && quotedIn(allWords(item), quote);
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
      return { quote: quoteOf(row) };
    },

    flagged(clearedSince) {
      const flagged = (row: typeof injectionWarnings.$inferSelect): Flagged => ({
        itemId: row.itemId,
        quote: quoteOf(row),
        at: row.at,
        via: row.via,
        clearedAt: row.clearedAt,
        clearEntryId: row.clearEntryId,
      });
      const marked = db
        .select()
        .from(injectionWarnings)
        .where(isNull(injectionWarnings.clearedAt))
        .orderBy(desc(injectionWarnings.at), desc(injectionWarnings.entryId))
        .all();
      const cleared = db
        .select()
        .from(injectionWarnings)
        .where(gte(injectionWarnings.clearedAt, clearedSince))
        .orderBy(desc(injectionWarnings.clearedAt), desc(injectionWarnings.clearEntryId))
        .all();
      return { marked: marked.map(flagged), cleared: cleared.map(flagged) };
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

    isClearing: (entry) =>
      entry.action === 'correction' &&
      typeof entry.before === 'object' &&
      entry.before !== null &&
      'injectionWarning' in entry.before,

    undo(cleared, entry, at) {
      const row = rowOf(cleared.itemId);
      const item = readItem(cleared.itemId);
      // What it was cleared for must still be there: found by the patterns again, or quoted.
      const words = item ? allWords(item) : '';
      const stillThere =
        row?.via === 'pattern'
          ? findSteering(words).some((snippet) => row.found.includes(snippet))
          : !!row && row.found.some((quote) => quotedIn(words, quote));
      if (!row || row.clearEntryId !== cleared.id || !stillThere) {
        throw new InjectionWarningError(
          'The mark can’t come back: the words it was for have changed since, and were checked again',
        );
      }
      const logged = undone({ itemId: cleared.itemId, undoes: cleared.id, entry }, at);
      db.update(injectionWarnings)
        .set({ clearedAt: null, clearEntryId: null })
        .where(eq(injectionWarnings.itemId, cleared.itemId))
        .run();
      return logged;
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
