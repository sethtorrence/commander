// Mirror Buckets (#142), the Item store's side: whether each email Account mirrors its Buckets to Gmail
// labels or Outlook categories (off unless the User switches it on), the `bucket-mirror` synced field
// following an email's Bucket while it does, the Source's own changes to Commander's labels taken as
// the User's corrections, and the labels or categories to make, rename and delete at the Source. The
// field is queued for the Source like any synced field (ADR 0003), only ever for a mirroring Account;
// the sync engine sends it, and before an Account's writes carries out its label plan (`plan`).
import { isDeepStrictEqual } from 'node:util';
import {
  type ActivityEntry,
  type Actor,
  BUCKET_FIELD,
  BUCKET_MIRROR_FIELD,
  type BucketMirroring,
  type BucketMirroringChange,
  bucketMirroringChange,
  chosenLevel,
  type EmailDetail,
  type Item,
  type ItemState,
  MIRROR_BUCKETS,
  type MirroredBuckets,
  type MirrorPlan,
  type MirrorSource,
  mirroredBucketNames,
  mirroredValue,
  mirrorSource,
  namesOf,
  type Source,
  syncedFieldsOf,
  withSyncedFields,
} from '@commander/domain';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AutonomyStore } from './autonomy';
import type { Buckets } from './buckets';
import type { OutgoingQueue } from './outgoing';
import * as schema from './schema';

type Entry = { by: Actor; why?: string | null };

export type BucketMirrorStore = {
  // Every Account with a mirroring setting (an Account never switched on has none: off).
  list(): BucketMirroring[];
  // Switches mirroring on or off for an Account (removing Commander's labels if asked). Call in a
  // transaction.
  set(change: BucketMirroringChange & { source: MirrorSource }): BucketMirroring;
  // Whether Commander writes the Account's Buckets to its Source now.
  mirrors(account: string | null): boolean;
  // What to make, rename and delete at the Account's Source before its writes; null for nothing.
  plan(account: string): MirrorPlan | null;
  // The Source has carried out the plan.
  planDone(account: string, plan: MirrorPlan): void;
  // The Account was removed.
  removeAccount(account: string): void;
  // Hears (after the change commits) of an Account with label work to do.
  onChange(listener: (account: string) => void): () => void;
};

const SOURCE_NAMES: Record<MirrorSource, string> = { gmail: 'Gmail', outlook: 'Outlook' };

const emailOf = (detail: ItemState['detail'] | Item['detail']): EmailDetail | null =>
  detail?.kind === 'email' ? detail : null;

export type { MirrorPlan };

export function bucketMirrorIn(deps: {
  db: BetterSQLite3Database<typeof schema>;
  now: () => number;
  invalid: (message: string) => Error;
  buckets: Buckets;
  outgoing: OutgoingQueue;
  autonomy: Pick<AutonomyStore, 'settings' | 'saveSettings'>;
  // An Account's live emails.
  liveEmails(source: Source, account: string): Item[];
  // Edits an email's fields, as `edit-fields` does, without skipping the inbox (a correction from the
  // Source is the User's sort, but not their choice to archive).
  editFields(item: Item, fields: Record<string, unknown>, entry: Entry, at: number): ActivityEntry;
}) {
  const { db, now, invalid, buckets, outgoing, autonomy } = deps;
  const { bucketMirroring: settings, bucketMirrorLabels: labels } = schema;
  const listeners = new Set<(account: string) => void>();

  function changed(account: string) {
    void Promise.resolve().then(() => {
      for (const listener of listeners) listener(account);
    });
  }

  const rowOf = (account: string) => db.select().from(settings).where(eq(settings.account, account)).get();
  const labelRows = (account: string) => db.select().from(labels).where(eq(labels.account, account)).all();

  // Mirror Buckets in the Autonomy grid (Tidy your Sources): at Ask or Off nothing is written.
  function paused(): boolean {
    const level = chosenLevel(autonomy.settings(), {
      actionKind: 'tidy-sources',
      action: MIRROR_BUCKETS,
      section: 'email',
    });
    return level === 'off' || level === 'ask';
  }

  function mirrors(account: string | null): boolean {
    if (!account) return false;
    return !!rowOf(account)?.enabled && !paused();
  }

  function setAutonomyOverride(on: boolean) {
    const current = autonomy.settings();
    const next = structuredClone(current);
    if (on) next.actions[MIRROR_BUCKETS] = 'auto';
    else delete next.actions[MIRROR_BUCKETS];
    if (!isDeepStrictEqual(current, next)) autonomy.saveSettings(next);
  }

  const toState = (row: typeof settings.$inferSelect): BucketMirroring => ({
    account: row.account,
    source: row.source,
    enabled: row.enabled,
    paused: row.enabled && paused(),
    removing:
      row.removing &&
      (labelRows(row.account).length > 0 ||
        outgoing.list({ account: row.account }).some((change) => change.field === BUCKET_MIRROR_FIELD)),
  });

  // The Bucket name an email should show at its Source: its Bucket's, or none.
  function wantedName(detail: EmailDetail): string | null {
    const bucketId = detail.bucket?.bucketId;
    return (bucketId && buckets.get(bucketId)?.name) || null;
  }

  // Commander asks for a Bucket's label (category) in the Account, under its name.
  function rememberLabel(account: string, bucketId: string, name: string) {
    const found = db
      .select()
      .from(labels)
      .where(and(eq(labels.account, account), eq(labels.bucketId, bucketId)))
      .get();
    if (found) return;
    db.insert(labels).values({ account, bucketId, name, ready: false }).run();
    changed(account);
  }

  // Queues the field for an email (no activity entry: the Source's labels are all that change).
  function queueMirror(item: Item, value: MirroredBuckets) {
    const detail = emailOf(item.detail);
    // A draft (#138) isn't a message at the Source yet: nothing to label.
    if (!detail || detail.draft || !item.account || !item.source || !item.externalId) return;
    const synced = mirroredBucketNames(detail);
    if (isDeepStrictEqual(synced, value)) return;
    outgoing.queue({
      account: item.account,
      source: item.source,
      itemId: item.id,
      externalId: item.externalId,
      field: BUCKET_MIRROR_FIELD,
      value,
      synced,
      madeAt: now(),
      entryId: null,
    });
  }

  // Every live email of the Account (out of Trash) showing at its Source what its Bucket says.
  function backfill(source: MirrorSource, account: string) {
    for (const item of deps.liveEmails(source, account)) {
      const detail = emailOf(item.detail);
      if (!detail || detail.inTrash) continue;
      const name = wantedName(detail);
      if (name && detail.bucket?.bucketId) rememberLabel(account, detail.bucket.bucketId, name);
      queueMirror(item, name);
    }
  }

  return {
    list(): BucketMirroring[] {
      return db.select().from(settings).all().map(toState);
    },

    set(input: BucketMirroringChange & { source: MirrorSource }): BucketMirroring {
      const source = mirrorSource.parse(input.source);
      const change = bucketMirroringChange.parse(input);
      const existing = rowOf(change.account);
      if (existing && existing.source !== source) throw invalid('That Account isn’t a Gmail or Outlook one');
      const at = now();
      const removing = !change.enabled && change.removeLabels;
      db.insert(settings)
        .values({ account: change.account, source, enabled: change.enabled, removing, updatedAt: at })
        .onConflictDoUpdate({
          target: settings.account,
          set: { enabled: change.enabled, removing, updatedAt: at },
        })
        .run();
      if (change.enabled) {
        // Switching it on is the User's Auto for Mirror Buckets (Tidy your Sources), shown in the grid.
        setAutonomyOverride(true);
        backfill(source, change.account);
      } else {
        // Switching it off stops writing: what is still queued goes, unless it is on its way already.
        outgoing.drop(change.account, BUCKET_MIRROR_FIELD);
        if (removing) {
          for (const item of deps.liveEmails(source, change.account)) {
            const detail = emailOf(item.detail);
            if (detail && mirroredBucketNames(detail) !== null) queueMirror(item, null);
          }
        }
        if (
          !db
            .select()
            .from(settings)
            .all()
            .some((row) => row.enabled)
        )
          setAutonomyOverride(false);
      }
      changed(change.account);
      return toState(rowOf(change.account) as typeof settings.$inferSelect);
    },

    mirrors,

    plan(account: string): MirrorPlan | null {
      const row = rowOf(account);
      // Off: nothing, unless the User asked for the labels to go. Paused: nothing at all.
      if (!row || (!row.enabled && !row.removing) || (row.enabled && paused())) return null;
      const plan: MirrorPlan = { ensure: [], rename: [], remove: [] };
      for (const label of labelRows(account)) {
        const bucket = buckets.get(label.bucketId);
        if (row.removing || !bucket) plan.remove.push({ bucketId: label.bucketId, name: label.name });
        else if (bucket.name !== label.name)
          plan.rename.push({ bucketId: bucket.id, from: label.name, to: bucket.name, colour: bucket.order });
        else if (!label.ready)
          plan.ensure.push({ bucketId: bucket.id, name: bucket.name, colour: bucket.order });
      }
      return plan.ensure.length || plan.rename.length || plan.remove.length ? plan : null;
    },

    planDone(account: string, plan: MirrorPlan) {
      const where = (bucketId: string) => and(eq(labels.account, account), eq(labels.bucketId, bucketId));
      for (const each of plan.remove) {
        // Asked for again meanwhile (a removed Bucket restored): kept, to be made again.
        const bucket = buckets.get(each.bucketId);
        const row = rowOf(account);
        if (bucket && row?.enabled && !row.removing)
          db.update(labels).set({ ready: false }).where(where(each.bucketId)).run();
        else db.delete(labels).where(where(each.bucketId)).run();
      }
      for (const each of plan.rename)
        db.update(labels).set({ name: each.to, ready: true }).where(where(each.bucketId)).run();
      for (const each of plan.ensure)
        db.update(labels).set({ ready: true }).where(where(each.bucketId)).run();
    },

    removeAccount(account: string) {
      db.delete(settings).where(eq(settings.account, account)).run();
      db.delete(labels).where(eq(labels.account, account)).run();
    },

    onChange(listener: (account: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The state an edit (or undo) leaves an email in, with its `bucket-mirror` following its Bucket:
     * while the Account mirrors and the Bucket changed, the Bucket's name (or none); otherwise as it
     * was, so nothing about Buckets reaches the Source while mirroring is off.
     */
    follow(item: Item, before: ItemState, after: ItemState): ItemState {
      const was = emailOf(before.detail);
      const next = emailOf(after.detail);
      if (!was || !next || next.draft) return after;
      const fields = syncedFieldsOf(next) ?? {};
      let wanted = mirroredBucketNames(was);
      const moved = (was.bucket?.bucketId ?? null) !== (next.bucket?.bucketId ?? null);
      if (moved && mirrors(item.account)) {
        wanted = wantedName(next);
        const bucketId = next.bucket?.bucketId;
        if (wanted && bucketId && item.account) rememberLabel(item.account, bucketId, wanted);
      }
      if (isDeepStrictEqual(mirroredBucketNames(next), wanted)) return after;
      return { ...after, detail: withSyncedFields(next, { ...fields, [BUCKET_MIRROR_FIELD]: wanted }) };
    },

    /**
     * A sync brought a change to an email's Commander labels (categories) made at the Source: while the
     * Account mirrors, it moves the email to the Bucket now shown (or Unsorted, with none), as the User,
     * and leaves exactly one label there. `before`: the detail Commander held; `incoming`: the Source's.
     */
    correct(item: Item, before: ItemState['detail'], incoming: ItemState['detail'], at: number) {
      const was = emailOf(before);
      const now_ = emailOf(incoming);
      if (!was || !now_ || !item.source || !mirrors(item.account)) return;
      const shown = mirroredBucketNames(now_);
      const had = mirroredBucketNames(was);
      if (isDeepStrictEqual(shown, had)) return;
      const added = namesOf(shown).filter((name) => !namesOf(had).includes(name));
      let target: { bucketId: string | null; name: string | null } | null = null;
      if (shown === null) target = { bucketId: null, name: null };
      else if (added.length === 1) {
        const found = buckets.list().find((bucket) => bucket.name === added[0]);
        if (found) target = { bucketId: found.id, name: found.name };
      }
      if (!target) return;
      const current = emailOf(item.detail);
      const where = SOURCE_NAMES[item.source as MirrorSource] ?? item.source;
      if ((current?.bucket?.bucketId ?? null) === target.bucketId) {
        // Already there: only the extra labels go.
        if (target.name && Array.isArray(shown)) queueMirror(item, target.name);
        return;
      }
      deps.editFields(
        item,
        { [BUCKET_FIELD]: { bucketId: target.bucketId, sortedBy: 'user' } },
        {
          by: { kind: 'user' },
          why: target.name ? `Moved to ${target.name} in ${where}` : `Taken out of its Bucket in ${where}`,
        },
        at,
      );
    },

    /** A Bucket was renamed: its emails in each mirroring Account show the new name. Call in a transaction. */
    renamed(bucketId: string, name: string) {
      for (const row of db.select().from(settings).all()) {
        if (!mirrors(row.account)) continue;
        for (const item of deps.liveEmails(row.source, row.account)) {
          const detail = emailOf(item.detail);
          if (detail?.bucket?.bucketId === bucketId && !detail.inTrash)
            queueMirror(item, mirroredValue([name]));
        }
        changed(row.account);
      }
    },

    /** A Bucket was removed (or restored): its label work is due in each mirroring Account. */
    touched() {
      for (const row of db.select().from(settings).all())
        if (row.enabled || row.removing) changed(row.account);
    },
  };
}

export type BucketMirror = ReturnType<typeof bucketMirrorIn>;
