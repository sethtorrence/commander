// The database schema behind the Item store. Migrations in ../../drizzle are generated from this
// file with `pnpm --filter @commander/core db:generate`; never edit them by hand.
import type {
  ActivityAction,
  FiledBy,
  ItemKind,
  ItemStatus,
  LinkType,
  ModelCall,
  ModelProvider,
  ModelTier,
  Source,
  TodoOrigin,
} from '@commander/domain';
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
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
  origin: text('origin').$type<TodoOrigin>().notNull().default('manual'),
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

// The usage ledger: one row per request sent to a model provider. Tokens, latency and cost only;
// no prompt or reply text is ever stored.
export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    job: text('job').notNull(),
    tier: text('tier').$type<ModelTier>().notNull(),
    provider: text('provider').$type<ModelProvider>().notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedTokens: integer('cached_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    // US dollars; null for a model with no known price.
    costUsd: real('cost_usd'),
    // 'ok', or why the call failed.
    outcome: text('outcome').$type<ModelCall['outcome']>().notNull(),
  },
  (t) => [index('model_calls_at').on(t.at)],
);

// The 80%-of-cap warning, at most one per calendar month, for Ares to mention in an Update.
export const modelCapWarnings = sqliteTable('model_cap_warnings', {
  month: text('month').primaryKey(),
  at: integer('at').notNull(),
  spentUsd: real('spent_usd').notNull(),
  capUsd: real('cap_usd').notNull(),
});

// Settings → Ares (tiers, per-job overrides, cap) as one validated document in a single row.
export const modelSettings = sqliteTable('model_settings', {
  id: integer('id').primaryKey(),
  settings: text('settings', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Projects, which Items are filed into (items.project_id). Not Items themselves (ADR 0002).
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Two upper-case letters, unique across every Project, archived ones included.
    code: text('code').notNull(),
    // A palette accent's name, or a custom colour as #RRGGBB.
    accent: text('accent').notNull(),
    // Place in the filter bar and the Badge picker.
    position: integer('position').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('projects_code').on(t.code)],
);
