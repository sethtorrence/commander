// Two-way sync's outgoing queue, in the Item store's database: every change made in Commander to a
// synced field of a Source Item, queued in the same transaction as the change itself, until it
// reaches the Source. Changes to one field fold together (the latest value, the latest time), and a
// field changed back to what the Source has drops out. The sync engine sends what is due and settles
// each change here; nothing else writes this table.
import { isDeepStrictEqual } from 'node:util';
import {
  type OutgoingChange,
  type OutgoingQuery,
  type OutgoingStatus,
  outgoingQuery,
  type Source,
} from '@commander/domain';
import { and, asc, count, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type OutgoingRow = {
  id: number;
  account: string;
  source: Source;
  itemId: string;
  externalId: string;
  field: string;
  value: unknown;
  synced: unknown;
  madeAt: number;
  entryId: number | null;
  status: OutgoingStatus;
  attempts: number;
  // When the first attempt to send it began, if one has (its outcome may not be known).
  attemptedAt: number | null;
  nextAttemptAt: number | null;
  error: string | null;
};

export type QueuedChange = Pick<
  OutgoingRow,
  'account' | 'source' | 'itemId' | 'externalId' | 'field' | 'value' | 'synced' | 'madeAt' | 'entryId'
> & {
  // Not sent before this (a message held for Undo, #138); sent as soon as it can be otherwise.
  holdUntil?: number | null;
};

export type OutgoingStore = {
  // What the window sees: each queued change, oldest first.
  list(query?: OutgoingQuery): OutgoingChange[];
  // Every queued change to one Item, oldest first.
  forItem(itemId: string): OutgoingRow[];
  // Whether a change to the Item's field is queued (waiting, on its way, or Couldn't sync).
  queued(itemId: string, field: string): boolean;
  // The Account's changes due to be sent now, grouped by Item (the Item changed longest ago first).
  due(account: string, now: number): OutgoingRow[][];
  // When the Account's next change waiting on a back-off is due; null when none is waiting.
  nextDueAt(account: string): number | null;
  // The changes are on their way now (`at`); the first such time is kept as `attemptedAt`.
  markSending(ids: number[], at: number): void;
  // The changes reached the Source (or lost to a newer change there): they leave the queue.
  settle(ids: number[]): void;
  // A failed attempt: back to pending until `nextAttemptAt`, or stopped as Couldn't sync.
  fail(ids: number[], outcome: { error: string; failed: boolean; nextAttemptAt: number | null }): void;
  // Back to pending without counting an attempt (offline, rate-limited, sign-in refused).
  release(ids: number[], nextAttemptAt: number | null): void;
  // Changes made to these fields while they were being sent now follow the change just written:
  // they count as made no earlier than `at`, so the Source's record of that write never beats them.
  follow(itemId: string, fields: string[], at: number): void;
  // Retry: the Item's changes that couldn't sync are pending again, with their attempts reset.
  retry(itemId: string): OutgoingChange[];
  // Changes to this field held until later (messages held for Undo) are due now: Commander is quitting
  // (#138). Returns the Accounts they belong to.
  releaseHeld(field: string, at: number): string[];
  // After a restart nothing is on its way: changes left sending are pending again.
  resetSending(): void;
  counts(account: string): { pending: number; failed: number };
  // The Account is being removed: its queued changes go with it.
  removeAccount(account: string): void;
  // Called (after the change commits) whenever changes are queued or retried.
  onChange(listener: (account: string) => void): () => void;
};

export type OutgoingQueue = OutgoingStore & {
  // Folds a change into the queue. Runs inside the transaction that made the change.
  queue(change: QueuedChange): void;
  // A sync brought the Source's values for an Item: records them as the last-synced values, drops
  // pending changes the Source already has, and returns the changes still to show on top.
  synced(itemId: string, sourceFields: Record<string, unknown>): OutgoingRow[];
  // The Item made in Commander now has the Source's id (an event Commander made): changes still queued
  // for it name that id from now on.
  rekey(itemId: string, externalId: string): void;
};

type Row = typeof schema.outgoingChanges.$inferSelect;

const toRow = (row: Row): OutgoingRow => ({ ...row, value: row.value ?? null, synced: row.synced ?? null });

const toChange = (row: Row): OutgoingChange => ({
  id: row.id,
  itemId: row.itemId,
  source: row.source,
  account: row.account,
  field: row.field,
  status: row.status,
  madeAt: row.madeAt,
  attempts: row.attempts,
  error: row.error,
});

export function openOutgoingQueue(db: BetterSQLite3Database<typeof schema>): OutgoingQueue {
  const { outgoingChanges: table } = schema;
  const listeners = new Set<(account: string) => void>();

  // Listeners hear of a change once its transaction is over (and only if it committed).
  function changed(account: string) {
    void Promise.resolve().then(() => {
      for (const listener of listeners) listener(account);
    });
  }

  const byId = (ids: number[]) => inArray(table.id, ids);
  const waiting = or(eq(table.status, 'pending'), eq(table.status, 'failed'));

  return {
    queue({ holdUntil = null, ...change }) {
      // Changes on their way to the Source stay as sent; a newer change to the field queues after them.
      const existing = db
        .select()
        .from(table)
        .where(and(eq(table.itemId, change.itemId), eq(table.field, change.field), waiting))
        .get();
      if (existing) {
        if (isDeepStrictEqual(change.value, existing.synced ?? null)) {
          db.delete(table).where(eq(table.id, existing.id)).run();
        } else {
          db.update(table)
            .set({
              value: change.value,
              madeAt: change.madeAt,
              entryId: change.entryId,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: holdUntil,
              error: null,
            })
            .where(eq(table.id, existing.id))
            .run();
        }
      } else {
        if (isDeepStrictEqual(change.value, change.synced)) return;
        db.insert(table)
          .values({
            ...change,
            status: 'pending',
            attempts: 0,
            attemptedAt: null,
            nextAttemptAt: holdUntil,
            error: null,
          })
          .run();
      }
      changed(change.account);
    },

    synced(itemId, sourceFields) {
      const rows = db.select().from(table).where(eq(table.itemId, itemId)).orderBy(asc(table.id)).all();
      const kept: OutgoingRow[] = [];
      for (const row of rows) {
        const now = sourceFields[row.field] ?? null;
        if (row.status !== 'sending' && isDeepStrictEqual(row.value ?? null, now)) {
          db.delete(table).where(eq(table.id, row.id)).run();
          continue;
        }
        db.update(table).set({ synced: now }).where(eq(table.id, row.id)).run();
        kept.push(toRow({ ...row, synced: now }));
      }
      return kept;
    },

    rekey(itemId, externalId) {
      db.update(table).set({ externalId }).where(eq(table.itemId, itemId)).run();
    },

    list(input = {}) {
      const query = outgoingQuery.parse(input);
      return db
        .select()
        .from(table)
        .where(
          and(
            query.itemIds ? inArray(table.itemId, query.itemIds) : undefined,
            query.account ? eq(table.account, query.account) : undefined,
          ),
        )
        .orderBy(asc(table.id))
        .all()
        .map(toChange);
    },

    forItem(itemId) {
      return db.select().from(table).where(eq(table.itemId, itemId)).orderBy(asc(table.id)).all().map(toRow);
    },

    queued(itemId, field) {
      return !!db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.itemId, itemId), eq(table.field, field)))
        .get();
    },

    due(account, now) {
      const rows = db
        .select()
        .from(table)
        .where(
          and(
            eq(table.account, account),
            eq(table.status, 'pending'),
            or(isNull(table.nextAttemptAt), lte(table.nextAttemptAt, now)),
          ),
        )
        .orderBy(asc(table.madeAt), asc(table.id))
        .all();
      const groups = new Map<string, OutgoingRow[]>();
      for (const row of rows) groups.set(row.itemId, [...(groups.get(row.itemId) ?? []), toRow(row)]);
      return [...groups.values()];
    },

    nextDueAt(account) {
      const rows = db
        .select({ nextAttemptAt: table.nextAttemptAt })
        .from(table)
        .where(and(eq(table.account, account), eq(table.status, 'pending')))
        .all();
      if (!rows.length) return null;
      return Math.min(...rows.map((row) => row.nextAttemptAt ?? 0));
    },

    markSending(ids, at) {
      if (!ids.length) return;
      db.update(table)
        .set({ status: 'sending', attemptedAt: sql`coalesce(${table.attemptedAt}, ${at})` })
        .where(byId(ids))
        .run();
    },

    settle(ids) {
      if (ids.length) db.delete(table).where(byId(ids)).run();
    },

    fail(ids, { error, failed, nextAttemptAt }) {
      for (const id of ids) {
        const row = db.select().from(table).where(eq(table.id, id)).get();
        if (!row) continue;
        db.update(table)
          .set({
            status: failed ? 'failed' : 'pending',
            attempts: row.attempts + 1,
            nextAttemptAt: failed ? null : nextAttemptAt,
            error,
          })
          .where(eq(table.id, id))
          .run();
      }
    },

    release(ids, nextAttemptAt) {
      if (ids.length) db.update(table).set({ status: 'pending', nextAttemptAt }).where(byId(ids)).run();
    },

    follow(itemId, fields, at) {
      if (!fields.length) return;
      const rows = db
        .select()
        .from(table)
        .where(and(eq(table.itemId, itemId), inArray(table.field, fields), waiting))
        .all();
      for (const row of rows) {
        if (row.madeAt < at) db.update(table).set({ madeAt: at }).where(eq(table.id, row.id)).run();
      }
    },

    retry(itemId) {
      const rows = db
        .select()
        .from(table)
        .where(and(eq(table.itemId, itemId), eq(table.status, 'failed')))
        .all();
      if (rows.length) {
        db.update(table)
          .set({ status: 'pending', attempts: 0, nextAttemptAt: null, error: null })
          .where(byId(rows.map((row) => row.id)))
          .run();
        changed(rows[0]?.account as string);
      }
      return db
        .select()
        .from(table)
        .where(eq(table.itemId, itemId))
        .orderBy(asc(table.id))
        .all()
        .map(toChange);
    },

    releaseHeld(field, at) {
      const held = db
        .select()
        .from(table)
        .where(and(eq(table.field, field), eq(table.status, 'pending'), sql`${table.nextAttemptAt} > ${at}`))
        .all();
      if (!held.length) return [];
      db.update(table)
        .set({ nextAttemptAt: at })
        .where(byId(held.map((row) => row.id)))
        .run();
      const accounts = [...new Set(held.map((row) => row.account))];
      for (const account of accounts) changed(account);
      return accounts;
    },

    resetSending() {
      db.update(table).set({ status: 'pending' }).where(eq(table.status, 'sending')).run();
    },

    counts(account) {
      const rows = db
        .select({ status: table.status, n: count() })
        .from(table)
        .where(eq(table.account, account))
        .groupBy(table.status)
        .all();
      const of = (status: OutgoingStatus) => rows.find((row) => row.status === status)?.n ?? 0;
      return { pending: of('pending') + of('sending'), failed: of('failed') };
    },

    removeAccount(account) {
      db.delete(table).where(eq(table.account, account)).run();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
