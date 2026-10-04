// The database schema behind the Item store. Migrations in ../../drizzle are generated from this
// file with `pnpm --filter @commander/core db:generate`; never edit them by hand.
import type {
  ActionKind,
  ActivityAction,
  AresBand,
  AutonomySection,
  ChatDetail,
  DashboardBand,
  EventDetail,
  FieldSummary,
  FiledBy,
  GitHubAccess,
  GitHubRepoRef,
  GitHubWatch,
  ItemKind,
  ItemStatus,
  JobOutcome,
  LinearCatalog,
  LinearIssueDetail,
  LinkTargetType,
  LinkType,
  ModelCall,
  ModelProvider,
  ModelTier,
  OutgoingStatus,
  ProjectChangeAction,
  ProposalRecord,
  ProposalStatus,
  QueuedAbout,
  QueuedStatus,
  RuleTarget,
  RuleWhen,
  Source,
  SyncOutcomeKind,
  SyncProblem,
  SyncTrigger,
  TodoOrigin,
  UpdateGroup,
  UpdateLine,
  UpdateSection,
} from '@commander/domain';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
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

// Links between Items. A refers-to Link may point at a Project instead (ADR 0002): the target type
// says which, and exactly one of to_item_id and to_project_id is set.
export const links = sqliteTable(
  'links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fromItemId: text('from_item_id')
      .notNull()
      .references(() => items.id),
    type: text('type').$type<LinkType>().notNull(),
    targetType: text('target_type').$type<LinkTargetType>().notNull().default('item'),
    toItemId: text('to_item_id').references(() => items.id),
    toProjectId: text('to_project_id').references((): AnySQLiteColumn => projects.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('links_identity').on(t.fromItemId, t.type, t.toItemId),
    uniqueIndex('links_project_identity').on(t.fromItemId, t.type, t.toProjectId),
    index('links_backlinks').on(t.toItemId),
    index('links_project_backlinks').on(t.toProjectId),
    check(
      'links_target',
      sql`(${t.targetType} = 'item' AND ${t.toItemId} IS NOT NULL AND ${t.toProjectId} IS NULL) OR (${t.targetType} = 'project' AND ${t.type} = 'refers-to' AND ${t.toProjectId} IS NOT NULL AND ${t.toItemId} IS NULL)`,
    ),
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
    // For a Link to a Project (ADR 0002): the Project it points at.
    otherProjectId: text('other_project_id').references((): AnySQLiteColumn => projects.id),
    why: text('why'),
    causedByItemId: text('caused_by_item_id').references(() => items.id),
    causedByEntryId: integer('caused_by_entry_id').references((): AnySQLiteColumn => activity.id),
    undoes: integer('undoes').references((): AnySQLiteColumn => activity.id),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    // A Source's change to detail fields the log keeps only in summary (see the domain's
    // logged-fields.ts): those fields are empty in `before` and `after`, and summarised here.
    summary: text('summary', { mode: 'json' }).$type<FieldSummary[]>(),
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

// Kind-specific detail for Teams Chats, as Teams sync reported them (see ChatDetail): the Chat and
// its recent messages, as plain text.
export const chatDetails = sqliteTable('chat_details', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  // The rest of the detail, without `kind`.
  data: text('data', { mode: 'json' }).$type<Omit<ChatDetail, 'kind'>>().notNull(),
});

// What the User chose for each Teams Chat (#105): muted, or excluded from Commander. Kept by Account
// and the Chat's Teams id rather than by Item, as an excluded Chat's Item is deleted (and sync then
// skips the Chat). A setting, not an Item change: not in the activity log.
export const chatSettings = sqliteTable(
  'chat_settings',
  {
    account: text('account').notNull(),
    chatId: text('chat_id').notNull(),
    // The Chat's name when last changed, for Settings → Teams once its Item is gone.
    name: text('name').notNull(),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
    excludedAt: integer('excluded_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.chatId] })],
);

// Where each Account's sync stands, so it carries on after a restart: the Source's cursor, when it
// last synced, any back-off, and the User's cadence. Never a token.
// One row per Source of each Account: an Account carrying several Sources (a Google Account's Gmail
// and Google Calendar) keeps a cursor, cadence and back-off for each.
export const syncState = sqliteTable(
  'sync_state',
  {
    account: text('account').notNull(),
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
    // Sources with a light sync (Teams): when the last full sync finished, which the cadence counts
    // from, and whether it also checks whenever another Source syncs (null: the default, on).
    lastFullSyncAt: integer('last_full_sync_at'),
    alsoAfterOtherSources: integer('also_after_other_sources', { mode: 'boolean' }),
  },
  (t) => [primaryKey({ columns: [t.account, t.source] })],
);

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

// Settings → Notes → Markdown copy folder (#53): where the read-only Markdown copy of the Daily Notes
// is written, in a single row; no row, or a null folder, while the copy is off.
export const markdownCopy = sqliteTable('markdown_copy', {
  id: integer('id').primaryKey(),
  folder: text('folder'),
  updatedAt: integer('updated_at').notNull(),
});

// Where each of Ares's jobs stands (agent-jobs.ts), kept across restarts: whether the User switched it
// off, how far through the activity log it has looked, and its last run, failures and back-off.
export const agentJobs = sqliteTable('agent_jobs', {
  job: text('job').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // The last activity entry the job has looked at, or null before its first run.
  cursor: integer('cursor'),
  lastRunAt: integer('last_run_at'),
  lastOutcome: text('last_outcome').$type<JobOutcome>(),
  lastProblem: text('last_problem'),
  // Failed runs in a row, and when automatic triggers may run it again.
  failures: integer('failures').notNull().default(0),
  retryAt: integer('retry_at'),
});

// What each job has already looked at, by Item and a fingerprint of what it saw (a Block's text), so
// the same thing is never sent to the model, or suggested, twice. Kept after a suggestion is
// dismissed or undone: that is what stops it being offered again.
export const agentSeen = sqliteTable(
  'agent_seen',
  {
    job: text('job').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    fingerprint: text('fingerprint').notNull(),
    // The proposal it led to, if any.
    proposalId: integer('proposal_id').references(() => proposals.id),
    at: integer('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.itemId, t.fingerprint] })],
);

// Steering warnings (#69): the outside Items holding instructions aimed at Ares, which show the
// warning mark. Found by the pattern check when the Item arrives (`pattern`) or named by a job's
// steering flag (`ares`); each warning is also an injection-warning activity entry. A row goes when
// the instructions do (for `ares`, when the Item's words change).
export const injectionWarnings = sqliteTable('injection_warnings', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  // When the Item was first marked.
  at: integer('at').notNull(),
  // Its latest injection-warning activity entry.
  entryId: integer('entry_id')
    .notNull()
    .references(() => activity.id),
  via: text('via').$type<'pattern' | 'ares'>().notNull(),
  // What the patterns found, folded (empty for a flag alone).
  found: text('found', { mode: 'json' }).$type<string[]>().notNull(),
  // A fingerprint (SHA-256) of the Item's words when it was marked.
  contentHash: text('content_hash').notNull(),
});

// Ares's latest ranking of the Dashboard (#72): one row per Item he ranked (or pending suggestion,
// `suggestion:12`, which is not an Item yet, so no reference), with a fingerprint of the Item as he
// saw it. Each run replaces it whole; `dashboard_ranked` says when.
export const dashboardRankings = sqliteTable('dashboard_rankings', {
  itemId: text('item_id').primaryKey(),
  band: text('band').$type<AresBand>().notNull(),
  rank: integer('rank').notNull(),
  reason: text('reason').notNull(),
  fingerprint: text('fingerprint').notNull(),
});

// When Ares last ranked the Dashboard: one row.
export const dashboardRanked = sqliteTable('dashboard_ranked', {
  id: integer('id').primaryKey(),
  at: integer('at').notNull(),
});

// Rows the User cleared from the Dashboard (`e`): the band each was in, when, and a fingerprint of the
// Item then (null for a suggestion), so Ares leaves it out until it changes. Clearing changes no Item.
export const dashboardClears = sqliteTable('dashboard_clears', {
  itemId: text('item_id').primaryKey(),
  band: text('band').$type<DashboardBand>().notNull(),
  at: integer('at').notNull(),
  fingerprint: text('fingerprint'),
});

// Ares's queue for the Update (#70): each line he wants to tell the User, until it is acted on
// (done or dismissed), settled elsewhere (resolved) or stops mattering (expired). Queued lines with
// the same merge key merge into one.
export const updateQueue = sqliteTable(
  'update_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    group: text('group').$type<UpdateGroup>().notNull(),
    mergeKey: text('merge_key').notNull(),
    about: text('about', { mode: 'json' }).$type<QueuedAbout>().notNull(),
    itemIds: text('item_ids', { mode: 'json' }).$type<string[]>().notNull(),
    section: text('section').$type<UpdateSection>().notNull(),
    importance: real('importance').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at'),
    snoozedUntil: integer('snoozed_until'),
    status: text('status').$type<QueuedStatus>().notNull(),
    settledAt: integer('settled_at'),
  },
  (t) => [index('update_queue_status').on(t.status), index('update_queue_merge_key').on(t.mergeKey)],
);

// Every Update Ares gave, as he gave it, so the User can reopen the last one or any earlier one.
export const updates = sqliteTable('updates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at').notNull(),
  awayMs: integer('away_ms').notNull(),
  folded: integer('folded', { mode: 'boolean' }).notNull(),
  voice: text('voice').$type<'ares' | 'template'>().notNull(),
  lines: text('lines', { mode: 'json' }).$type<UpdateLine[]>().notNull(),
});

// Where the Updates stand, in a single row: how far the producers have looked (Ares's proposals and
// the injection-warning entries), and the User's presence across restarts (when they last did
// something, and the longest stretch without since the last Update).
export const updateState = sqliteTable('update_state', {
  id: integer('id').primaryKey(),
  proposalsCursor: integer('proposals_cursor'),
  warningsCursor: integer('warnings_cursor'),
  lastInputAt: integer('last_input_at'),
  longestGapMs: integer('longest_gap_ms').notNull().default(0),
  lastGivenAt: integer('last_given_at'),
});

// Settings → GitHub (#113): what each GitHub Account watches (whole orgs, with repos left out, and
// single repos), what GitHub last listed it can reach, every repo it has listed, and orgs the User
// added by name. GitHub sync (#114) reads the selection from here.
export const githubWatch = sqliteTable('github_watch', {
  account: text('account').primaryKey(),
  // null until the first selection (the repos worked in lately) is made.
  watch: text('watch', { mode: 'json' }).$type<GitHubWatch>(),
  // The selection is still the one Commander started with.
  fromDefault: integer('from_default', { mode: 'boolean' }).notNull().default(false),
  access: text('access', { mode: 'json' }).$type<GitHubAccess>(),
  // Every repo the Account has listed, so unwatching a whole org finds the Items of repos gone since.
  seen: text('seen', { mode: 'json' }).$type<GitHubRepoRef[]>().notNull().default(sql`'[]'`),
  addedOrgs: text('added_orgs', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  updatedAt: integer('updated_at').notNull(),
});

// Kind-specific detail for calendar events, as calendar sync reported them (see EventDetail), with
// the calendar and the time range kept as columns, for the Agenda's range queries and for finding a
// calendar's events. All-day events' range is widened to their days anywhere on Earth (UTC-12 to
// UTC+14), so a range query never misses one.
export const eventDetails = sqliteTable(
  'event_details',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    calendarId: text('calendar_id').notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    // The rest of the detail, without `kind`.
    data: text('data', { mode: 'json' }).$type<Omit<EventDetail, 'kind'>>().notNull(),
  },
  (t) => [
    index('event_details_range').on(t.startAt, t.endAt),
    index('event_details_calendar').on(t.calendarId),
  ],
);

// Each calendar Account's calendars, as its last sync listed them, and whether the User has each on
// (null: not switched yet, so its default: primary and owned calendars on, subscribed ones off).
export const calendars = sqliteTable(
  'calendars',
  {
    account: text('account').notNull(),
    source: text('source').$type<Source>().notNull(),
    calendarId: text('calendar_id').notNull(),
    name: text('name').notNull(),
    colour: text('colour').notNull(),
    primary: integer('primary', { mode: 'boolean' }).notNull(),
    accessRole: text('access_role').notNull(),
    on: integer('on', { mode: 'boolean' }),
    // Its place in the Account's list, as the Source lists them.
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.calendarId] })],
);
