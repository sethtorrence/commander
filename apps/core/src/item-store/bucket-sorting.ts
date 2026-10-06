// Sorting email into Buckets (#137), the Item store's side: Bucket Rules sorting mail as it is saved
// from its Source, the re-sort offer after a Rule change ("Also re-sort 42 existing emails?") and its
// one Undo, an email's Bucket as the User (or Ares) sets it, and what removing a Bucket does to its
// emails and Rules. An email's Bucket is a field of its detail (`bucket`, buckets.ts in the domain),
// edited like its synced fields (logged and undone field by field, never queued for the Source), so
// every change here is an activity entry; the list itself lives in ./buckets.ts. Nothing here knows
// Gmail from Outlook: Buckets are Source-agnostic.
import { isDeepStrictEqual } from 'node:util';
import {
  type ActivityEntry,
  type Actor,
  BUCKET_FIELD,
  type BucketAction,
  type BucketChange,
  describeRule,
  type EmailBucket,
  type EmailDetail,
  emailBucket,
  firstMatchFor,
  type Item,
  type ItemRef,
  type ItemState,
  type ResortCandidate,
  type Rule,
  rulesFor,
} from '@commander/domain';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Buckets } from './buckets';
import type { ListChange, Rules } from './rules';
import * as schema from './schema';

type Entry = { by: Actor; why?: string | null };
type Sorting = { rule: Rule; bucketId: string };

const bucketOf = (item: Item): EmailBucket | null =>
  item.detail?.kind === 'email' ? (item.detail.bucket ?? null) : null;

const refOf = (item: Item): ItemRef => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  source: item.source,
  deletedAt: item.deletedAt,
});

export function bucketSortingIn(deps: {
  db: BetterSQLite3Database<typeof schema>;
  now: () => number;
  invalid: (message: string) => Error;
  buckets: Buckets;
  rules: Rules;
  readItem(itemId: string): Item | undefined;
  // The live Items from Sources (the ones Rules file); only emails are sorted.
  sourceItems(): Item[];
  // Edits an Item's synced (or Commander's own) fields, as `edit-fields` does.
  editFields(item: Item, fields: Record<string, unknown>, entry: Entry, at: number): ActivityEntry;
  // Undoes an activity entry, as `undo` does.
  undo(entryId: number, entry: Entry, at: number): ActivityEntry;
}) {
  const { db, now, invalid, buckets, rules } = deps;
  const byUser: Actor = { kind: 'user' };
  const liveEmails = () => deps.sourceItems().filter((item) => item.detail?.kind === 'email');

  // Where the Bucket Rules sort an email, when that differs from where it is: never for an email the
  // User sorted by hand, and not when no Bucket Rule matches (it stays where it is, or Unsorted).
  function ruleSorting(item: Item, list: readonly Rule[]): Sorting | null {
    if (item.detail?.kind !== 'email') return null;
    const current = bucketOf(item);
    if (current?.sortedBy === 'user') return null;
    const rule = firstMatchFor(list, 'bucket', item);
    if (!rule || current?.bucketId === rule.target.bucketId) return null;
    return { rule, bucketId: rule.target.bucketId };
  }

  function sortByRule(item: Item, { rule, bucketId }: Sorting, at: number): ActivityEntry {
    const why = `Rule: ${describeRule(rule.when)}`;
    return deps.editFields(
      item,
      { [BUCKET_FIELD]: { bucketId, sortedBy: 'rule' } },
      { by: { kind: 'rule', ruleId: rule.id }, why },
      at,
    );
  }

  // Undoes entries that sorted emails (only a Rule's when `byRule`), as the User, skipping any already
  // undone and any email sorted elsewhere since.
  function undoSortings(entryIds: readonly number[], why: string, byRule: boolean): ActivityEntry[] {
    const { activity } = schema;
    const undone: ActivityEntry[] = [];
    for (const entryId of entryIds) {
      const target = db.select().from(activity).where(eq(activity.id, entryId)).get();
      if (!target || (byRule && target.actor !== 'rule')) continue;
      if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) continue;
      const item = deps.readItem(target.itemId);
      const after = (target.after as ItemState | null)?.detail;
      const sorted = after?.kind === 'email' ? ((after as EmailDetail).bucket ?? null) : undefined;
      if (!item || sorted === undefined || !isDeepStrictEqual(bucketOf(item), sorted)) continue;
      undone.push(deps.undo(entryId, { by: byUser, why }, now()));
    }
    return undone;
  }

  return {
    /** Sorts an email just saved from its Source by the Bucket Rules, if one moves it. */
    applyOnSave(item: Item, list: readonly Rule[], at: number) {
      const sorting = ruleSorting(item, list);
      if (sorting) sortByRule(item, sorting, at);
    },

    /**
     * The emails a change to the list now sorts into another Bucket: those whose first matching
     * Bucket Rule (or its Bucket) differs from before, and that it sorts somewhere other than where
     * they are. Never one the User sorted by hand.
     */
    resortCandidates({ before, after }: Pick<ListChange, 'before' | 'after'>): ResortCandidate[] {
      const was = rulesFor(before, 'bucket');
      const now = rulesFor(after, 'bucket');
      if (!was.length && !now.length) return [];
      const candidates: ResortCandidate[] = [];
      for (const item of liveEmails()) {
        const current = bucketOf(item);
        if (current?.sortedBy === 'user') continue;
        const match = firstMatchFor(now, 'bucket', item);
        if (!match || current?.bucketId === match.target.bucketId) continue;
        const previous = firstMatchFor(was, 'bucket', item);
        if (previous?.id === match.id && previous.target.bucketId === match.target.bucketId) continue;
        candidates.push({
          item: refOf(item),
          from: current,
          to: { bucketId: match.target.bucketId, sortedBy: 'rule' },
          ruleId: match.id,
        });
      }
      return candidates;
    },

    /** Re-sorts these emails by the Bucket Rules: one entry each, the Rule as actor. Call in a transaction. */
    resort(itemIds: readonly string[]): ActivityEntry[] {
      const list = rules.list();
      const entries: ActivityEntry[] = [];
      for (const itemId of new Set(itemIds)) {
        const item = deps.readItem(itemId);
        if (!item || item.deletedAt !== null) continue;
        const sorting = ruleSorting(item, list);
        if (sorting) entries.push(sortByRule(item, sorting, now()));
      }
      return entries;
    },

    /** Undoes a re-sort, all at once, by the User. Skips emails sorted elsewhere since. */
    undoResort: (entryIds: readonly number[]) => undoSortings(entryIds, 'Undid re-sorting by Rules', true),

    /**
     * An `edit-fields` change's Bucket as it is recorded: a Bucket the User has, sorted by whoever
     * made the change (the User, Ares or a Rule), whatever the change said. Ares (#141) never moves an
     * email the User sorted by hand, nor one a Rule sorted: an accepted Rule beats his judgement.
     */
    normalise(item: Item, fields: Record<string, unknown>, by: Actor): Record<string, unknown> {
      if (item.kind !== 'email' || !(BUCKET_FIELD in fields)) return fields;
      const current = bucketOf(item)?.sortedBy;
      if (by.kind === 'ares' && current === 'user')
        throw invalid('The User sorted this email by hand: Ares leaves it where it is');
      if (by.kind === 'ares' && current === 'rule')
        throw invalid('A Rule sorted this email: Ares leaves it where it is');
      if (fields[BUCKET_FIELD] === null) return fields;
      const parsed = emailBucket.safeParse(fields[BUCKET_FIELD]);
      if (!parsed.success) throw invalid('That isn’t a Bucket');
      const { bucketId } = parsed.data;
      if (bucketId !== null && !buckets.get(bucketId)) throw invalid(`No Bucket ${bucketId}`);
      const sortedBy =
        by.kind === 'user' || by.kind === 'ares' || by.kind === 'rule' ? by.kind : parsed.data.sortedBy;
      return { ...fields, [BUCKET_FIELD]: { bucketId, sortedBy } };
    },

    /**
     * Skip the inbox (#142): the User's own sort into a Bucket that skips the inbox archives the email
     * in the same change (undone with it), when it is in the inbox. A Rule's or Ares's sort never does
     * here: that is a suggestion through the gate (skip-inbox in the Core).
     */
    skipping(item: Item, fields: Record<string, unknown>, by: Actor): Record<string, unknown> {
      if (by.kind !== 'user' || item.detail?.kind !== 'email' || 'inbox' in fields) return fields;
      const sorted = fields[BUCKET_FIELD] as EmailBucket | null | undefined;
      const bucket = sorted?.bucketId ? buckets.get(sorted.bucketId) : undefined;
      const detail = item.detail;
      if (!bucket?.skipInbox || !detail.inInbox || detail.inTrash) return fields;
      return { ...fields, inbox: false, ...(detail.snooze ? { snooze: null } : {}) };
    },

    /**
     * Settings → Buckets' changes. Removing a Bucket makes its emails Unsorted (one entry each, by the
     * User) and deletes the Rules sorting into it; restoring it (Undo) brings it back at its place,
     * with its Rules and the emails not sorted elsewhere since. Call in a transaction.
     */
    change(input: BucketAction): BucketChange {
      const action = buckets.parse(input);
      if (action.type === 'delete') {
        const removing = buckets.get(action.bucketId);
        if (!removing) throw invalid(`No Bucket ${action.bucketId}`);
        const why = `Bucket ${removing.name} removed`;
        const at = now();
        const unsorted = liveEmails()
          .filter((item) => bucketOf(item)?.bucketId === removing.id)
          .map((item) => deps.editFields(item, { [BUCKET_FIELD]: null }, { by: byUser, why }, at).id);
        const ruleIds = rules
          .list()
          .filter((rule) => rule.target.kind === 'bucket' && rule.target.bucketId === removing.id)
          .map((rule) => rule.id);
        for (const ruleId of ruleIds) rules.change({ type: 'delete', ruleId });
        buckets.change(action);
        return { bucket: null, unsorted, rules: ruleIds };
      }
      if (action.type === 'restore') {
        const bucket = buckets.change(action);
        for (const ruleId of action.rules) rules.change({ type: 'restore', ruleId });
        undoSortings(action.unsorted, `Bucket ${bucket?.name ?? ''} restored`.trim(), false);
        return { bucket, unsorted: [], rules: [] };
      }
      return { bucket: buckets.change(action), unsorted: [], rules: [] };
    },
  };
}

export type BucketSorting = ReturnType<typeof bucketSortingIn>;
