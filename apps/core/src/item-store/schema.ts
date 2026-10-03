// The database schema behind the Item store. Migrations in ../../drizzle are generated from this
// file with `pnpm --filter @commander/core db:generate`; never edit them by hand.
import type { ActivityAction, FiledBy, ItemKind, ItemStatus, LinkType, Source } from '@commander/domain';
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// The core every Item shares.
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<ItemKind>().notNull(),
    source: text('source').$type<Source>(),
    account: text('account'),
    externalId: text('external_id'),
    title: text('title').notNull(),
    people: text('people', { mode: 'json' }).$type<string[]>().notNull(),
    projectId: text('project_id'),
    filedBy: text('filed_by').$type<FiledBy>(),
    status: text('status').$type<ItemStatus>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('items_source_identity').on(t.source, t.account, t.externalId),
    index('items_project').on(t.projectId),
    index('items_kind').on(t.kind),
  ],
);

// Kind-specific detail for Todos. Other kinds add their own table alongside.
export const todoDetails = sqliteTable('todo_details', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  dueOn: text('due_on'),
  backedBy: text('backed_by').references(() => items.id),
});

export const links = sqliteTable(
  'links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fromItemId: text('from_item_id')
      .notNull()
      .references(() => items.id),
    type: text('type').$type<LinkType>().notNull(),
    toItemId: text('to_item_id')
      .notNull()
      .references(() => items.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('links_identity').on(t.fromItemId, t.type, t.toItemId),
    index('links_backlinks').on(t.toItemId),
  ],
);

// One log of every change: who (actor), what (action, and the state before and after), why, and what
// caused it. The before and after states power undo.
export const activity = sqliteTable(
  'activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    actor: text('actor').$type<'user' | 'ares' | 'rule' | 'source'>().notNull(),
    // The Rule's id, or the Source and Account ("gmail:work") that made the change.
    actorRef: text('actor_ref'),
    action: text('action').$type<ActivityAction>().notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    otherItemId: text('other_item_id').references(() => items.id),
    why: text('why'),
    causedByItemId: text('caused_by_item_id').references(() => items.id),
    causedByEntryId: integer('caused_by_entry_id').references((): AnySQLiteColumn => activity.id),
    undoes: integer('undoes').references((): AnySQLiteColumn => activity.id),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
  },
  (t) => [
    index('activity_item').on(t.itemId),
    index('activity_other_item').on(t.otherItemId),
    uniqueIndex('activity_undoes').on(t.undoes),
  ],
);
