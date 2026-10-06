// The Updates' side of the Item store (#70): Ares's queue, every Update he gave, and where the
// producers and the User's presence stand. It shares the Item store's database, so the Item store
// stays its only writer. What goes in the queue, and when, is the Updates module's (../updates).
import {
  type CapWarning,
  capWarning,
  type GivenUpdate,
  givenUpdate,
  type QueuedLine,
  type QueuedStatus,
  queuedLine,
} from '@commander/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type UpdateState = {
  // The newest of Ares's proposals the producers have looked at.
  proposalsCursor: number | null;
  // The newest injection-warning activity entry they have counted.
  warningsCursor: number | null;
  // The newest refusal activity entry they have counted (#201).
  refusalsCursor: number | null;
  // When the User last did something, and the longest stretch without since the last Update.
  lastInputAt: number | null;
  longestGapMs: number;
  lastGivenAt: number | null;
};

export type UpdateStore = {
  addLine(line: Omit<QueuedLine, 'id'>): QueuedLine;
  saveLine(id: number, changes: Partial<Omit<QueuedLine, 'id'>>): QueuedLine;
  line(id: number): QueuedLine | null;
  // Oldest first.
  lines(statuses?: readonly QueuedStatus[]): QueuedLine[];
  // The queued line with this merge key, if any.
  queuedWithKey(mergeKey: string): QueuedLine | null;
  // The newest line with this key, whatever became of it.
  lastWithKey(mergeKey: string): QueuedLine | null;
  saveUpdate(update: Omit<GivenUpdate, 'id'>): GivenUpdate;
  update(id: number): GivenUpdate | null;
  // Newest first.
  history(limit?: number): GivenUpdate[];
  state(): UpdateState;
  saveState(changes: Partial<UpdateState>): UpdateState;
  // The month's 80%-of-cap warning, if the model client recorded one.
  capWarning(month: string): CapWarning | null;
};

const EMPTY: UpdateState = {
  proposalsCursor: null,
  warningsCursor: null,
  refusalsCursor: null,
  lastInputAt: null,
  longestGapMs: 0,
  lastGivenAt: null,
};

export function openUpdateStore(db: BetterSQLite3Database<typeof schema>): UpdateStore {
  const { updateQueue, updates, updateState, modelCapWarnings } = schema;
  const toLine = (row: typeof updateQueue.$inferSelect) => queuedLine.parse(row);
  const toUpdate = (row: typeof updates.$inferSelect) => givenUpdate.parse(row);

  function state(): UpdateState {
    const row = db.select().from(updateState).where(eq(updateState.id, 1)).get();
    if (!row) return { ...EMPTY };
    const { id: _id, ...rest } = row;
    return rest;
  }

  return {
    addLine(line) {
      return toLine(
        db
          .insert(updateQueue)
          .values(queuedLine.omit({ id: true }).parse(line))
          .returning()
          .get(),
      );
    },

    saveLine(id, changes) {
      const row = db.update(updateQueue).set(changes).where(eq(updateQueue.id, id)).returning().get();
      if (!row) throw new Error(`No queued line ${id}`);
      return toLine(row);
    },

    line(id) {
      const row = db.select().from(updateQueue).where(eq(updateQueue.id, id)).get();
      return row ? toLine(row) : null;
    },

    lines(statuses = ['queued']) {
      return db
        .select()
        .from(updateQueue)
        .where(inArray(updateQueue.status, [...statuses]))
        .orderBy(updateQueue.id)
        .all()
        .map(toLine);
    },

    queuedWithKey(mergeKey) {
      const row = db
        .select()
        .from(updateQueue)
        .where(and(eq(updateQueue.mergeKey, mergeKey), eq(updateQueue.status, 'queued')))
        .orderBy(desc(updateQueue.id))
        .get();
      return row ? toLine(row) : null;
    },

    lastWithKey(mergeKey) {
      const row = db
        .select()
        .from(updateQueue)
        .where(eq(updateQueue.mergeKey, mergeKey))
        .orderBy(desc(updateQueue.id))
        .get();
      return row ? toLine(row) : null;
    },

    saveUpdate(update) {
      return toUpdate(
        db
          .insert(updates)
          .values(givenUpdate.omit({ id: true }).parse(update))
          .returning()
          .get(),
      );
    },

    update(id) {
      const row = db.select().from(updates).where(eq(updates.id, id)).get();
      return row ? toUpdate(row) : null;
    },

    history(limit = 50) {
      return db.select().from(updates).orderBy(desc(updates.id)).limit(limit).all().map(toUpdate);
    },

    state,

    saveState(changes) {
      const next = { ...state(), ...changes };
      db.insert(updateState)
        .values({ id: 1, ...next })
        .onConflictDoUpdate({ target: updateState.id, set: next })
        .run();
      return next;
    },

    capWarning(month) {
      const row = db.select().from(modelCapWarnings).where(eq(modelCapWarnings.month, month)).get();
      return row ? capWarning.parse(row) : null;
    },
  };
}
