// The Item store's Buckets (#137): the User's list of what to do with an email, in their order, each
// with a plain description (what Ares sorts by). Like Rules they live in the same database, written
// only through the Item store, but are not Items: a change to the list isn't in the activity log. The
// emails a change moves are (removing a Bucket makes its emails Unsorted), and the Item store does
// that part; this module keeps the list, its order, and the starter set a fresh install begins with.
import { randomUUID } from 'node:crypto';
import { type Bucket, type BucketAction, bucketAction, STARTER_BUCKETS } from '@commander/domain';
import { asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import * as schema from './schema';

type BucketRow = typeof schema.buckets.$inferSelect;
type ParsedAction = z.output<typeof bucketAction>;

export type Buckets = {
  // The live Buckets in the User's order.
  list(): Bucket[];
  // A live Bucket, or undefined.
  get(bucketId: string): Bucket | undefined;
  // Makes one change to the list (the emails it moves are the Item store's). Call inside a
  // transaction. Returns the Bucket as it is now (null once removed).
  change(action: ParsedAction): Bucket | null;
  parse(action: BucketAction): ParsedAction;
};

const toBucket = (row: BucketRow): Bucket => ({
  id: row.id,
  name: row.name,
  description: row.description,
  order: row.position,
  createdAt: row.createdAt,
  skipInbox: row.skipInbox,
});

export function bucketsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
  invalid: (message: string) => Error,
): Buckets {
  const { buckets } = schema;

  // A fresh install (no row at all, removed ones included) starts with the starter set.
  if (!db.select({ id: buckets.id }).from(buckets).limit(1).get()) {
    const at = now();
    db.insert(buckets)
      .values(STARTER_BUCKETS.map((each, position) => ({ ...each, position, createdAt: at, updatedAt: at })))
      .run();
  }

  const liveRows = () =>
    db
      .select()
      .from(buckets)
      .where(isNull(buckets.deletedAt))
      .orderBy(asc(buckets.position), asc(buckets.createdAt))
      .all();
  const rowById = (id: string) => db.select().from(buckets).where(eq(buckets.id, id)).get();

  function requireLive(id: string): BucketRow {
    const row = rowById(id);
    if (!row || row.deletedAt !== null) throw invalid(`No Bucket ${id}`);
    return row;
  }

  // Names are how the User tells Buckets apart (in the strip, the picker, Ares's prompt): one each.
  function checkName(name: string, except?: string) {
    const taken = liveRows().find(
      (row) => row.id !== except && row.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (taken) throw invalid(`There’s already a Bucket called ${taken.name}`);
  }

  function renumber(ids: readonly string[]) {
    ids.forEach((id, position) => {
      db.update(buckets).set({ position }).where(eq(buckets.id, id)).run();
    });
  }

  function placed(id: string, position: number): string[] {
    const rest = liveRows()
      .map((row) => row.id)
      .filter((other) => other !== id);
    rest.splice(Math.max(0, Math.min(rest.length, position)), 0, id);
    return rest;
  }

  function apply(action: ParsedAction): string | null {
    const at = now();
    switch (action.type) {
      case 'create': {
        checkName(action.bucket.name);
        const id = randomUUID();
        const position = action.position ?? liveRows().length;
        db.insert(buckets)
          .values({ id, ...action.bucket, position, createdAt: at, updatedAt: at })
          .run();
        renumber(placed(id, position));
        return id;
      }
      case 'update': {
        const row = requireLive(action.bucketId);
        if (action.bucket.name !== undefined) checkName(action.bucket.name, row.id);
        db.update(buckets)
          .set({ ...action.bucket, updatedAt: at })
          .where(eq(buckets.id, row.id))
          .run();
        return row.id;
      }
      case 'move': {
        const row = requireLive(action.bucketId);
        renumber(placed(row.id, action.position));
        return row.id;
      }
      case 'delete': {
        const row = requireLive(action.bucketId);
        db.update(buckets).set({ deletedAt: at, updatedAt: at }).where(eq(buckets.id, row.id)).run();
        renumber(liveRows().map((other) => other.id));
        return null;
      }
      case 'restore': {
        const row = rowById(action.bucketId);
        if (!row) throw invalid(`No Bucket ${action.bucketId}`);
        if (row.deletedAt === null) throw invalid('That Bucket isn’t removed');
        checkName(row.name, row.id);
        db.update(buckets).set({ deletedAt: null, updatedAt: at }).where(eq(buckets.id, row.id)).run();
        renumber(placed(row.id, row.position));
        return row.id;
      }
    }
  }

  return {
    list: () => liveRows().map(toBucket),
    get(bucketId) {
      const row = rowById(bucketId);
      return row && row.deletedAt === null ? toBucket(row) : undefined;
    },
    change(action) {
      const id = apply(action);
      if (id === null) return null;
      return toBucket(requireLive(id));
    },
    parse(input) {
      const parsed = bucketAction.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That Bucket isn’t valid');
      return parsed.data;
    },
  };
}
