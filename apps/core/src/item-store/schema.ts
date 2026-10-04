// The database schema behind the Item store. Migrations in ../../drizzle are generated from this
// file with `pnpm --filter @commander/core db:generate`; never edit them by hand.
import type {
  ActionKind,
  ActivityAction,
  AutonomySection,
  FiledBy,
  ItemKind,
  ItemStatus,
  LinearCatalog,
  LinearIssueDetail,
  LinkType,
  ModelCall,
  ModelProvider,
  ModelTier,
  OutgoingStatus,
  ProjectChangeAction,
  ProposalRecord,
  ProposalStatus,
  RuleTarget,
  RuleWhen,
  Source,
  SyncOutcomeKind,
  SyncProblem,
  SyncTrigger,
  TodoOrigin,
} from '@commander/domain';
import { sql } from 'drizzle-orm';
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

// Kind-specific detail for Daily Notes: one per calendar day (YYYY-MM-DD, local).
export const dailyNoteDetails = sqliteTable('daily_note_details', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  day: text('day').notNull().unique(),
});

// Kind-specific detail for Blocks: where each sits in its Daily Note's outline, and its text.
export const blockDetails = sqliteTable(
  'block_details',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    dailyNoteId: text('daily_note_id')
      .notNull()
      .references(() => items.id),
    parentId: text('parent_id').references(() => items.id),
    position: text('position').notNull(),
    text: text('text').notNull(),
    folded: integer('folded', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('block_details_daily_note').on(t.dailyNoteId)],
);

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
    // Set once the Project is merged into another: it is gone from every list, and its code is free,
    // but the row stays so undoing the merge can bring it back.
    mergedInto: text('merged_into'),
  },
  (t) => [uniqueIndex('projects_code').on(t.code).where(sql`${t.mergedInto} IS NULL`)],
);

// Kind-specific detail for Linear issues, as Linear sync reported it (see LinearIssueDetail).
export const linearIssueDetails = sqliteTable('linear_issue_details', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  // e.g. ENG-418, for finding an issue by the name people use for it.
  identifier: text('identifier').notNull(),
  // The rest of the detail, without `kind`.
  data: text('data', { mode: 'json' }).$type<Omit<LinearIssueDetail, 'kind'>>().notNull(),
});

// Where each Account's sync stands, so it carries on after a restart: the Source's cursor, when it
// last synced, any back-off, and the User's cadence. Never a token.
export const syncState = sqliteTable('sync_state', {
  account: text('account').primaryKey(),
  source: text('source').$type<Source>().notNull(),
  // Minutes between syncs; null means the Source's default.
  cadenceMinutes: integer('cadence_minutes'),
  // Whatever the Source's adapter needs to fetch only what changed since (opaque to the engine).
  cursor: text('cursor', { mode: 'json' }),
  lastSyncedAt: integer('last_synced_at'),
  // Failures in a row, and when to try again (back-off, or the Source's Retry-After).
  failures: integer('failures').notNull().default(0),
  retryAt: integer('retry_at'),
  problem: text('problem', { mode: 'json' }).$type<SyncProblem>(),
});

// One row per sync run: what it saved and what it cost the Source (Linear's reported complexity).
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    account: text('account').notNull(),
    source: text('source').$type<Source>().notNull(),
    trigger: text('trigger').$type<SyncTrigger>().notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at').notNull(),
    outcome: text('outcome').$type<SyncOutcomeKind>().notNull(),
    created: integer('created').notNull(),
    updated: integer('updated').notNull(),
    tombstoned: integer('tombstoned').notNull(),
    unchanged: integer('unchanged').notNull(),
    requests: integer('requests').notNull(),
    // The Source's own measure of what the run cost (Linear: summed X-Complexity), when it reports one.
    complexity: integer('complexity'),
    error: text('error'),
  },
  (t) => [index('sync_runs_account').on(t.account, t.startedAt)],
);

// Two-way sync's outgoing queue: each change made in Commander to a synced field of a Source Item,
// until it reaches the Source (or the User undoes it). Queued in the same transaction as the change,
// so it survives restarts.
export const outgoingChanges = sqliteTable(
  'outgoing_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    account: text('account').notNull(),
    source: text('source').$type<Source>().notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    externalId: text('external_id').notNull(),
    // The synced field (see the domain's synced-fields.ts).
    field: text('field').notNull(),
    // The field's value as the User left it, and as the Source had it when last synced.
    value: text('value', { mode: 'json' }),
    synced: text('synced', { mode: 'json' }),
    // When the User made the change (the latest, when several to one field were folded together).
    madeAt: integer('made_at').notNull(),
    // The activity entry that made it.
    entryId: integer('entry_id').references(() => activity.id),
    status: text('status').$type<OutgoingStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    // When to try again after a failure; null means as soon as possible.
    nextAttemptAt: integer('next_attempt_at'),
    error: text('error'),
  },
  (t) => [index('outgoing_changes_account').on(t.account), index('outgoing_changes_item').on(t.itemId)],
);

// What each Account's Source offers the detail pane's pickers (Linear: each team's states, members,
// labels, cycles and Linear projects), as its last sync fetched it.
export const sourceCatalogs = sqliteTable('source_catalogs', {
  account: text('account').primaryKey(),
  source: text('source').$type<Source>().notNull(),
  catalog: text('catalog', { mode: 'json' }).$type<LinearCatalog>().notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

// The Autonomy settings (Everywhere, Section and per-action levels) as one validated document.
export const autonomySettings = sqliteTable('autonomy_settings', {
  id: integer('id').primaryKey(),
  settings: text('settings', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Proposals from Ares that the gate kept: Ask suggestions (pending until the User accepts or
// dismisses them) and actions he carried out automatically, with the activity entries they recorded.
export const proposals = sqliteTable(
  'proposals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    actionKind: text('action_kind').$type<ActionKind>().notNull(),
    action: text('action').notNull(),
    section: text('section').$type<AutonomySection>(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    itemActions: text('item_actions', { mode: 'json' }).$type<ProposalRecord['itemActions']>().notNull(),
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    causedByItemId: text('caused_by_item_id').references(() => items.id),
    causedByEntryId: integer('caused_by_entry_id').references(() => activity.id),
    chained: integer('chained', { mode: 'boolean' }).notNull(),
    decision: text('decision').$type<'ask' | 'auto'>().notNull(),
    status: text('status').$type<ProposalStatus>().notNull(),
    settledAt: integer('settled_at'),
    entryIds: text('entry_ids', { mode: 'json' }).$type<number[]>().notNull(),
  },
  (t) => [index('proposals_item').on(t.itemId), index('proposals_status').on(t.status)],
);

// Settings → Notes → Daily template: the Blocks a new day starts with, as one validated document in a
// single row. A setting rather than Items: a day gets copies of its Blocks.
export const dailyTemplate = sqliteTable('daily_template', {
  id: integer('id').primaryKey(),
  template: text('template', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});
// The Project log: every change to Projects, with the Project rows before and after it, which
// powers undo. Projects are not Items, so this is kept apart from the activity log. A merge also
// lists the activity entries of the Items it moved, so undoing it can undo each of them.
export const projectChanges = sqliteTable(
  'project_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    action: text('action').$type<ProjectChangeAction>().notNull(),
    // The Project changed (the one kept, for a merge); null for a reorder.
    projectId: text('project_id'),
    mergedId: text('merged_id'),
    before: text('before', { mode: 'json' }).$type<ProjectRowState[]>().notNull(),
    after: text('after', { mode: 'json' }).$type<ProjectRowState[]>().notNull(),
    itemEntries: text('item_entries', { mode: 'json' }).$type<number[]>().notNull(),
    // For a merge, and undoing one: the Rules it moved from one Project to the other.
    ruleMoves: text('rule_moves', { mode: 'json' }).$type<RuleMove[]>().notNull().default(sql`'[]'`),
    undoes: integer('undoes').references((): AnySQLiteColumn => projectChanges.id),
  },
  (t) => [uniqueIndex('project_changes_undoes').on(t.undoes)],
);

// A Project row as the Project log keeps it.
export type ProjectRowState = typeof projects.$inferSelect;

// A Rule moved from one Project to another by a merge (or undoing one).
export type RuleMove = { ruleId: string; from: string; to: string };

// Rules: one list the User orders (position 0 is checked first), each filing the Items it matches
// into its target. Not Items, so changing one isn't in the activity log; the Items a Rule files are.
export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  // Its place among the Rules that aren't deleted; a deleted one keeps the place it had, for restoring.
  position: integer('position').notNull(),
  target: text('target', { mode: 'json' }).$type<RuleTarget>().notNull(),
  when: text('when', { mode: 'json' }).$type<RuleWhen>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});
