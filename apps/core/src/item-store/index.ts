import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ActionContext,
  type ActivityAction,
  type ActivityEntry,
  type ActivityQuery,
  type Actor,
  actionContext,
  activityQuery,
  type CausedBy,
  type Item,
  type ItemAction,
  type ItemDetail,
  type ItemKind,
  type ItemQuery,
  type ItemRef,
  type ItemView,
  itemAction,
  itemQuery,
  type Link,
  type LinkType,
  type SaveResult,
  type Source,
  type SourceBatch,
  sourceBatch,
} from '@commander/domain';
import Database from 'better-sqlite3';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { actorColumns, type ItemRow, type ItemState, itemColumns, stateOf, toEntry, toItem } from './rows';
import * as schema from './schema';
import { type Snapshot, takeDailySnapshot } from './snapshots';

export type { Snapshot } from './snapshots';

export type ItemStoreOptions = {
  // The SQLite database file. Created, and migrated to the latest schema, on open.
  path: string;
  // Where daily snapshots of the database are kept.
  snapshotDir: string;
  // The drizzle-kit migrations folder.
  migrationsFolder: string;
  // The clock, in epoch milliseconds. Injectable for tests.
  now?: () => number;
};

export type ItemStore = {
  saveFromSource(batch: SourceBatch): SaveResult;
  query(query?: ItemQuery): Item[];
  // An Item with its Links and backlinks; tombstones included.
  get(itemId: string): ItemView | null;
  // Links two Items: shorthand for recording a link action.
  link(link: { from: string; linkType: LinkType; to: string }, context: ActionContext): ActivityEntry;
  // Every change made in Commander goes through here, and each one records an activity entry.
  record(action: ItemAction, context: ActionContext): ActivityEntry;
  activity(query?: ActivityQuery): ActivityEntry[];
  // Copies the database into the snapshot folder unless today's copy exists, keeping the last 7.
  takeDailySnapshot(): Snapshot | null;
  close(): void;
};

export class ItemStoreError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'already-undone',
    message: string,
  ) {
    super(message);
    this.name = 'ItemStoreError';
  }
}

type LinkState = { from: string; linkType: LinkType; to: string };

function refOf(item: Item): ItemRef {
  return { id: item.id, kind: item.kind, title: item.title, source: item.source, deletedAt: item.deletedAt };
}

type NewEntry = {
  by: Actor;
  action: ActivityAction;
  itemId: string;
  otherItemId?: string | null;
  why?: string | null;
  causedBy?: CausedBy | null;
  undoes?: number | null;
  before: unknown;
  after: unknown;
};

export function openItemStore(options: ItemStoreOptions): ItemStore {
  const now = options.now ?? Date.now;
  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder });

  function findBySourceIdentity(source: Source, account: string, externalId: string): Item | undefined {
    const { items } = schema;
    const row = db
      .select()
      .from(items)
      .where(and(eq(items.source, source), eq(items.account, account), eq(items.externalId, externalId)))
      .get();
    return row && withDetails([row])[0];
  }

  function readItem(id: string): Item | undefined {
    const row = db.select().from(schema.items).where(eq(schema.items.id, id)).get();
    return row && withDetails([row])[0];
  }

  function requireItem(id: string): Item {
    const item = readItem(id);
    if (!item) throw new ItemStoreError('not-found', `No Item ${id}`);
    return item;
  }

  function withDetails(rows: ItemRow[]): Item[] {
    const todoIds = rows.filter((row) => row.kind === 'todo').map((row) => row.id);
    const todos = todoIds.length
      ? db.select().from(schema.todoDetails).where(inArray(schema.todoDetails.itemId, todoIds)).all()
      : [];
    const byId = new Map(todos.map((todo) => [todo.itemId, todo]));
    return rows.map((row) => toItem(row, byId.get(row.id)));
  }

  function checkDetail(kind: ItemKind, state: ItemState) {
    if (state.detail && state.detail.kind !== kind) {
      throw new ItemStoreError('invalid', `A ${kind} Item cannot have ${state.detail.kind} detail`);
    }
  }

  function writeDetail(id: string, detail: ItemDetail | null) {
    const { todoDetails } = schema;
    if (!detail) {
      db.delete(todoDetails).where(eq(todoDetails.itemId, id)).run();
      return;
    }
    const values = { dueOn: detail.dueOn, backedBy: detail.backedBy };
    db.insert(todoDetails)
      .values({ itemId: id, ...values })
      .onConflictDoUpdate({ target: todoDetails.itemId, set: values })
      .run();
  }

  function insertItem(
    identity: Pick<Item, 'kind' | 'source' | 'account' | 'externalId'>,
    state: ItemState,
    at: number,
  ) {
    checkDetail(identity.kind, state);
    const id = randomUUID();
    db.insert(schema.items)
      .values({ id, ...identity, ...itemColumns(state), createdAt: at, updatedAt: at })
      .run();
    writeDetail(id, state.detail);
    return id;
  }

  function writeState(item: Item, state: ItemState, at: number) {
    checkDetail(item.kind, state);
    db.update(schema.items)
      .set({ ...itemColumns(state), updatedAt: at })
      .where(eq(schema.items.id, item.id))
      .run();
    writeDetail(item.id, state.detail);
  }

  function log(entry: NewEntry, at: number): ActivityEntry {
    const row = db
      .insert(schema.activity)
      .values({
        at,
        ...actorColumns(entry.by),
        action: entry.action,
        itemId: entry.itemId,
        otherItemId: entry.otherItemId ?? null,
        why: entry.why ?? null,
        causedByItemId: entry.causedBy?.itemId ?? null,
        causedByEntryId: entry.causedBy?.entryId ?? null,
        undoes: entry.undoes ?? null,
        before: entry.before,
        after: entry.after,
      })
      .returning()
      .get();
    return toEntry(row);
  }

  function readLinks(where: 'from' | 'to', itemId: string): Link[] {
    const { links } = schema;
    const rows = db
      .select()
      .from(links)
      .where(eq(where === 'from' ? links.fromItemId : links.toItemId, itemId))
      .orderBy(links.id)
      .all();
    return rows.map((row) => ({
      type: row.type,
      from: refOf(requireItem(row.fromItemId)),
      to: refOf(requireItem(row.toItemId)),
      createdAt: row.createdAt,
    }));
  }

  function findLink({ from, linkType, to }: LinkState) {
    const { links } = schema;
    return db
      .select()
      .from(links)
      .where(and(eq(links.fromItemId, from), eq(links.type, linkType), eq(links.toItemId, to)))
      .get();
  }

  const record = sqlite.transaction((input: ItemAction, rawContext: ActionContext): ActivityEntry => {
    const action = itemAction.parse(input);
    const context = actionContext.parse(rawContext);
    const at = now();
    const entry = { by: context.by, why: context.why, causedBy: context.causedBy };
    switch (action.type) {
      case 'create': {
        const { kind, ...fields } = action.item;
        const state: ItemState = { ...fields, deletedAt: null };
        const id = insertItem({ kind, source: null, account: null, externalId: null }, state, at);
        return log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
      }
      case 'update': {
        const item = requireItem(action.itemId);
        const before = stateOf(item);
        const after: ItemState = { ...before, ...action.changes };
        writeState(item, after, at);
        return log({ ...entry, action: 'update', itemId: item.id, before, after }, at);
      }
      case 'delete': {
        const item = requireItem(action.itemId);
        const before = stateOf(item);
        const after: ItemState = { ...before, deletedAt: before.deletedAt ?? at };
        writeState(item, after, at);
        return log({ ...entry, action: 'delete', itemId: item.id, before, after }, at);
      }
      case 'link':
      case 'unlink': {
        const link: LinkState = { from: action.from, linkType: action.linkType, to: action.to };
        requireItem(link.from);
        requireItem(link.to);
        if (link.from === link.to) throw new ItemStoreError('invalid', 'An Item cannot link to itself');
        if (action.type === 'unlink' && !findLink(link)) {
          throw new ItemStoreError('not-found', `No ${link.linkType} Link from ${link.from} to ${link.to}`);
        }
        const existed = setLink(link, action.type === 'link', at);
        const after = action.type === 'link' ? link : null;
        return log(
          { ...entry, action: action.type, itemId: link.from, otherItemId: link.to, before: existed, after },
          at,
        );
      }
      case 'undo':
        return undo(action.entryId, entry, at);
    }
  });

  // Makes the Link present or absent, and returns it if it was present before.
  function setLink(link: LinkState, present: boolean, at: number): LinkState | null {
    const { links } = schema;
    const existing = findLink(link);
    if (present && !existing) {
      db.insert(links)
        .values({ fromItemId: link.from, type: link.linkType, toItemId: link.to, createdAt: at })
        .run();
    }
    if (!present && existing) db.delete(links).where(eq(links.id, existing.id)).run();
    return existing ? link : null;
  }

  // Restores what an activity entry changed: the Link's presence, or the Item fields it touched.
  function undo(
    entryId: number,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const { activity } = schema;
    const target = db.select().from(activity).where(eq(activity.id, entryId)).get();
    if (!target) throw new ItemStoreError('not-found', `No activity entry ${entryId}`);
    if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) {
      throw new ItemStoreError('already-undone', `Activity entry ${entryId} is already undone`);
    }
    const undoEntry = { ...entry, action: 'undo' as const, itemId: target.itemId, undoes: entryId };

    if (target.otherItemId !== null) {
      const wanted = target.before as LinkState | null;
      const link = (target.before ?? target.after) as LinkState;
      const existed = setLink(link, wanted !== null, at);
      return log({ ...undoEntry, otherItemId: target.otherItemId, before: existed, after: wanted }, at);
    }

    const item = requireItem(target.itemId);
    const current = stateOf(item);
    const before = target.before as ItemState | null;
    const after = target.after as ItemState;
    // Undoing a creation deletes the Item; it stays as a tombstone so its history survives.
    let restored: ItemState = { ...current, deletedAt: at };
    if (before) {
      restored = { ...current };
      for (const key of Object.keys(after) as (keyof ItemState)[]) {
        if (!isDeepStrictEqual(before[key], after[key])) Object.assign(restored, { [key]: before[key] });
      }
    }
    writeState(item, restored, at);
    return log({ ...undoEntry, before: current, after: restored }, at);
  }

  const saveFromSource = sqlite.transaction((input: SourceBatch): SaveResult => {
    const batch = sourceBatch.parse(input);
    const by: Actor = { kind: 'source', source: batch.source, account: batch.account };
    const result: SaveResult = { created: [], updated: [], tombstoned: [], unchanged: [] };
    for (const incoming of batch.items) {
      const at = now();
      const existing = findBySourceIdentity(batch.source, batch.account, incoming.externalId);
      if (existing) {
        const before = stateOf(existing);
        const after: ItemState = {
          ...before,
          title: incoming.title,
          people: incoming.people,
          status: incoming.status,
          detail: incoming.detail,
          deletedAt: null,
        };
        if (isDeepStrictEqual(before, after)) {
          result.unchanged.push(existing.id);
          continue;
        }
        writeState(existing, after, at);
        log({ by, action: 'update', itemId: existing.id, before, after }, at);
        result.updated.push(existing.id);
        continue;
      }
      const state: ItemState = {
        title: incoming.title,
        people: incoming.people,
        status: incoming.status,
        filing: null,
        detail: incoming.detail,
        deletedAt: null,
      };
      const identity = {
        kind: incoming.kind,
        source: batch.source,
        account: batch.account,
        externalId: incoming.externalId,
      };
      const id = insertItem(identity, state, at);
      log({ by, action: 'create', itemId: id, before: null, after: state }, at);
      result.created.push(id);
    }
    for (const externalId of batch.deleted) {
      const existing = findBySourceIdentity(batch.source, batch.account, externalId);
      if (!existing || existing.deletedAt !== null) continue;
      const at = now();
      const before = stateOf(existing);
      const after: ItemState = { ...before, deletedAt: at };
      writeState(existing, after, at);
      log({ by, action: 'tombstone', itemId: existing.id, before, after }, at);
      result.tombstoned.push(existing.id);
    }
    return result;
  });

  return {
    saveFromSource,

    query(input = {}) {
      const query = itemQuery.parse(input);
      const { items } = schema;
      const rows = db
        .select()
        .from(items)
        .where(
          and(
            query.includeDeleted ? undefined : isNull(items.deletedAt),
            query.kinds ? inArray(items.kind, query.kinds) : undefined,
            query.projectId === null ? isNull(items.projectId) : undefined,
            query.projectId ? eq(items.projectId, query.projectId) : undefined,
            query.source ? eq(items.source, query.source) : undefined,
            query.account ? eq(items.account, query.account) : undefined,
            query.statuses ? inArray(items.status, query.statuses) : undefined,
            query.titleContains
              ? sql`${items.title} LIKE ${`%${query.titleContains.replace(/[\\%_]/g, '\\$&')}%`} ESCAPE '\\'`
              : undefined,
          ),
        )
        .orderBy(desc(items.updatedAt), desc(items.createdAt))
        .limit(query.limit ?? 200)
        .all();
      return withDetails(rows);
    },

    get(itemId) {
      const item = readItem(itemId);
      if (!item) return null;
      return { item, links: readLinks('from', itemId), backlinks: readLinks('to', itemId) };
    },

    link(link, context) {
      return record({ type: 'link', ...link }, context);
    },

    record,

    activity(input = {}) {
      const query = activityQuery.parse(input);
      const { activity } = schema;
      return db
        .select()
        .from(activity)
        .where(
          query.itemId
            ? or(eq(activity.itemId, query.itemId), eq(activity.otherItemId, query.itemId))
            : undefined,
        )
        .orderBy(desc(activity.id))
        .limit(query.limit ?? 200)
        .all()
        .map(toEntry);
    },

    takeDailySnapshot() {
      return takeDailySnapshot(sqlite, options.snapshotDir, now());
    },

    close() {
      sqlite.close();
    },
  };
}
