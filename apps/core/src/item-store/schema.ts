// The database schema behind the Item store. Migrations in ../../drizzle are generated from this
// file with `pnpm --filter @commander/core db:generate`; never edit them by hand.
import type {
  ActionKind,
  ActivityAction,
  AresBand,
  AutonomySection,
  ChannelPostDetail,
  ChatDetail,
  ComposeAttachment,
  ComposeBody,
  ComposeMode,
  DashboardBand,
  EmailDetail,
  EventDetail,
  FieldSummary,
  FiledBy,
  FocusSettings,
  GitHubAccess,
  GitHubDiscussion,
  GitHubItemDetail,
  GitHubRepoRef,
  GitHubSummaryDetail,
  GitHubWatch,
  GitHubWriterDetail,
  ItemKind,
  ItemStatus,
  JobOutcome,
  LinearIssueDetail,
  LinkTargetType,
  LinkType,
  MeetingPrepDetail,
  ModelCall,
  OutgoingStatus,
  PeopleChangeAction,
  ProjectChangeAction,
  ProposalRecord,
  ProposalStatus,
  QueuedAbout,
  QueuedStatus,
  RuleTarget,
  RuleWhen,
  SchedulingSettings,
  Source,
  SourceCatalog,
  SummaryCadence,
  SyncOutcomeKind,
  SyncProblem,
  SyncTrigger,
  TodoOrigin,
  UpdateGroup,
  UpdateLine,
  UpdateSection,
  UsageProvider,
  UsageTier,
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
  // For a Todo Ares made from a Teams Chat (#110): the Chat and the message it opens at.
  fromMessage: text('from_message', { mode: 'json' }).$type<{ itemId: string; messageId: string }>(),
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
    tier: text('tier').$type<UsageTier>().notNull(),
    provider: text('provider').$type<UsageProvider>().notNull(),
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

// Kind-specific detail for Channel posts (#111), as Teams sync reported them (see ChannelPostDetail):
// the post and its replies as plain text, with its team and channel as columns for finding a
// channel's posts.
export const channelPostDetails = sqliteTable(
  'channel_post_details',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    teamId: text('team_id').notNull(),
    channelId: text('channel_id').notNull(),
    // The rest of the detail, without `kind`.
    data: text('data', { mode: 'json' }).$type<Omit<ChannelPostDetail, 'kind'>>().notNull(),
  },
  (t) => [index('channel_post_details_channel').on(t.teamId, t.channelId)],
);

// The teams (`channel_id` '') and channels the User excluded from Commander (#111): their posts are
// deleted from Commander and sync skips them until included again (the row goes). Kept by Account and
// Teams ids, as the excluded posts' Items are deleted. A setting, not an Item change.
export const channelSettings = sqliteTable(
  'channel_settings',
  {
    account: text('account').notNull(),
    teamId: text('team_id').notNull(),
    channelId: text('channel_id').notNull(),
    // The team's or channel's name when excluded, for Settings once the list no longer has it.
    name: text('name').notNull(),
    excludedAt: integer('excluded_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.teamId, t.channelId] })],
);

// Kind-specific detail for GitHub's Items (pull requests, issues, review requests and releases), as
// GitHub sync reported them: one table for the four kinds, which are read and written together. The
// `identifier` ("acme/api#12") is how people name a pull request or issue.
export const githubDetails = sqliteTable('github_details', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  identifier: text('identifier'),
  // The rest of the detail, with its `kind`.
  data: text('data', { mode: 'json' }).$type<GitHubItemDetail>().notNull(),
  // A pull request's or issue's discussion (and a pull request's checks), fetched when the GitHub
  // Section opens it (#115): kept for the detail's `updatedAt` it was fetched for, and fetched again
  // once the Item changes. Not part of the Item: never in the activity log.
  discussion: text('discussion', { mode: 'json' }).$type<GitHubDiscussion>(),
  // What the oversight summary's writer reads about a pull request (#119): fetched after GitHub syncs
  // for the pull requests in a summary, kept for the detail's `updatedAt` it was fetched for. Not part
  // of the Item: never in the activity log.
  writerDetail: text('writer_detail', { mode: 'json' }).$type<GitHubWriterDetail>(),
});

// Kind-specific detail for emails, one row per message (see EmailDetail), with what the Email
// Section's thread list and threading look up kept in columns beside it.
export const emailDetails = sqliteTable(
  'email_details',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    messageId: text('message_id'),
    threadKey: text('thread_key').notNull(),
    sourceThreadId: text('source_thread_id'),
    sentAt: integer('sent_at').notNull(),
    unread: integer('unread', { mode: 'boolean' }).notNull(),
    inInbox: integer('in_inbox', { mode: 'boolean' }).notNull(),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull(),
    // In the Source's Trash (#135).
    inTrash: integer('in_trash', { mode: 'boolean' }).notNull().default(false),
    // Snoozed in Commander and waiting until then (#135); null when not snoozed or already back.
    snoozedUntil: integer('snoozed_until'),
    // Back from a snooze set for then: the thread sorts to the top of the inbox from that time.
    returnedFrom: integer('returned_from'),
    // A draft (#138): never part of a thread or a view; listed in Drafts.
    draft: integer('draft', { mode: 'boolean' }).notNull().default(false),
    // The rest of the detail, without `kind`.
    data: text('data', { mode: 'json' }).$type<Omit<EmailDetail, 'kind'>>().notNull(),
  },
  (t) => [
    index('email_details_thread').on(t.threadKey),
    index('email_details_source_thread').on(t.sourceThreadId),
    index('email_details_sent_at').on(t.sentAt),
    index('email_details_snoozed_until').on(t.snoozedUntil),
  ],
);

// Every Message-ID an email names (its own, its In-Reply-To and References), so mail that arrives
// can be threaded among the mail already held, in whatever order it comes.
export const emailMessageIds = sqliteTable(
  'email_message_ids',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    messageId: text('message_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.messageId] }),
    index('email_message_ids_message').on(t.messageId),
  ],
);

// Email bodies (see EmailBody), beside their Items rather than in their detail, so lists and the
// activity log never carry them. Written before a new email's Item (in the same transaction), so its
// first search indexing reads it: hence no foreign key. Deleted when the email is tombstoned or its
// Account removed.
export const emailBodies = sqliteTable('email_bodies', {
  itemId: text('item_id').primaryKey(),
  text: text('text').notNull(),
  html: text('html'),
  textFromHtml: integer('text_from_html', { mode: 'boolean' }).notNull(),
  truncated: integer('truncated', { mode: 'boolean' }).notNull(),
});

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
    // When the first attempt to send it began, if one has: a later attempt can't be sure the first
    // didn't reach the Source (a timeout, a dropped connection, a crash), so it checks before sending
    // again what the Source can't take twice (a Teams message).
    attemptedAt: integer('attempted_at'),
    // When to try again after a failure; null means as soon as possible.
    nextAttemptAt: integer('next_attempt_at'),
    error: text('error'),
  },
  (t) => [index('outgoing_changes_account').on(t.account), index('outgoing_changes_item').on(t.itemId)],
);

// What each Account's Source keeps beside its Items, as its last sync fetched it: the detail pane's
// pickers (Linear: each team's states, members, labels, cycles and Linear projects) or repo health
// (GitHub).
export const sourceCatalogs = sqliteTable('source_catalogs', {
  account: text('account').primaryKey(),
  source: text('source').$type<Source>().notNull(),
  catalog: text('catalog', { mode: 'json' }).$type<SourceCatalog>().notNull(),
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

// Settings → Buckets (#137): what to do with an email, the User's own list. A fresh install gets the
// starter set (buckets.ts); a removed Bucket keeps its row (deleted_at), for Undo.
export const buckets = sqliteTable('buckets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // What belongs in it, plainly: what Ares sorts by.
  description: text('description').notNull(),
  // Its place among the Buckets that aren't removed; a removed one keeps the place it had.
  position: integer('position').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  // Skip the inbox (#142): mail landing in it is archived at its Source. Off for every starter Bucket.
  skipInbox: integer('skip_inbox', { mode: 'boolean' }).notNull().default(false),
});

// Mirror Buckets (#142), per email Account (Settings → Accounts): whether the User switched it on, and
// whether they asked for Commander's labels or categories to be removed on switching it off. No row:
// off, as every Account starts.
export const bucketMirroring = sqliteTable('bucket_mirroring', {
  account: text('account').primaryKey(),
  source: text('source').$type<'gmail' | 'outlook'>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  removing: integer('removing', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

// The Bucket labels (Gmail) or categories (Outlook) Commander has asked for in each mirroring Account,
// under the Bucket's name as last asked for: what to rename when a Bucket is renamed, and what to
// delete when one is removed or the User asks for the labels to go. `ready`: made sure of at the
// Source under that name.
export const bucketMirrorLabels = sqliteTable(
  'bucket_mirror_labels',
  {
    account: text('account').notNull(),
    bucketId: text('bucket_id').notNull(),
    name: text('name').notNull(),
    ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.account, t.bucketId] })],
);

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
  // When the User said it holds no instruction (Not an instruction, #186): the mark stays cleared
  // while the Item's words stay the same. Null while it stands.
  clearedAt: integer('cleared_at'),
  // That correction's activity entry.
  clearEntryId: integer('clear_entry_id').references((): AnySQLiteColumn => activity.id),
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

// Meeting chips (#128): the chip each of today's meetings got in that day's Daily Note, so no event
// ever gets a second one there (re-opening, restarting or re-syncing adds nothing), even after the
// User deleted it. A chip the Core removed itself (an event moved away, with nothing under its chip)
// loses its row, so the event gets one again if it comes back to the day.
export const meetingChips = sqliteTable(
  'meeting_chips',
  {
    dailyNoteId: text('daily_note_id')
      .notNull()
      .references(() => items.id),
    eventId: text('event_id')
      .notNull()
      .references(() => items.id),
    blockId: text('block_id')
      .notNull()
      .references(() => items.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.dailyNoteId, t.eventId] }), index('meeting_chips_block').on(t.blockId)],
);

// Settings → Calendar, in a single row: whether the User asked for a system notification 2 minutes
// before each meeting (#128, decision #23: the one interruption, off until they turn it on).
export const calendarSettings = sqliteTable('calendar_settings', {
  id: integer('id').primaryKey(),
  headsUp: integer('heads_up', { mode: 'boolean' }).notNull(),
  // The second time zone shown in the Calendar Section (#127), as an IANA name; null: none.
  secondTimeZone: text('second_time_zone'),
  updatedAt: integer('updated_at').notNull(),
});

// Kind-specific detail for meeting preps (#130): Ares's preparation for one event, with the event as a
// column so its prep is found by it (one live prep per event: re-running replaces it).
export const meetingPrepDetails = sqliteTable(
  'meeting_prep_details',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    eventId: text('event_id').notNull(),
    // The rest of the detail, without `kind`.
    data: text('data', { mode: 'json' }).$type<Omit<MeetingPrepDetail, 'kind'>>().notNull(),
  },
  (t) => [index('meeting_prep_details_event').on(t.eventId)],
);

// Ares's view of each Teams Chat (#109), one row per Chat he has looked at: how far his "Spot what's
// waiting on you" job has read (the newest message it judged), and his flag while someone in it is
// waiting on the User (the message, his one-sentence reason, when). A flag that goes keeps its row,
// with when, why (`reply`: the User answered; `ares`: he judged it no longer waiting; `user`: cleared
// by hand, with the correction's activity entry, so undo can bring it back), and the message, so a
// hand-cleared message is never flagged again.
export const chatWaiting = sqliteTable('chat_waiting', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  judgedThrough: integer('judged_through'),
  messageId: text('message_id'),
  reason: text('reason'),
  flaggedAt: integer('flagged_at'),
  clearedAt: integer('cleared_at'),
  clearedBy: text('cleared_by').$type<'reply' | 'ares' | 'user'>(),
  clearEntryId: integer('clear_entry_id').references(() => activity.id),
});

// People (#117): someone the User works with, recognised as the same human across Sources. Not
// Items, so their changes go to the People log, not the activity log. A Person merged into another
// keeps its row (`merged_into`, as Projects do), so undoing the merge can bring it back; it is gone
// from every list meanwhile. `name` is the name they go by, kept up to date as their handles change:
// the User's own name for them (`user_name`) when they gave one, else the richest Source's.
export const people = sqliteTable(
  'people',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    userName: text('user_name'),
    mergedInto: text('merged_into'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('people_merged_into').on(t.mergedInto)],
);

// Each handle Commander has seen (`linear:<id>`, `github:<login>`, `teams:<id>` or an email address,
// normalised: see the domain's people.ts), and the Person it belongs to. `name` is its Source's name
// for it. `pinned`: the User placed it (a merge or split), so matching never moves it. `own`: one of
// the User's own handles, from their Accounts, which makes its Person the User.
export const personHandles = sqliteTable(
  'person_handles',
  {
    handle: text('handle').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    name: text('name'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    own: integer('own', { mode: 'boolean' }).notNull().default(false),
    seenAt: integer('seen_at').notNull(),
  },
  (t) => [index('person_handles_person').on(t.personId)],
);

// The People log: every change to People (the User's merges, splits and renames, their undos, and
// matching joining two People by an address they share), with the People and handles it touched
// before and after, which powers undo.
export const peopleChanges = sqliteTable(
  'people_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    action: text('action').$type<PeopleChangeAction>().notNull(),
    // The Person changed (the one kept, for a merge; the one split from, for a split).
    personId: text('person_id').notNull(),
    // The other Person: the one merged away, or the one a split made.
    otherId: text('other_id'),
    why: text('why'),
    before: text('before', { mode: 'json' }).$type<PeopleSnapshot>().notNull(),
    after: text('after', { mode: 'json' }).$type<PeopleSnapshot>().notNull(),
    undoes: integer('undoes').references((): AnySQLiteColumn => peopleChanges.id),
  },
  (t) => [uniqueIndex('people_changes_undoes').on(t.undoes)],
);

export type PersonRowState = typeof people.$inferSelect;
export type HandleRowState = { handle: string; personId: string; pinned: boolean };
// What the People log keeps of the People a change touched: their rows, and their handles' places.
// A Person a change made (a split's new Person) is kept before it as merged into the one it came from.
export type PeopleSnapshot = { people: PersonRowState[]; handles: HandleRowState[] };

// Settings → Calendar's focus time (#131), in a single row: the working hours, the Account whose
// Commander calendar focus blocks go in, and the pairs of Block time across Accounts.
export const focusSettings = sqliteTable('focus_settings', {
  id: integer('id').primaryKey(),
  settings: text('settings', { mode: 'json' }).$type<FocusSettings>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Block time across Accounts (#131): the Busy copy each event got on another Account's main calendar,
// so it is made once, moves and goes with its event, and is never copied again itself. A copy the User
// deleted at its Source keeps its row (tombstoned), so Commander doesn't put it back.
export const busyCopies = sqliteTable(
  'busy_copies',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => items.id),
    targetAccount: text('target_account').notNull(),
    copyId: text('copy_id')
      .notNull()
      .references(() => items.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.targetAccount] }), index('busy_copies_copy').on(t.copyId)],
);

// Settings → GitHub → Oversight summary (#119), in a single row: the two Stuck settings and the bots
// left out of Started.
export const githubOversightSettings = sqliteTable('github_oversight_settings', {
  id: integer('id').primaryKey(),
  longRunningDays: integer('long_running_days').notNull(),
  idleDays: integer('idle_days').notNull(),
  bots: text('bots', { mode: 'json' }).$type<string[]>().notNull(),
  // The skill-managed labels (#120); null: the defaults.
  skillLabels: text('skill_labels', { mode: 'json' }).$type<string[]>(),
  updatedAt: integer('updated_at').notNull(),
});

// The email reader's image rules (#134), per Account. Gmail Accounts show remote images unless the
// User asks to be asked first (`askFirst`); Outlook Accounts hold them back unless the sender is
// trusted. Settings, not Item changes: never in the activity log.
export const emailImageSettings = sqliteTable('email_image_settings', {
  account: text('account').primaryKey(),
  askFirst: integer('ask_first', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

// What the User said to show: one message's images (Show images; `value` is its Item id), or every
// message's from a sender (Always show from this sender; `value` is the address, lower-case).
export const emailImageTrust = sqliteTable(
  'email_image_trust',
  {
    account: text('account').notNull(),
    kind: text('kind').$type<'sender' | 'message'>().notNull(),
    value: text('value').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.kind, t.value] })],
);

// Settings → Calendar's scheduling (#132), in a single row: the Account and calendar new events go in,
// and the User's Google booking link.
export const schedulingSettings = sqliteTable('scheduling_settings', {
  id: integer('id').primaryKey(),
  settings: text('settings', { mode: 'json' }).$type<SchedulingSettings>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});
// Kind-specific detail for Ares's GitHub summaries (#121): the cadence and the day it was written for
// as columns (a daily summary and a roll-up once a day each, across restarts), when it was written,
// when the User first opened it (kept apart from the detail, so marking it seen logs nothing), and
// the rest of the detail.
export const githubSummaryDetails = sqliteTable(
  'github_summary_details',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    cadence: text('cadence').$type<SummaryCadence>().notNull(),
    day: text('day').notNull(),
    writtenAt: integer('written_at').notNull(),
    seenAt: integer('seen_at'),
    data: text('data', { mode: 'json' })
      .$type<Omit<GitHubSummaryDetail, 'kind' | 'cadence' | 'day' | 'writtenAt' | 'seenAt'>>()
      .notNull(),
  },
  (t) => [index('github_summary_details_cadence_day').on(t.cadence, t.day)],
);

// Memory (#74, ADR 0006): what Ares has learned and keeps about the User's world. Not Items, so not
// in the activity log; written only through the Item store (../memory). Rule memories aren't stored:
// they are the Rules themselves, shown in Memory. A deleted memory keeps its row (`deleted_at`), so
// what learned it never learns it again (its `key`). `keywords`: more words it is found by, never
// shown (an example's Item's title, team, labels and people). `handles`: the people it is about, as
// handles, for finding it by who an Item involves. `kept_at`: when the User last kept a fact flagged
// for review; a source deleted after it flags the fact again. `edited_at`: the User's words since.
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<'example' | 'fact' | 'preference'>().notNull(),
    text: text('text').notNull(),
    keywords: text('keywords').notNull().default(''),
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull(),
    by: text('by').$type<'ares' | 'user'>().notNull(),
    key: text('key'),
    personId: text('person_id'),
    projectId: text('project_id'),
    handles: text('handles', { mode: 'json' }).$type<string[]>().notNull(),
    learnedAt: integer('learned_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    editedAt: integer('edited_at'),
    keptAt: integer('kept_at'),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('memories_key').on(t.key),
    index('memories_person').on(t.personId),
    index('memories_project').on(t.projectId),
  ],
);

// The Items each memory came from. No foreign key to the Items: a source Commander no longer holds
// at all is shown as gone (and flags its fact for review), not refused.
export const memorySources = sqliteTable(
  'memory_sources',
  {
    memoryId: text('memory_id')
      .notNull()
      .references(() => memories.id),
    itemId: text('item_id').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.itemId] }), index('memory_sources_item').on(t.itemId)],
);

// How far each of Ares's learners has got (the last activity entry turned into examples, say).
export const memoryProgress = sqliteTable('memory_progress', {
  name: text('name').primaryKey(),
  value: integer('value').notNull(),
});

// Writing email (#138): Commander's own record of each message written in its composer, beside the
// message's `email` Item (whose detail carries what any email does: its recipients, subject and whether
// it is still a draft). What the composer needs to open it again: how it was begun (a reply to which
// message), its body as the composer's model (never HTML), its attachments (the files kept in the data
// folder until it is sent), the quote below it (made once, from the message replied to, as the
// sanitiser cleaned it), and the Message-ID Commander gave it, fixed for good: a crash between sending
// and saving the Source's answer is matched by it. `sendAt`: when it goes once the User pressed Send,
// the end of its Undo time (null while a draft). `sourceText`: the draft's text as the Source answered
// Commander's last save of it; text that differs since was changed in Gmail or Outlook, and the
// composer opens that instead. Not Item state: never in the activity log.
export const emailCompose = sqliteTable(
  'email_compose',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id),
    mode: text('mode').$type<ComposeMode>().notNull(),
    replyToItemId: text('reply_to_item_id'),
    body: text('body', { mode: 'json' }).$type<ComposeBody>().notNull(),
    attachments: text('attachments', { mode: 'json' }).$type<ComposeAttachment[]>().notNull(),
    quoteHtml: text('quote_html'),
    quoteText: text('quote_text'),
    messageId: text('message_id').notNull(),
    sendAt: integer('send_at'),
    sourceText: text('source_text'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('email_compose_message_id').on(t.messageId)],
);

// Settings → Email's writing settings (#138), in a single row: the Account new mail goes from, and how
// long every send is held with Undo.
export const emailComposeSettings = sqliteTable('email_compose_settings', {
  id: integer('id').primaryKey(),
  defaultAccount: text('default_account'),
  undoSeconds: integer('undo_seconds').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Each email Account's signature (#138), stored in Commander (Graph can't read Outlook's), as the
// composer's model.
export const emailSignatures = sqliteTable('email_signatures', {
  account: text('account').primaryKey(),
  body: text('body', { mode: 'json' }).$type<ComposeBody>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});
