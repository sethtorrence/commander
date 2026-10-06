import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type ActionContext,
  type ActivityAction,
  type ActivityEntry,
  type ActivityQuery,
  type Actor,
  actionContext,
  activityQuery,
  awaitingAnswer,
  type BlockDetail,
  type BlockIssue,
  type BlockTodo,
  type BlockTodoQuery,
  BUCKET_MIRROR_FIELD,
  type Bucket,
  type BucketAction,
  type BucketChange,
  blockLinksIn,
  blockTodoQuery,
  type CalendarSummary,
  type CausedBy,
  type ChannelSettingAction,
  type ChatSettingAction,
  type CommanderEventDraft,
  type CommanderEventMove,
  type ComposeBody,
  type ComposeDraft,
  compactForLog,
  type DailyNotePage,
  type DailyNoteProjects,
  type DailyNoteQuery,
  type DailyTemplate,
  DELETE_FIELD,
  type DraftEntry,
  dailyNoteQuery,
  decide,
  describeRule,
  type EmailBody,
  type EmailComposeSettings,
  type EmailDetail,
  type EmailLabel,
  type EmailSearchQuery,
  type EmailSearchResult,
  type EmailThread,
  type EmailThreadList,
  type EmailThreadQuery,
  type EmailViewCounts,
  type EmailViewQuery,
  type EventQuery,
  type FieldSummary,
  type Filing,
  firstMatchFor,
  githubIdentifier,
  githubWatchRuleValues,
  type Item,
  type ItemAction,
  type ItemDetail,
  type ItemKind,
  type ItemQuery,
  type ItemRef,
  type ItemView,
  identitiesOf,
  isGitHubItemDetail,
  isPendingEventExternalId,
  itemAction,
  itemQuery,
  type LinearCatalog,
  type LinearIssueDraft,
  type LinearSendPrefill,
  type Link,
  type LinkEnd,
  type LinkTarget,
  type LinkTargetType,
  type LinkType,
  linearCatalog,
  type Mention,
  type MentionQuery,
  mayReadMail,
  mentionQuery,
  type OutboxEntry,
  type Project,
  type ProjectAction,
  type ProjectBlock,
  type ProjectChange,
  type ProjectQuery,
  type ProjectRef,
  type RefileCandidate,
  type Rule,
  type RuleAction,
  type RuleChange,
  type RuleFieldValue,
  type RulePreview,
  type RulePreviewRequest,
  ruleMatches,
  rulePreviewRequest,
  rulesFor,
  type SaveResult,
  type ScheduledEntry,
  SEND_FIELD,
  type SendLaterHeldBy,
  SORT_INTO_BUCKETS,
  type Source,
  type SourceBatch,
  sourceBatch,
  statusFromDetail,
  withoutUntouched,
} from '@commander/domain';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { type MemoryStore, openMemory } from '../memory';
import {
  type EmbeddedWork,
  type MeaningProgress,
  type MeaningWork,
  openSearch,
  type Search,
} from '../search';
import { type AgentStore, openAgentStore } from './agent-jobs';
import { attachmentFolder } from './attachments';
import { type AutonomyStore, openAutonomyStore } from './autonomy';
import { blockFilingIn } from './block-filing';
import { type BucketMirrorStore, bucketMirrorIn, type MirrorPlan } from './bucket-mirror';
import { bucketSortingIn } from './bucket-sorting';
import { bucketsIn } from './buckets';
import { type CalendarSettingsStore, calendarSettingsIn } from './calendar-settings';
import { type CalendarStore, calendarEventRows, calendarsIn, eventRange, eventRows } from './calendars';
import { type ChannelSettingsStore, channelSettingsIn } from './channel-settings';
import { type ChatSettingsStore, chatSettingsIn } from './chat-settings';
import { ChatWaitingError, type ChatWaitingStore, chatWaitingIn } from './chat-waiting';
import {
  type BusyCopies,
  commanderEventsIn,
  movedDetail,
  queueCommanderEventChanges,
} from './commander-events';
import { type ComposeContext, type ComposeRecord, composeIn } from './compose';
import { type ConversationStore, openConversationStore } from './conversations';
import { dailyTemplateIn, inCopyOrder } from './daily-template';
import { type DashboardStore, openDashboardStore } from './dashboard';
import { type EmailImagesStore, emailImagesIn } from './email-images';
import { type EmailSortingStore, emailSortingIn } from './email-sorting';
import { emailsIn } from './emails';
import { type FilingFeedbackStore, filingFeedbackIn } from './filing-feedback';
import { type FocusSettingsStore, focusSettingsIn } from './focus-settings';
import { type GitHubDiscussionStore, githubDiscussionsIn } from './github-discussions';
import { type GitHubOversightStore, githubOversightIn } from './github-oversight';
import { type GitHubSummaryStore, githubSummariesIn } from './github-summaries';
import { githubTodosIn } from './github-todos';
import { type GitHubWatchStore, githubWatchIn } from './github-watch';
import { InjectionWarningError, type InjectionWarningStore, injectionWarningsIn } from './injection-warnings';
import { linearSendIn } from './linear-send';
import { linearTodosIn } from './linear-todos';
import { type MarkdownCopyFolderStore, markdownCopyFolderIn } from './markdown-copy-folder';
import { type MeetingChips, meetingChipsIn } from './meeting-chips';
import { type ModelStore, openModelStore } from './models';
import { type OutgoingStore, openOutgoingQueue } from './outgoing';
import { type PeopleStore, peopleIn } from './people';
import { projectsIn } from './projects';
import {
  actorColumns,
  blockDetailOf,
  changesBetween,
  channelPostDetailOf,
  chatDetailOf,
  dailyNoteDetailOf,
  eventDetailOf,
  githubDetailOf,
  type ItemRow,
  type ItemState,
  itemColumns,
  linearIssueDetailOf,
  meetingPrepDetailOf,
  stateOf,
  todoDetailOf,
  toEntry,
  toItem,
} from './rows';
import { type ListChange, rulesIn } from './rules';
import { type SchedulingSettingsStore, schedulingSettingsIn } from './scheduling-settings';
import * as schema from './schema';
import { keptSnapshots, type Snapshot, takeDailySnapshot } from './snapshots';
import { type SuggestedReplyStore, suggestedRepliesIn } from './suggested-replies';
import { openSyncStateStore, type SyncStateStore } from './sync-state';
import {
  editedState,
  onlyTheUserSends,
  queueChanges,
  undoneDetail,
  unrecallable,
  withQueuedOnTop,
} from './synced-changes';
import { openUpdateStore, type UpdateStore } from './updates';

export type { LearnedMemory, MemoryLookup, MemoryStore, RecalledMemory } from '../memory';
export type { EmbeddedWork, MeaningProgress, MeaningWork, QueryVector, Search } from '../search';
export type { AgentStore, JobState, SeenItem } from './agent-jobs';
export type { NewProposal } from './autonomy';
export type { BucketMirrorStore, MirrorPlan } from './bucket-mirror';
export type { CalendarSettingsStore } from './calendar-settings';
export type { CalendarStore, ListedCalendar } from './calendars';
export type { ChannelSettingsStore } from './channel-settings';
export type { ChatSettingsStore } from './chat-settings';
export type { BusyCopies, BusyCopy } from './commander-events';
export type { ComposeContext, ComposeRecord } from './compose';
export type { AnswerChanges, ConversationStore, RemovedConversation } from './conversations';
export { ConversationError } from './conversations';
export type { DashboardStore, StoredClear } from './dashboard';
export type { FilingFeedbackStore } from './filing-feedback';
export type { FocusSettingsStore } from './focus-settings';
export type { GitHubOversightStore, OversightRequest, StaleWriterDetail } from './github-oversight';
export type { GitHubSummaryStore } from './github-summaries';
export type { GitHubWatchRecord, GitHubWatchStore } from './github-watch';
export type { InjectionWarningStore } from './injection-warnings';
export type { MeetingChips, MeetingChipsChange } from './meeting-chips';
export type { OutgoingRow, OutgoingStore } from './outgoing';
export type { PeopleStore } from './people';
export type { Snapshot } from './snapshots';
export type { SyncRun, SyncState, SyncStateStore } from './sync-state';
export type { UpdateState, UpdateStore } from './updates';

export type ItemStoreOptions = {
  // The SQLite database file. Created, and migrated to the latest schema, on open.
  path: string;
  // Where daily snapshots of the database are kept.
  snapshotDir: string;
  // Where pasted images are kept; `attachments/` next to the database unless given.
  attachmentsDir?: string;
  // The drizzle-kit migrations folder.
  migrationsFolder: string;
  // The clock, in epoch milliseconds. Injectable for tests.
  now?: () => number;
};

export type ItemStore = {
  saveFromSource(batch: SourceBatch): SaveResult;
  // Deletes every Item that came from one Account, when the User removes it. They stay as
  // tombstones, so Links from notes and Todos show them as gone. Returns their ids.
  removeAccountItems(account: { source: Source; account: string }, context: ActionContext): string[];
  query(query?: ItemQuery): Item[];
  // An Item with its Links and backlinks; tombstones included.
  get(itemId: string): ItemView | null;
  // Links two Items (or an Item to a Project, for refers-to): shorthand for recording a link action.
  link(
    link: { from: string; linkType: LinkType; to: string; targetType?: LinkTargetType },
    context: ActionContext,
  ): ActivityEntry;
  // The one backlinks query: every Link pointing at an Item or a Project, oldest first. A Project's
  // include those to Projects merged into it.
  backlinks(target: LinkTarget): Link[];
  // Live Blocks whose `[[` links point at these targets, each with its day: newest day first, then
  // in outline order, target by target.
  mentions(query: MentionQuery): Mention[];
  // Every change made in Commander goes through here, and each one records an activity entry.
  record(action: ItemAction, context: ActionContext): ActivityEntry;
  // Send to Linear (linear-send.ts): makes a new Linear issue's Item, from a Todo, a Block or nothing,
  // and queues its creation for Linear, all as one change. Returns every entry it recorded, in order,
  // the issue's creation first; undoing them all, last first, undoes the send (deleting the issue in
  // Linear once it is there).
  sendToLinear(draft: LinearIssueDraft, context: ActionContext): ActivityEntry[];
  // Where the Send to Linear dialog starts for a Todo or Block, or (from the Linear Section) a Project.
  linearSendPrefill(request: { from?: string; projectId?: string | null }): LinearSendPrefill;
  // Events Commander writes (commander-events.ts): makes a focus block or busy copy's Item and queues its
  // creation at the Source, as one change. Undoing the entry deletes it there too.
  createEvent(draft: CommanderEventDraft, context: ActionContext): ActivityEntry;
  // Moves an event Commander made, queueing its new times for the Source.
  moveEvent(itemId: string, move: CommanderEventMove, context: ActionContext): ActivityEntry;
  // The busy copies Commander made, each with the event it copies (Block time across Accounts).
  busyCopies: BusyCopies;
  // Settings → Calendar's focus time (focus-settings.ts): working hours, where focus blocks go, and
  // the pairs of Block time across Accounts.
  focusSettings: FocusSettingsStore;
  // Settings → Calendar's scheduling (scheduling-settings.ts, #132): where new events go, and the
  // booking link.
  schedulingSettings: SchedulingSettingsStore;
  // Records several actions in order, all or none: a refused action rolls back the ones before it.
  recordAll(actions: ItemAction[], context: ActionContext): ActivityEntry[];
  activity(query?: ActivityQuery): ActivityEntry[];
  // Projects in their order; archived ones only when asked for.
  projects(query?: ProjectQuery): Project[];
  // Creates, renames, recolours, reorders, archives, merges a Project, or undoes such a change. Kept
  // in the Project log, not the activity log, except for the Items a merge moves (one entry each).
  changeProject(action: ProjectAction): ProjectChange;
  // The Rules in their order: the first that matches an Item files it. Whenever Items are saved from
  // a Source, each one not filed by the User goes to its first matching Rule's Project (a Rule wins
  // over Ares and over inheritance); no match leaves its filing alone.
  rules(): Rule[];
  // Creates, edits, moves, deletes or restores a Rule. Also answers which existing Items the changed
  // list now files elsewhere (never hand-filed ones), for the User to re-file or not.
  changeRule(action: RuleAction): RuleChange;
  // How many Items a Rule as drafted matches, a sample of them, and the Rules it overlaps.
  previewRule(request: RulePreviewRequest): RulePreview;
  // Values the Rule editor offers that synced Items may not have yet, by field: each repo Settings →
  // GitHub watches, its org, and each GitHub Account by its login (#118).
  ruleValues(): Record<string, RuleFieldValue[]>;
  // Re-files these Items by the Rules, as one change: one activity entry each, with the Rule that
  // matched as the actor. Skips any the Rules no longer move (filed by hand since, say).
  refile(itemIds: string[]): ActivityEntry[];
  // Undoes a re-filing, all at once, by the User. Skips Items filed elsewhere since.
  undoRefile(entryIds: number[]): ActivityEntry[];
  // Re-sorts these emails into Buckets by the Bucket Rules (#137), as one change: one activity entry
  // each, with the Rule as actor. Skips any the Rules no longer move (sorted by hand since, say).
  resort(itemIds: string[]): ActivityEntry[];
  // Undoes a re-sorting, all at once, by the User. Skips emails sorted elsewhere since.
  undoResort(entryIds: number[]): ActivityEntry[];
  // Settings → Buckets (#137): the User's Buckets in their order (the starter set on a fresh install),
  // and renaming, describing, adding, removing (its emails become Unsorted, its Rules go) and
  // reordering them, or restoring a removed one (Undo).
  buckets(): Bucket[];
  changeBucket(action: BucketAction): BucketChange;
  // Mirror Buckets (#142, bucket-mirror.ts): each email Account's switch (off unless the User switches
  // it on), and the label work the sync engine carries out at the Source before the Account's writes.
  bucketMirror: BucketMirrorStore;
  // The Daily Note for a calendar day (YYYY-MM-DD), made (and recorded) if there isn't one yet. With
  // `fromTemplate` (the day is being made as today), a new one starts with copies of the daily
  // template's Blocks, made in the same transaction. One that already exists does only if it has
  // never held a Block (made ahead of time as a `[[day]]` link's target).
  ensureDailyNote(day: string, context: ActionContext, options?: { fromTemplate?: boolean }): Item;
  // Daily Notes, newest first.
  dailyNotes(query?: DailyNoteQuery): DailyNotePage;
  // The live Blocks of these Daily Notes, each note's in position order.
  blocks(dailyNoteIds: string[]): Item[];
  // One activity entry, or null.
  entry(entryId: number): ActivityEntry | null;
  // Which of the given activity entries have been undone.
  undone(entryIds: number[]): number[];
  // Runs fn as one change: everything it records happens, or (when it throws) none of it does.
  transaction<T>(fn: () => T): T;
  // Settings → Notes → Daily template (the default until the User saves one). Not Items, so saving
  // it is not logged.
  dailyTemplate(): DailyTemplate;
  saveDailyTemplate(template: DailyTemplate): DailyTemplate;
  // Live Todos made from live Blocks (a made-from Link to the Block), with the Block and its day.
  blockTodos(query: BlockTodoQuery): BlockTodo[];
  // Live Linear issues sent from live Blocks of these Daily Notes (a made-from Link to the Block), in
  // the order they were sent.
  blockIssues(dailyNoteIds: string[]): BlockIssue[];
  // Each Daily Note with written Blocks, newest first: the Projects they are filed under, and whether
  // any is Unfiled (the Project filter's counts in Notes).
  dailyNoteProjects(): DailyNoteProjects[];
  // A Project's written Blocks (own or inherited), newest day first, each day's in outline order.
  projectBlocks(projectId: string): ProjectBlock[];
  // The external ids of an Account's live Items behind open Todos (the issues of open Linear Todos):
  // each sync re-reads them, as what a Source reports changed can miss them (a reassignment).
  recheckIds(account: { source: Source; account: string }): string[];
  // Where a sync took Linear Todos off the User's list (their issues reassigned, cancelled…): the
  // Todos' delete entries after an activity entry (all, from null), oldest first, at most 1000.
  linearTodosLeft(after: number | null): ActivityEntry[];
  // The Account's live Items with these external ids, as last saved: for adapters that fetch only
  // part of an Item when it changes (a Chat's new messages).
  fromSource(account: { source: Source; account: string }, externalIds: string[]): Item[];
  // The Calendar Section: live events overlapping a time range, earliest first (calendars.ts).
  events(query: EventQuery): Item[];
  // Invitations still to come that wait for the User's answer, earliest first (#129).
  invitations(): Item[];
  // Each calendar Account's calendars and the User's switch for each, in the same database.
  calendars: CalendarStore;
  // Today's meeting chips (meeting-chips.ts): one per meeting under today's Meetings Block, made and
  // kept in step with the calendar by `fill`, never twice and never on past days.
  meetingChips: MeetingChips;
  // Settings → Calendar (calendar-settings.ts): the opt-in heads-up before each meeting.
  calendarSettings: CalendarSettingsStore;
  // The email reader's image rules (email-images.ts): Ask before showing images, trusted senders,
  // and messages whose images the User chose to show.
  emailImages: EmailImagesStore;
  // Ares's live meeting preps (#130) for these events, at most one each (the prep's detail names its
  // event; its about Link points at it too).
  meetingPreps(eventIds: string[]): Item[];
  // The Account's live events on one calendar.
  calendarEvents(account: { source: Source; account: string }, calendarId: string): Item[];
  // Switches a calendar on or off, as the User. Off hides its events at once (they stay as
  // tombstones, filed and linked as they were, until the calendar is on and synced again). Returns
  // every calendar, as they are now.
  setCalendarOn(
    calendar: { account: string; calendarId: string; on: boolean },
    context: ActionContext,
  ): CalendarSummary[];
  // The external ids of every live Item from an Account's Source: for a re-sync to tell what the
  // Source no longer has.
  externalIds(account: { source: Source; account: string }): string[];
  // The Email Section (emails.ts): the inbox as threads (across Accounts, or one), and one thread's
  // messages, oldest first, with their bodies (null when it has none).
  emailThreads(query?: EmailThreadQuery): EmailThreadList;
  emailThread(account: string, threadKey: string): EmailThread | null;
  // One email's bodies (the reader's HTML among them), or null when none were kept.
  emailBody(itemId: string): EmailBody | null;
  // Writing email (#138, compose.ts): drafts saved and messages sent (held for Undo) through the
  // outgoing queue, the Drafts and Outbox views, Settings → Email's default Account and Undo time, and
  // each Account's signature.
  compose: ComposeApi;
  // Organising email (#135): each view's counts, Section search, and an Account's labels.
  emailViews(query?: EmailViewQuery): EmailViewCounts;
  emailSearch(query: EmailSearchQuery): EmailSearchResult;
  emailLabels(account?: string): EmailLabel[];
  // Snooze: brings back the threads whose snooze is due by `at` (top of the inbox, the latest message
  // unread, "Snoozed until"), as the User's own change. Returns the Items it changed.
  wakeSnoozed(at: number): string[];
  // When the next snooze is due, or null.
  nextSnoozeAt(): number | null;
  // Copies the database into the snapshot folder unless today's copy exists, keeping the last 7,
  // with the pasted images they use (attachments.ts).
  takeDailySnapshot(): Snapshot | null;
  // Saves a pasted image into attachments/ and returns its file name (attachments.ts).
  saveAttachment(bytes: Uint8Array): { name: string };
  // The usage ledger and Settings → Ares, in the same database.
  models: ModelStore;
  // Where each Account's sync stands, and its recent sync runs, in the same database.
  syncState: SyncStateStore;
  // Two-way sync's outgoing queue: changes made in Commander to Source Items' synced fields, queued
  // by record (in the change's own transaction) and sent by the sync engine.
  outgoing: OutgoingStore;
  // The Autonomy settings and the gate's proposals, in the same database.
  autonomy: AutonomyStore;
  // Where Ares's jobs stand and what they have looked at, in the same database.
  agent: AgentStore;
  // The Dashboard (dashboard.ts): Ares's latest ranking and the cleared rows, in the same database.
  dashboard: DashboardStore;
  // Steering warnings (injection-warnings.ts): outside Items checked as they are saved from their
  // Source, and marked when they hold instructions aimed at Ares; a job's steering flag marks one too.
  injectionWarnings: InjectionWarningStore;
  // Global search over the live Items, kept current by every write here.
  search: Search;
  // Search by meaning (#73): the Items and memories whose embedding by a model is missing or out of
  // date, and saving the embeddings the Core's meaning side made for them, written here like every
  // other change. `onPending` hears (after the write) that something new waits to be embedded.
  meaning: {
    pending(model: string, limit: number): MeaningWork[];
    save(model: string, done: readonly EmbeddedWork[]): void;
    progress(model: string): MeaningProgress;
    onPending(listener: () => void): () => void;
  };
  // Memory (#74, ../memory): what Ares has learned and keeps, in the same database. His learners write
  // it, the User confirms, edits and deletes in What Ares knows, and his jobs look it up.
  memory: MemoryStore;
  // A Project as a Link (or a `[[` link token) shows it: the one it was merged into, if it was. Null
  // for no such Project.
  projectRef(projectId: string): ProjectRef | null;
  // Settings → Notes → Markdown copy folder (markdown-copy-folder.ts), in the same database.
  markdownCopyFolder: MarkdownCopyFolderStore;
  // Ares's queue for the Update, the Updates he gave, and where the producers stand (updates.ts).
  updates: UpdateStore;
  // Conversations with Ares and their turns (#191, conversations.ts), in the same database.
  conversations: ConversationStore;
  // Settings → GitHub: what each GitHub Account watches (github-watch.ts), in the same database.
  githubWatch: GitHubWatchStore;
  // The GitHub Section's discussions, fetched on demand and kept beside the detail (github-discussions.ts).
  githubDiscussions: GitHubDiscussionStore;
  // The oversight summary (#119, github-oversight.ts): its settings, the summary, the writer's detail
  // kept beside pull requests, and the lookups finishes Links are made from.
  githubOversight: GitHubOversightStore;
  // Ares's GitHub summaries (#121, github-summaries.ts): each an Item of his, kept with its cadence and
  // day (once a day each), listed newest first, and marked seen when the User opens one.
  githubSummaries: GitHubSummaryStore;
  // People (people.ts): who the people behind Items' handles are, matched across Sources after every
  // save from one, and merged, split and renamed by the User (logged in the People log, for undo).
  people: PeopleStore;
  // Teams Chats the User muted or excluded (chat-settings.ts), in the same database. Excluding one
  // deletes its Item; the sync engine passes an Account's excluded Chats to its sync, to skip.
  chatSettings: ChatSettingsStore;
  // Teams teams and channels the User excluded from Channel posts (#111, channel-settings.ts), and
  // each Account's teams and channels as last listed. Excluding one deletes its posts; the sync
  // engine passes an Account's exclusions to its sync, to skip.
  channelSettings: ChannelSettingsStore;
  // Ares's waiting flags on Chats (chat-waiting.ts), in the same database: each decorates its Chat
  // (`waiting`); the User clearing one by hand is a correction, undone like any change.
  chatWaiting: ChatWaitingStore;
  // Ares's filing (filing-feedback.ts): his record, and the User's corrections and confirmations,
  // which the Item store records whenever the User files an Item he filed or suggested a Project for.
  // Ares's sorting of email (#141, email-sorting.ts): the mail his to sort, and the User's corrections
  // and confirmations, recorded whenever the User moves an email he sorted or suggested a Bucket for.
  emailSorting: EmailSortingStore;
  // Ares's suggested replies to email threads (#143, suggested-replies.ts): his own record beside each
  // thread (decorating it as `suggestedReply`), and the User's sent mail as his drafting reads it.
  suggestedReplies: SuggestedReplyStore;
  filing: FilingFeedbackStore & {
    // The User turned down his suggestion for an Item without filing it (Unfiled): a correction.
    decline(itemId: string, suggestedProjectId: string, context: ActionContext): ActivityEntry;
  };
  close(): void;
};

// Writing email (#138): what the Core's compose side asks of the Item store, each change in a
// transaction of its own.
export type ComposeApi = {
  // Commander's record of a message written in its composer, or null.
  record(itemId: string): ComposeRecord | null;
  save(draft: ComposeDraft, context: ComposeContext): { itemId: string };
  send(draft: ComposeDraft, context: ComposeContext, sendAt: number): { itemId: string; sendAt: number };
  undoSend(itemId: string, context: ActionContext): Item;
  discard(itemId: string, context: ActionContext): void;
  retry(itemId: string): void;
  outbox(): OutboxEntry[];
  drafts(account?: string): DraftEntry[];
  // The draft's text as the Source last answered Commander's save of it, or null.
  answeredText(itemId: string): string | null;
  // Every live email's addresses, for address suggestions.
  addressHistory(): Pick<EmailDetail, 'from' | 'to' | 'cc' | 'bcc' | 'sentByMe' | 'sentAt'>[];
  // Attachments messages not yet sent still need.
  attachmentsInUse(): Set<string>;
  // Commander is quitting: held messages are due now. Returns the Accounts they belong to.
  releaseHeld(): string[];
  // Send later (#139): schedules the message (Commander keeps it, or Microsoft is handed it to hold).
  schedule(
    draft: ComposeDraft,
    context: ComposeContext,
    sendAt: number,
    heldBy: SendLaterHeldBy,
  ): { itemId: string; sendAt: number; heldBy: SendLaterHeldBy };
  // Change time; Send now (or a message Commander holds whose time came); Cancel or Edit.
  reschedule(itemId: string, sendAt: number): void;
  sendScheduled(itemId: string, context: ActionContext, why?: string): void;
  unschedule(itemId: string): Item;
  // Its time passed while Commander wasn't running (`at`, the send-later clock's time).
  miss(itemId: string, at: number): void;
  // The messages Commander holds due by `at` and not missed, and when the next one is due.
  due(at: number): { itemId: string; scheduledAt: number }[];
  nextDueAt(): number | null;
  scheduled(): ScheduledEntry[];
  missed(): { itemId: string; dueAt: number; missedAt: number }[];
  settings: { read(): EmailComposeSettings; save(settings: EmailComposeSettings): EmailComposeSettings };
  signatures: {
    read(account: string): ComposeBody | null;
    save(account: string, body: ComposeBody): ComposeBody;
  };
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

// A Link as the activity log records it. `targetType` is there only for a Link to a Project.
type LinkState = { from: string; linkType: LinkType; to: string; targetType?: 'project' };

const isProjectLink = (link: LinkState) => link.targetType === 'project';

function refOf(item: Item): ItemRef {
  return { id: item.id, kind: item.kind, title: item.title, source: item.source, deletedAt: item.deletedAt };
}

type NewEntry = {
  by: Actor;
  action: ActivityAction;
  itemId: string;
  otherItemId?: string | null;
  otherProjectId?: string | null;
  why?: string | null;
  causedBy?: CausedBy | null;
  undoes?: number | null;
  before: unknown;
  after: unknown;
};

// How much of an email's body the steering check reads, from its start.
const STEERING_BODY_CHECKED = 20_000;
// How far ahead invitations awaiting an answer are looked for: calendar sync's window, and a little.
const INVITATIONS_AHEAD_MS = 400 * 24 * 60 * 60_000;

// Daily Notes and Blocks only make sense with their detail: the day, or the place in the outline.
const NEEDS_DETAIL: ReadonlySet<ItemKind> = new Set(['daily-note', 'block']);
// GitHub's Item kinds, whose detail is kept in one table.
const GITHUB_KINDS: ReadonlySet<ItemKind> = new Set([
  'pull-request',
  'github-issue',
  'review-request',
  'github-release',
]);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// A Daily Note's title: its day written out, "Saturday 3 October 2026".
function dayTitle(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${date} ${MONTHS[month - 1]} ${year}`;
}

const calendarDay = z.iso.date();
// At most this many memories in the palette's Memory group.
const MEMORIES_SEARCHED = 6;
// What marks a memory's key among the work waiting to be embedded (an Item's key is its id).
const MEMORY_KEY = 'memory:';

export function openItemStore(options: ItemStoreOptions): ItemStore {
  const now = options.now ?? Date.now;
  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder });
  const template = dailyTemplateIn(db, now);
  const outgoing = openOutgoingQueue(db);
  const syncState = openSyncStateStore(db);
  const calendars = calendarsIn(db);
  const people = peopleIn(db, now, (message) => new ItemStoreError('invalid', message));
  const warnings = injectionWarningsIn(db, {
    now,
    readItem: (itemId) => readItem(itemId),
    extraOf: (item) =>
      item.kind === 'email' ? (emails.readBody(item.id)?.text ?? '').slice(0, STEERING_BODY_CHECKED) : '',
    record: ({ itemId, why, causedBy, after }, at) =>
      log(
        { by: { kind: 'ares' }, action: 'injection-warning', itemId, why, causedBy, before: null, after },
        at,
      ),
    // Not an instruction: the User's correction, with the mark as `before` and nothing `after`.
    correct: ({ itemId, context, before }, at) =>
      log(
        {
          by: context.by,
          action: 'correction',
          itemId,
          why: context.why ?? null,
          causedBy: context.causedBy ?? null,
          before,
          after: null,
        },
        at,
      ),
    toEntry,
  });
  // Ares's waiting flags on Teams Chats; clearing one by hand is logged as the User's correction.
  const waiting = chatWaitingIn(db, { now, log: (entry, at) => log(entry, at) });
  // Project changes come only from the User (the window); a merge's Item moves are recorded as theirs.
  const byUser: Actor = { kind: 'user' };
  const projects = projectsIn(
    db,
    now,
    (message) => new ItemStoreError('invalid', message),
    {
      refile(from, into, why) {
        const rows = db.select().from(schema.items).where(eq(schema.items.projectId, from)).all();
        return withDetails(rows).map((item) => {
          const at = now();
          const before = stateOf(item);
          const filedBy = before.filing?.filedBy ?? 'user';
          const after = writeState(item, { ...before, filing: { projectId: into, filedBy } }, at);
          return log({ by: byUser, action: 'update', itemId: item.id, why, before, after }, at).id;
        });
      },
      undo: (entryIds, why) => undoFilings(entryIds, why).map((entry) => entry.id),
    },
    { retarget: (from, into) => rules.retarget(from, into), reverse: (moves) => rules.reverse(moves) },
  );
  // The User's Buckets (#137); a fresh install gets the starter set here.
  const buckets = bucketsIn(db, now, (message) => new ItemStoreError('invalid', message));
  const rules = rulesIn(
    db,
    now,
    (message) => new ItemStoreError('invalid', message),
    (projectId) => projects.checkFiling({ projectId, filedBy: 'rule' }),
    (bucketId) => {
      if (!buckets.get(bucketId)) throw new ItemStoreError('invalid', `No Bucket ${bucketId}`);
    },
  );
  // Sorting email into Buckets (bucket-sorting.ts): Bucket Rules on save, re-sorting, removing a Bucket.
  const sorting = bucketSortingIn({
    db,
    now,
    invalid: (message) => new ItemStoreError('invalid', message),
    buckets,
    rules,
    readItem: (itemId) => readItem(itemId),
    sourceItems: () => sourceItems(),
    editFields: (item, fields, entry, at) => editFields(item, fields, entry, at),
    undo: (entryId, entry, at) => undo(entryId, entry, at),
  });
  // Mirror Buckets (bucket-mirror.ts): the `bucket-mirror` field following each email's Bucket while
  // its Account mirrors, the Source's changes to Commander's labels taken as corrections.
  const mirror = bucketMirrorIn({
    db,
    now,
    invalid: (message) => new ItemStoreError('invalid', message),
    buckets,
    outgoing,
    autonomy: openAutonomyStore(db, now),
    liveEmails: (source, account) => liveSourceItems(source, account).filter((item) => item.kind === 'email'),
    editFields: (item, fields, entry, at) => editFields(item, fields, entry, at, { skipInbox: false }),
  });
  // Ares's filing suggestions on Items, and the User's answers to his filing.
  const filing = filingFeedbackIn(db, (entry, at) => log({ ...entry, why: null }, at));
  // Ares's sorting of email (#141): the mail his to sort, his suggested Buckets, and the User's answers.
  const sortingAnswers = emailSortingIn(db, {
    withDetails: (rows) => withDetails(rows),
    log: (entry, at) => log({ ...entry, why: null }, at),
    now,
    sorting: {
      on: () =>
        agent.job(SORT_INTO_BUCKETS).enabled &&
        decide(
          {
            action: SORT_INTO_BUCKETS,
            actionKind: 'organise',
            section: 'email',
            confidence: 1,
            chained: false,
          },
          autonomy.settings(),
        ) !== 'off',
      mayRead: (source, account) => mayReadMail(models.settings(), source, account),
    },
  });
  const attachments = attachmentFolder({
    dir: options.attachmentsDir ?? join(dirname(options.path), 'attachments'),
    now,
    invalid: (message) => new ItemStoreError('invalid', message),
  });
  // Emails (emails.ts): their detail, threading as they arrive, and their bodies beside them.
  const emails = emailsIn(db, {
    withDetails: (rows) => withDetails(rows),
    now,
    search: () => search,
    suggested: (itemIds) => new Set(sortingAnswers.suggestions(itemIds).keys()),
  });
  // Ares's suggested replies (#143): his drafts beside their threads, and the User's sent mail.
  const suggestedReplies = suggestedRepliesIn(db, {
    now,
    withDetails: (rows) => withDetails(rows),
    readItem: (itemId) => readItem(itemId),
    messagesOf: (threads) => emails.messagesOf(threads),
    autonomy: () => autonomy.settings(),
    models: () => models.settings(),
  });
  // Ares's GitHub summaries (github-summaries.ts): their detail, and when the User first opened each.
  const summaries = githubSummariesIn(db, { now, withDetails: (rows) => withDetails(rows) });

  // Undoes entries that filed Items (a merge, or only a Rule's when `byRule`), as the User, skipping
  // any already undone and any Item filed elsewhere since.
  function undoFilings(entryIds: readonly number[], why: string, byRule = false): ActivityEntry[] {
    const { activity } = schema;
    const undone: ActivityEntry[] = [];
    for (const entryId of entryIds) {
      const target = db.select().from(activity).where(eq(activity.id, entryId)).get();
      if (!target || (byRule && target.actor !== 'rule')) continue;
      if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) continue;
      const item = readItem(target.itemId);
      const moved = (target.after as ItemState | null)?.filing;
      if (!item || !isDeepStrictEqual(item.filing, moved)) continue;
      undone.push(undo(entryId, { by: byUser, why }, now()));
    }
    return undone;
  }

  // The live Items from Sources: the ones Rules file.
  function sourceItems(): Item[] {
    const { items } = schema;
    const rows = db
      .select()
      .from(items)
      .where(and(isNotNull(items.source), isNull(items.deletedAt)))
      .orderBy(desc(items.updatedAt), desc(items.createdAt))
      .all();
    return withDetails(rows);
  }

  // Where the Rules file an Item, when that differs from where it is: never for an Item the User
  // filed by hand, and not when no Rule matches.
  function ruleFiling(item: Item, list: readonly Rule[]): { rule: Rule; filing: Filing } | null {
    if (item.filing?.filedBy === 'user') return null;
    const rule = firstMatchFor(list, 'project', item);
    if (!rule) return null;
    const filing: Filing = { projectId: rule.target.projectId, filedBy: 'rule' };
    // An Item already in the Rule's Project by inheritance (an issue sent to Linear takes its item's
    // Project) stays filed as it is.
    if (item.filing?.filedBy === 'inherited' && item.filing.projectId === filing.projectId) return null;
    return isDeepStrictEqual(item.filing, filing) ? null : { rule, filing };
  }

  function fileByRule(item: Item, { rule, filing }: { rule: Rule; filing: Filing }, at: number) {
    const before = stateOf(item);
    const after = writeState(item, { ...before, filing }, at);
    const why = `Rule: ${describeRule(rule.when)}`;
    const logged = log(
      { by: { kind: 'rule', ruleId: rule.id }, action: 'update', itemId: item.id, why, before, after },
      at,
    );
    // An event's meeting chips follow it.
    blockFiling.afterUpdate({ ...item, ...after }, before, logged, at);
    return logged;
  }

  // The existing Items a change to the list moves: those whose first matching Rule (or its Project)
  // differs from before, and which it files somewhere other than where they are.
  function refileCandidates(change: Pick<ListChange, 'before' | 'after'>): RefileCandidate[] {
    const before = rulesFor(change.before, 'project');
    const after = rulesFor(change.after, 'project');
    if (!before.length && !after.length) return [];
    const candidates: RefileCandidate[] = [];
    for (const item of sourceItems()) {
      if (item.filing?.filedBy === 'user') continue;
      const match = firstMatchFor(after, 'project', item);
      if (!match || item.filing?.projectId === match.target.projectId) continue;
      const was = firstMatchFor(before, 'project', item);
      if (was?.id === match.id && was.target.projectId === match.target.projectId) continue;
      candidates.push({
        item: refOf(item),
        from: item.filing,
        to: { projectId: match.target.projectId, filedBy: 'rule' },
        ruleId: match.id,
      });
    }
    return candidates;
  }
  // Block Projects: a Block's inherited Project, and the Todos that follow their Blocks.
  const blockFiling = blockFilingIn({
    db,
    readItem,
    withDetails,
    writeState,
    log,
    projects: () => projects.list(),
  });

  // Search by meaning: whoever embeds hears when something new waits, once the write is done.
  const meaningListeners = new Set<() => void>();
  let meaningHeard = false;
  const meaningPending = () => {
    if (meaningHeard) return;
    meaningHeard = true;
    queueMicrotask(() => {
      meaningHeard = false;
      for (const listener of meaningListeners) listener();
    });
  };

  // Memory: what Ares has learned, beside the Items. A memory's sources are Items, tombstones included.
  const memory = openMemory({
    db,
    sqlite,
    now,
    onMeaningPending: meaningPending,
    sources: {
      refs(itemIds) {
        const { items } = schema;
        const found = new Map<string, ItemRef>();
        for (let i = 0; i < itemIds.length; i += 500) {
          const rows = db
            .select({
              id: items.id,
              kind: items.kind,
              title: items.title,
              source: items.source,
              deletedAt: items.deletedAt,
            })
            .from(items)
            .where(inArray(items.id, itemIds.slice(i, i + 500)))
            .all();
          for (const row of rows) found.set(row.id, row);
        }
        return found;
      },
      rules: () => rules.list(),
      projects: () => projects.list({ includeArchived: true }),
      buckets: () => buckets.list(),
      people: () => people.list(),
      error: (code, message) => new ItemStoreError(code, message),
    },
  });

  // The search index follows every Item written below (insertItem and writeState).
  const search = openSearch(sqlite, {
    *allItems() {
      const { items } = schema;
      for (let after = ''; ; ) {
        const rows = db
          .select()
          .from(items)
          .where(and(isNull(items.deletedAt), sql`${items.id} > ${after}`))
          .orderBy(asc(items.id))
          .limit(500)
          .all();
        if (!rows.length) return;
        yield withDetails(rows);
        after = rows.at(-1)?.id ?? '';
      }
    },
    load(itemIds) {
      if (!itemIds.length) return [];
      return withDetails(db.select().from(schema.items).where(inArray(schema.items.id, itemIds)).all());
    },
    projects: () => projects.list(),
    // An email's text is searched too; it is kept beside the Item, not in it.
    bodyText: (itemId) => emails.readBody(itemId)?.text ?? null,
    people: () => people.list(),
    // What Ares knows, for the palette's Memory group.
    memories: (text, meaning) => memory.search(text, MEMORIES_SEARCHED, meaning),
    onMeaningPending: meaningPending,
  });

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
    const idsOf = (kind: ItemKind) => rows.filter((row) => row.kind === kind).map((row) => row.id);
    const details = new Map<string, ItemDetail>();
    const { todoDetails, dailyNoteDetails, blockDetails, linearIssueDetails, chatDetails, eventDetails } =
      schema;
    const todoIds = idsOf('todo');
    if (todoIds.length) {
      const found = db.select().from(todoDetails).where(inArray(todoDetails.itemId, todoIds)).all();
      for (const row of found) details.set(row.itemId, todoDetailOf(row));
    }
    const noteIds = idsOf('daily-note');
    if (noteIds.length) {
      const found = db.select().from(dailyNoteDetails).where(inArray(dailyNoteDetails.itemId, noteIds)).all();
      for (const row of found) details.set(row.itemId, dailyNoteDetailOf(row));
    }
    const blockIds = idsOf('block');
    if (blockIds.length) {
      const found = db.select().from(blockDetails).where(inArray(blockDetails.itemId, blockIds)).all();
      for (const row of found) details.set(row.itemId, blockDetailOf(row));
    }
    const issueIds = idsOf('linear-issue');
    if (issueIds.length) {
      const found = db
        .select()
        .from(linearIssueDetails)
        .where(inArray(linearIssueDetails.itemId, issueIds))
        .all();
      for (const row of found) details.set(row.itemId, linearIssueDetailOf(row));
    }
    const chatIds = idsOf('chat');
    if (chatIds.length) {
      const found = db.select().from(chatDetails).where(inArray(chatDetails.itemId, chatIds)).all();
      for (const row of found) details.set(row.itemId, chatDetailOf(row));
    }
    const postIds = idsOf('channel-post');
    if (postIds.length) {
      const { channelPostDetails } = schema;
      const found = db
        .select()
        .from(channelPostDetails)
        .where(inArray(channelPostDetails.itemId, postIds))
        .all();
      for (const row of found) details.set(row.itemId, channelPostDetailOf(row));
    }
    const eventIds = idsOf('event');
    if (eventIds.length) {
      const found = db.select().from(eventDetails).where(inArray(eventDetails.itemId, eventIds)).all();
      for (const row of found) details.set(row.itemId, eventDetailOf(row));
    }
    const githubIds = rows.filter((row) => GITHUB_KINDS.has(row.kind)).map((row) => row.id);
    if (githubIds.length) {
      const { githubDetails } = schema;
      const found = db.select().from(githubDetails).where(inArray(githubDetails.itemId, githubIds)).all();
      for (const row of found) details.set(row.itemId, githubDetailOf(row));
    }
    const emailIds = idsOf('email');
    if (emailIds.length)
      for (const [itemId, detail] of emails.readDetails(emailIds)) details.set(itemId, detail);
    const prepIds = idsOf('meeting-prep');
    if (prepIds.length) {
      const { meetingPrepDetails } = schema;
      const found = db
        .select()
        .from(meetingPrepDetails)
        .where(inArray(meetingPrepDetails.itemId, prepIds))
        .all();
      for (const row of found) details.set(row.itemId, meetingPrepDetailOf(row));
    }
    const summaryIds = idsOf('github-summary');
    if (summaryIds.length)
      for (const [itemId, detail] of summaries.readDetails(summaryIds)) details.set(itemId, detail);
    // The warning mark: an Item's own, or (for a Todo) the Item's behind it.
    const backedBy = (id: string) => {
      const detail = details.get(id);
      return detail?.kind === 'todo' ? detail.backedBy : null;
    };
    const marked = warnings.marked(
      rows.flatMap((row) => {
        const behind = backedBy(row.id);
        return behind ? [row.id, behind] : [row.id];
      }),
    );
    // Ares's filing suggestion waiting: the Item's own, or (for a Todo) the Item's behind it, or (for
    // a review request, or a Todo backed by one) its pull request's (#118): filing a review request
    // files its pull request, so his suggestion on the pull request is answered from either.
    const requestsBehind = new Map<string, string>();
    const unread = rows.flatMap((row) => {
      const behind = backedBy(row.id);
      return behind && !details.has(behind) ? [behind] : [];
    });
    if (unread.length) {
      const { githubDetails } = schema;
      const found = db
        .select({ itemId: githubDetails.itemId, data: githubDetails.data })
        .from(githubDetails)
        .where(inArray(githubDetails.itemId, unread))
        .all();
      for (const { itemId, data } of found)
        if (data.kind === 'review-request' && data.pullRequestId)
          requestsBehind.set(itemId, data.pullRequestId);
    }
    const pullOf = (id: string | null) => {
      if (!id) return null;
      const detail = details.get(id);
      return detail?.kind === 'review-request' ? detail.pullRequestId : (requestsBehind.get(id) ?? null);
    };
    const answeredFrom = (id: string) =>
      [id, backedBy(id), pullOf(id), pullOf(backedBy(id))].filter((each): each is string => !!each);
    const suggested = filing.suggestions(rows.flatMap((row) => answeredFrom(row.id)));
    // Ares's suggested Bucket waiting on an email (#141).
    const bucketSuggested = sortingAnswers.suggestions(emailIds);
    // Ares's waiting flag on a Chat.
    const flags = waiting.standing(rows.filter((row) => row.kind === 'chat').map((row) => row.id));
    return rows.map((row) => {
      const item = toItem(row, details.get(row.id) ?? null);
      const at = marked.get(row.id) ?? marked.get(backedBy(row.id) ?? '');
      const suggestion = answeredFrom(row.id)
        .map((id) => suggested.get(id))
        .find((each) => each !== undefined);
      const flag = flags.get(row.id);
      const bucketSuggestion = bucketSuggested.get(row.id);
      return {
        ...item,
        ...(at !== undefined && { injectionWarning: { at } }),
        ...(suggestion && { filingSuggestion: suggestion }),
        ...(bucketSuggestion && { bucketSuggestion }),
        ...(flag && { waiting: flag }),
      };
    });
  }

  // Checks the state about to be written for an Item, and returns it as stored: a Block's title is its text.
  function checked(itemId: string, kind: ItemKind, state: ItemState): ItemState {
    if (state.detail && state.detail.kind !== kind) {
      throw new ItemStoreError('invalid', `A ${kind} Item cannot have ${state.detail.kind} detail`);
    }
    if (!state.detail && NEEDS_DETAIL.has(kind)) {
      throw new ItemStoreError('invalid', `A ${kind} Item needs its ${kind} detail`);
    }
    if (state.detail?.kind !== 'block') return state;
    checkBlockPlace(itemId, state.detail);
    return { ...state, title: state.detail.text };
  }

  // A Block sits in a Daily Note, at its top or under another Block of the same note, never under itself.
  function checkBlockPlace(itemId: string, block: BlockDetail) {
    if (readItem(block.dailyNoteId)?.kind !== 'daily-note') {
      throw new ItemStoreError(
        'invalid',
        `A Block belongs to a Daily Note, and ${block.dailyNoteId} is not one`,
      );
    }
    if (block.parentId === null) return;
    const { blockDetails } = schema;
    const placeOf = (id: string) => db.select().from(blockDetails).where(eq(blockDetails.itemId, id)).get();
    if (placeOf(block.parentId)?.dailyNoteId !== block.dailyNoteId) {
      throw new ItemStoreError('invalid', "A Block's parent must be a Block of the same Daily Note");
    }
    for (
      let ancestor: string | null = block.parentId;
      ancestor !== null;
      ancestor = placeOf(ancestor)?.parentId ?? null
    ) {
      if (ancestor === itemId) throw new ItemStoreError('invalid', 'A Block cannot be moved under itself');
    }
  }

  function writeDetail(id: string, detail: ItemDetail | null) {
    const { todoDetails, dailyNoteDetails, blockDetails, linearIssueDetails, chatDetails, eventDetails } =
      schema;
    if (detail?.kind !== 'event') db.delete(eventDetails).where(eq(eventDetails.itemId, id)).run();
    if (detail?.kind !== 'chat') db.delete(chatDetails).where(eq(chatDetails.itemId, id)).run();
    if (detail?.kind !== 'channel-post')
      db.delete(schema.channelPostDetails).where(eq(schema.channelPostDetails.itemId, id)).run();
    if (detail?.kind !== 'todo') db.delete(todoDetails).where(eq(todoDetails.itemId, id)).run();
    if (detail?.kind !== 'daily-note')
      db.delete(dailyNoteDetails).where(eq(dailyNoteDetails.itemId, id)).run();
    if (detail?.kind !== 'block') db.delete(blockDetails).where(eq(blockDetails.itemId, id)).run();
    if (detail?.kind !== 'linear-issue')
      db.delete(linearIssueDetails).where(eq(linearIssueDetails.itemId, id)).run();
    emails.writeDetail(id, detail?.kind === 'email' ? detail : null);
    summaries.writeDetail(id, detail?.kind === 'github-summary' ? detail : null);
    if (detail?.kind !== 'meeting-prep')
      db.delete(schema.meetingPrepDetails).where(eq(schema.meetingPrepDetails.itemId, id)).run();
    if (isGitHubItemDetail(detail)) {
      const { githubDetails } = schema;
      const identifier =
        detail.kind === 'pull-request' || detail.kind === 'github-issue'
          ? githubIdentifier(detail.repo, detail.number)
          : null;
      db.insert(githubDetails)
        .values({ itemId: id, identifier, data: detail })
        .onConflictDoUpdate({ target: githubDetails.itemId, set: { identifier, data: detail } })
        .run();
      return;
    }
    db.delete(schema.githubDetails).where(eq(schema.githubDetails.itemId, id)).run();
    switch (detail?.kind) {
      case 'meeting-prep': {
        const { meetingPrepDetails } = schema;
        const { kind: _kind, ...data } = detail;
        const values = { eventId: detail.eventId, data };
        db.insert(meetingPrepDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: meetingPrepDetails.itemId, set: values })
          .run();
        return;
      }
      case 'todo': {
        const values = {
          origin: detail.origin,
          dueOn: detail.dueOn,
          backedBy: detail.backedBy,
          fromMessage: detail.fromMessage ?? null,
        };
        db.insert(todoDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: todoDetails.itemId, set: values })
          .run();
        return;
      }
      case 'daily-note': {
        const values = { day: detail.day };
        db.insert(dailyNoteDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: dailyNoteDetails.itemId, set: values })
          .run();
        return;
      }
      case 'linear-issue': {
        const { kind: _kind, ...data } = detail;
        const values = { identifier: detail.identifier, data };
        db.insert(linearIssueDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: linearIssueDetails.itemId, set: values })
          .run();
        return;
      }
      case 'event': {
        const { kind: _kind, ...data } = detail;
        const values = { calendarId: detail.calendar.id, ...eventRange(detail), data };
        db.insert(eventDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: eventDetails.itemId, set: values })
          .run();
        return;
      }
      case 'chat': {
        const { kind: _kind, ...data } = detail;
        db.insert(chatDetails)
          .values({ itemId: id, data })
          .onConflictDoUpdate({ target: chatDetails.itemId, set: { data } })
          .run();
        return;
      }
      case 'channel-post': {
        const { channelPostDetails } = schema;
        const { kind: _kind, ...data } = detail;
        const values = { teamId: detail.team.id, channelId: detail.channel.id, data };
        db.insert(channelPostDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: channelPostDetails.itemId, set: values })
          .run();
        return;
      }
      case 'block': {
        const { kind: _kind, ...values } = detail;
        db.insert(blockDetails)
          .values({ itemId: id, ...values })
          .onConflictDoUpdate({ target: blockDetails.itemId, set: values })
          .run();
        return;
      }
    }
  }

  // Inserts a new Item, under the caller's id if it chose one, and returns the id and the state as stored.
  function insertItem(
    identity: Pick<Item, 'kind' | 'source' | 'account' | 'externalId'>,
    input: ItemState,
    at: number,
    chosenId?: string,
  ): { id: string; state: ItemState } {
    if (chosenId && readItem(chosenId))
      throw new ItemStoreError('invalid', `The id ${chosenId} is already taken`);
    const id = chosenId ?? randomUUID();
    const state = checked(id, identity.kind, blockFiling.settled(id, identity.kind, input));
    db.insert(schema.items)
      .values({ id, ...identity, ...itemColumns(state), createdAt: at, updatedAt: at })
      .run();
    writeDetail(id, state.detail);
    search.put({ id, kind: identity.kind, account: identity.account, updatedAt: at, ...state });
    return { id, state };
  }

  // Writes an Item's new state and returns it as stored.
  function writeState(item: Item, input: ItemState, at: number): ItemState {
    const state = checked(item.id, item.kind, input);
    db.update(schema.items)
      .set({ ...itemColumns(state), updatedAt: at })
      .where(eq(schema.items.id, item.id))
      .run();
    writeDetail(item.id, state.detail);
    search.put({ id: item.id, kind: item.kind, account: item.account, updatedAt: at, ...state });
    return state;
  }

  function log(entry: NewEntry, at: number): ActivityEntry {
    const { before, after, summary } = forTheLog(entry);
    const row = db
      .insert(schema.activity)
      .values({
        at,
        ...actorColumns(entry.by),
        action: entry.action,
        itemId: entry.itemId,
        otherItemId: entry.otherItemId ?? null,
        otherProjectId: entry.otherProjectId ?? null,
        why: entry.why ?? null,
        causedByItemId: entry.causedBy?.itemId ?? null,
        causedByEntryId: entry.causedBy?.entryId ?? null,
        undoes: entry.undoes ?? null,
        before,
        after,
        summary,
      })
      .returning()
      .get();
    return toEntry(row);
  }

  // What the log keeps of an entry: a Source's changes to an Item have the detail fields the log
  // keeps only in summary (a Chat's messages) emptied, and summarised (the domain's logged-fields.ts);
  // changes made in Commander have those fields emptied only where they left them as they were.
  function forTheLog(entry: NewEntry): { before: unknown; after: unknown; summary: FieldSummary[] | null } {
    const isState = (state: unknown): state is ItemState =>
      typeof state === 'object' && state !== null && 'detail' in state;
    const { before, after } = entry;
    const itemEntry = !entry.otherItemId && !entry.otherProjectId;
    if (!itemEntry || !isState(after) || (before !== null && !isState(before))) {
      return { before, after, summary: null };
    }
    if (entry.by.kind !== 'source') {
      // Changes made in Commander: whole, but for what they left alone (a Chat's messages).
      if (!before) return { before, after, summary: null };
      const kept = withoutUntouched(before.detail, after.detail);
      if (kept.after === after.detail) return { before, after, summary: null };
      return {
        before: { ...before, detail: kept.before },
        after: { ...after, detail: kept.after },
        summary: null,
      };
    }
    const compact = compactForLog(before?.detail ?? null, after.detail);
    if (compact.summaries.length === 0) return { before, after, summary: null };
    return {
      before: before && { ...before, detail: compact.before },
      after: { ...after, detail: compact.after },
      summary: compact.summaries,
    };
  }

  // A Project as the far end of a Link: the one it was merged into, if it was.
  function projectRefOf(projectId: string): ProjectRef {
    const { projects } = schema;
    let row = db.select().from(projects).where(eq(projects.id, projectId)).get();
    for (let hops = 0; row?.mergedInto && hops < 100; hops++) {
      const into: string = row.mergedInto;
      row = db.select().from(projects).where(eq(projects.id, into)).get();
    }
    if (!row) throw new ItemStoreError('not-found', `No Project ${projectId}`);
    const { id, name, code, accent, archived } = row;
    return { kind: 'project', id, title: name, code, accent, archived };
  }

  // The Project and every Project merged into it, however many merges back.
  function projectAndMerged(projectId: string): string[] {
    const { projects } = schema;
    const ids = [projectId];
    for (let i = 0; i < ids.length; i++) {
      const merged = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.mergedInto, ids[i] as string))
        .all();
      for (const { id } of merged) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  function toLink(row: typeof schema.links.$inferSelect): Link {
    const to: LinkEnd =
      row.targetType === 'project'
        ? projectRefOf(row.toProjectId as string)
        : refOf(requireItem(row.toItemId as string));
    return { type: row.type, from: refOf(requireItem(row.fromItemId)), to, createdAt: row.createdAt };
  }

  function linksFrom(itemId: string): Link[] {
    const { links } = schema;
    return db.select().from(links).where(eq(links.fromItemId, itemId)).orderBy(links.id).all().map(toLink);
  }

  function backlinks(target: LinkTarget): Link[] {
    const { links } = schema;
    const pointsAt =
      target.targetType === 'project'
        ? and(eq(links.targetType, 'project'), inArray(links.toProjectId, projectAndMerged(target.id)))
        : and(eq(links.targetType, 'item'), eq(links.toItemId, target.id));
    return db.select().from(links).where(pointsAt).orderBy(links.id).all().map(toLink);
  }

  function findLink(link: LinkState) {
    const { links } = schema;
    const to = isProjectLink(link)
      ? and(eq(links.targetType, 'project'), eq(links.toProjectId, link.to))
      : and(eq(links.targetType, 'item'), eq(links.toItemId, link.to));
    return db
      .select()
      .from(links)
      .where(and(eq(links.fromItemId, link.from), eq(links.type, link.linkType), to))
      .get();
  }

  // The activity entry columns naming a Link's far end.
  const otherEndOf = (link: LinkState) =>
    isProjectLink(link) ? { otherProjectId: link.to } : { otherItemId: link.to };

  // Makes a Link present (link) or absent (unlink), and records it in the activity log.
  function recordLink(
    link: LinkState,
    present: boolean,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const existed = setLink(link, present, at);
    const action = present ? 'link' : 'unlink';
    const after = present ? link : null;
    const logged = log(
      { ...entry, action, itemId: link.from, ...otherEndOf(link), before: existed, after },
      at,
    );
    if (after) blockFiling.afterLink(after, logged, at);
    return logged;
  }

  /*
    Keeps a Block's `[[` links in step with its text (ADR 0002): a refers-to Link for each day, Project,
    calendar event or email token in it, and none for a token no longer there. A day's token makes that day's Daily
    Note if it has none yet. It runs whenever a Block's text is written, by anyone, so undo, redo and
    moves need nothing of their own. Other refers-to Links from the Block (to other kinds of Item) are
    left alone.
  */
  function syncBlockLinks(
    blockId: string,
    text: string,
    entry: Pick<NewEntry, 'by' | 'causedBy'>,
    at: number,
  ) {
    const { links, items } = schema;
    const why = 'A [[ link in the Block';
    const wanted = new Map<string, LinkState>();
    for (const { target } of blockLinksIn(text)) {
      if (target.type === 'project') {
        if (!projects.exists(target.projectId)) continue;
        wanted.set(`project:${target.projectId}`, {
          from: blockId,
          linkType: 'refers-to',
          to: target.projectId,
          targetType: 'project',
        });
        continue;
      }
      if (target.type === 'event') {
        // A link to a calendar event Commander holds (a tombstone too: the card says it was cancelled).
        if (readItem(target.eventId)?.kind !== 'event') continue;
        wanted.set(`item:${target.eventId}`, { from: blockId, linkType: 'refers-to', to: target.eventId });
        continue;
      }
      if (target.type === 'email') {
        // A link to one email message Commander holds (a tombstone too: the card says it is gone).
        if (readItem(target.emailId)?.kind !== 'email') continue;
        wanted.set(`item:${target.emailId}`, { from: blockId, linkType: 'refers-to', to: target.emailId });
        continue;
      }
      const note = ensureDailyNote(target.day, {
        by: entry.by,
        why: 'Linked from a Block',
        causedBy: entry.causedBy ?? undefined,
      });
      wanted.set(`item:${note.id}`, { from: blockId, linkType: 'refers-to', to: note.id });
    }
    const present = db
      .select({ targetType: links.targetType, toItemId: links.toItemId, toProjectId: links.toProjectId })
      .from(links)
      .leftJoin(items, eq(items.id, links.toItemId))
      .where(
        and(
          eq(links.fromItemId, blockId),
          eq(links.type, 'refers-to'),
          or(eq(links.targetType, 'project'), inArray(items.kind, ['daily-note', 'event', 'email'])),
        ),
      )
      .all();
    for (const row of present) {
      const project = row.targetType === 'project';
      const key = project ? `project:${row.toProjectId}` : `item:${row.toItemId}`;
      if (wanted.delete(key)) continue;
      const link: LinkState = project
        ? { from: blockId, linkType: 'refers-to', to: row.toProjectId as string, targetType: 'project' }
        : { from: blockId, linkType: 'refers-to', to: row.toItemId as string };
      recordLink(link, false, { ...entry, why }, at);
    }
    for (const link of wanted.values()) recordLink(link, true, { ...entry, why }, at);
  }

  // After an Item's state is written (from `before`, or newly made): a Block's `[[` links follow its
  // text, when that text is new or changed.
  function afterWrite(
    itemId: string,
    state: ItemState,
    entry: Pick<NewEntry, 'by' | 'causedBy'>,
    at: number,
    before: ItemState | null = null,
  ) {
    if (state.detail?.kind !== 'block') return;
    if (before?.detail?.kind === 'block' && before.detail.text === state.detail.text) return;
    syncBlockLinks(itemId, state.detail.text, entry, at);
  }

  // Linear-backed Todos (linear-todos.ts): kept in step with their issues by every change below.
  const linearTodos = linearTodosIn({
    db,
    now,
    readItems: (ids) =>
      ids.length
        ? withDetails(db.select().from(schema.items).where(inArray(schema.items.id, ids)).all())
        : [],
    change(todo, after, entry) {
      const at = now();
      const before = stateOf(todo);
      const written = writeState(todo, after, at);
      log({ ...entry, itemId: todo.id, before, after: written }, at);
    },
    create(state, issueId, entry) {
      const at = now();
      const identity = { kind: 'todo' as const, source: null, account: null, externalId: null };
      const { id, state: stored } = insertItem(identity, state, at);
      log({ ...entry, action: 'create', itemId: id, before: null, after: stored }, at);
      recordLink({ from: id, linkType: 'made-from', to: issueId }, true, entry, at);
      return id;
    },
    editState: (issue, state, entry) => editFields(issue, { state }, entry, now()),
    catalog: (account) => syncState.catalog(account),
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  // GitHub Todos (github-todos.ts): one per review asked of the User and per issue assigned to them,
  // kept in step by every change below. Who the User is on GitHub: the login Settings → GitHub read.
  const githubTodos = githubTodosIn({
    db,
    now,
    readItems: (ids) =>
      ids.length
        ? withDetails(db.select().from(schema.items).where(inArray(schema.items.id, ids)).all())
        : [],
    change(item, after, entry) {
      const at = now();
      const before = stateOf(item);
      const written = writeState(item, after, at);
      log({ ...entry, itemId: item.id, before, after: written }, at);
    },
    create(state, backingId, entry) {
      const at = now();
      const identity = { kind: 'todo' as const, source: null, account: null, externalId: null };
      const { id, state: stored } = insertItem(identity, state, at);
      log({ ...entry, action: 'create', itemId: id, before: null, after: stored }, at);
      recordLink({ from: id, linkType: 'made-from', to: backingId }, true, entry, at);
      return id;
    },
    login: (account) => githubWatch.read(account).access?.login ?? null,
  });

  function update(
    item: Item,
    changes: Partial<ItemState>,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
  ): ActivityEntry {
    const before = stateOf(item);
    const settled = blockFiling.settled(item.id, item.kind, { ...before, ...changes });
    const after = writeState(item, settled, at);
    const logged = logAndQueue(item, { ...entry, action: 'update', itemId: item.id, before, after }, at);
    filing.answer(item, before, after, logged, at);
    blockFiling.afterUpdate({ ...item, ...after }, before, logged, at);
    afterWrite(item.id, after, entry, at, before);
    afterChange(item, before, after, logged);
    return logged;
  }

  // Changes some of a Source Item's synced fields, as `edit-fields` does.
  // `skipInbox`: the User's sort into a Bucket that skips the inbox archives the email too (#142),
  // unless it came from the Source (a correction).
  function editFields(
    item: Item,
    fields: Record<string, unknown>,
    entry: Pick<NewEntry, 'by' | 'why' | 'causedBy'>,
    at: number,
    { skipInbox = true }: { skipInbox?: boolean } = {},
  ): ActivityEntry {
    const before = stateOf(item);
    const normalised = sorting.normalise(item, fields, entry.by);
    const edited = editedState(
      item,
      skipInbox ? sorting.skipping(item, normalised, entry.by) : normalised,
      (message) => new ItemStoreError('invalid', message),
    );
    // The Bucket label follows the Bucket while the Account mirrors (and only then).
    const after = writeState(item, mirror.follow(item, before, edited), at);
    const logged = logAndQueue(item, { ...entry, action: 'update', itemId: item.id, before, after }, at);
    sortingAnswers.answer(item, before, after, logged, at);
    afterChange(item, before, after, logged);
    return logged;
  }

  // What follows a change made in Commander: a ticked Linear Todo writes through to its issue, and a
  // changed issue's Todo follows it; GitHub Todos follow their pull request or issue (filed, say).
  function afterChange(item: Item, before: ItemState, after: ItemState, entry: ActivityEntry) {
    if (item.kind === 'todo') linearTodos.writeThrough(item, before, after, entry);
    if (item.kind === 'linear-issue') {
      linearTodos.follow(requireItem(item.id), before, { by: entry.by, causedBy: { entryId: entry.id } });
    }
    if (item.source === 'github') {
      githubTodos.follow(requireItem(item.id), before, { by: entry.by, causedBy: { entryId: entry.id } });
    }
  }

  const record = sqlite.transaction((input: ItemAction, rawContext: ActionContext): ActivityEntry => {
    const action = itemAction.parse(input);
    const context = actionContext.parse(rawContext);
    const at = now();
    const entry = { by: context.by, why: context.why, causedBy: context.causedBy };
    switch (action.type) {
      case 'create': {
        const { id: chosenId, kind, ...fields } = action.item;
        projects.checkFiling(fields.filing);
        const identity = { kind, source: null, account: null, externalId: null };
        const { id, state } = insertItem(identity, { ...fields, deletedAt: null }, at, chosenId);
        const created = log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
        afterWrite(id, state, entry, at);
        return created;
      }
      case 'update': {
        const item = requireItem(action.itemId);
        projects.checkFiling(action.changes.filing);
        // GitHub is read-only in v1: ticking a GitHub Todo says it changes nothing there.
        const note = entry.why ? null : githubTodos.tickNote(item, action.changes);
        const said = note ? { ...entry, why: note } : entry;
        // Filing a Linear Todo files its issue, which the Todo follows: the two never disagree. So does
        // filing a GitHub Todo (its pull request or issue) or a review request (its pull request).
        const { filing, ...rest } = action.changes;
        const issue =
          filing !== undefined ? (linearTodos.issueBehind(item) ?? githubTodos.filingTarget(item)) : null;
        if (!issue) return update(item, action.changes, said, at);
        const filed = update(issue, { filing }, entry, at);
        return Object.keys(rest).length ? update(requireItem(item.id), rest, said, at) : filed;
      }
      case 'edit-fields':
        // An email's Bucket label is Commander's to keep, following its Bucket (#142).
        if (BUCKET_MIRROR_FIELD in action.fields)
          throw new ItemStoreError(
            'invalid',
            'Commander keeps an email’s Bucket label itself, from its Bucket',
          );
        return editFields(requireItem(action.itemId), action.fields, entry, at);
      case 'delete': {
        const item = requireItem(action.itemId);
        const before = stateOf(item);
        const after: ItemState = { ...before, deletedAt: before.deletedAt ?? at };
        writeState(item, after, at);
        // An event Commander made goes from its calendar too.
        return logAndQueue(item, { ...entry, action: 'delete', itemId: item.id, before, after }, at);
      }
      case 'link':
      case 'unlink': {
        const link: LinkState = { from: action.from, linkType: action.linkType, to: action.to };
        if (action.targetType === 'project') link.targetType = 'project';
        requireItem(link.from);
        if (isProjectLink(link)) {
          if (link.linkType !== 'refers-to') {
            throw new ItemStoreError('invalid', 'Only a refers-to Link can point at a Project');
          }
          if (!projects.exists(link.to)) throw new ItemStoreError('not-found', `No Project ${link.to}`);
        } else {
          requireItem(link.to);
          if (link.from === link.to) throw new ItemStoreError('invalid', 'An Item cannot link to itself');
        }
        if (action.type === 'unlink' && !findLink(link)) {
          throw new ItemStoreError('not-found', `No ${link.linkType} Link from ${link.from} to ${link.to}`);
        }
        return recordLink(link, action.type === 'link', entry, at);
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
      const to = isProjectLink(link)
        ? { targetType: 'project' as const, toProjectId: link.to }
        : { targetType: 'item' as const, toItemId: link.to };
      db.insert(links)
        .values({ fromItemId: link.from, type: link.linkType, ...to, createdAt: at })
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
    // The User's "Not waiting on you" (or its undo): the flag comes back, or goes again.
    if (
      (target.action === 'correction' || target.action === 'undo') &&
      target.actor === 'user' &&
      waiting.isWaitingEntry(target)
    ) {
      if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) {
        throw new ItemStoreError('already-undone', `Activity entry ${entryId} is already undone`);
      }
      return waiting.undo(target, entry, at);
    }
    if (target.action === 'injection-warning') {
      throw new ItemStoreError('invalid', 'An injection warning records what Ares found; it can’t be undone');
    }
    if (
      target.action === 'correction' &&
      typeof target.before === 'object' &&
      target.before !== null &&
      'injectionWarning' in target.before
    ) {
      throw new ItemStoreError(
        'invalid',
        'Not an instruction stands while the words do; the mark comes back if they change',
      );
    }
    if (target.action === 'correction' || target.action === 'confirmation') {
      throw new ItemStoreError(
        'invalid',
        'Your answer to Ares’s filing is what he learns from; it can’t be undone',
      );
    }
    if (target.summary?.length) {
      throw new ItemStoreError('invalid', 'A change the Source made to this Item can’t be undone');
    }
    if (db.select().from(activity).where(eq(activity.undoes, entryId)).get()) {
      throw new ItemStoreError('already-undone', `Activity entry ${entryId} is already undone`);
    }
    const undoEntry = { ...entry, action: 'undo' as const, itemId: target.itemId, undoes: entryId };

    if (target.otherItemId !== null || target.otherProjectId !== null) {
      const wanted = target.before as LinkState | null;
      const link = (target.before ?? target.after) as LinkState;
      const existed = setLink(link, wanted !== null, at);
      const logged = log({ ...undoEntry, ...otherEndOf(link), before: existed, after: wanted }, at);
      if (wanted) blockFiling.afterLink(wanted, logged, at);
      return logged;
    }

    const item = requireItem(target.itemId);
    const current = stateOf(item);
    const before = target.before as ItemState | null;
    const after = target.after as ItemState;
    // A reply that reached Teams (or is on its way) can't be recalled.
    const refusal = unrecallable(outgoing, item, before, after);
    if (refusal) throw new ItemStoreError('invalid', refusal);
    // Undoing a creation deletes the Item; it stays as a tombstone so its history survives.
    let restored: ItemState = { ...current, deletedAt: at };
    if (before) {
      restored = { ...current };
      for (const change of changesBetween(before, after))
        Object.assign(restored, { [change.field]: change.before });
      // A Source Item's synced fields go back one by one, so nothing changed since is lost.
      const detail = undoneDetail(current.detail, before.detail, after.detail);
      if (detail) restored = { ...restored, detail, status: statusFromDetail(detail, restored.status) };
      restored = mirror.follow(item, current, restored);
    }
    const settled = writeState(item, blockFiling.settled(item.id, item.kind, restored), at);
    const logged = logAndQueue(item, { ...undoEntry, before: current, after: settled }, at);
    queueDeletion(item, target, current, settled, logged);
    blockFiling.afterUpdate({ ...item, ...settled }, current, logged, at);
    afterWrite(item.id, settled, entry, at, current);
    afterChange(item, current, settled, logged);
    return logged;
  }

  // A Source Item made in Commander (Send to Linear): undoing its creation deletes it at the Source
  // too, and bringing it back (redo) takes that deletion back while it hasn't been sent.
  function queueDeletion(
    item: Item,
    target: typeof schema.activity.$inferSelect,
    before: ItemState,
    after: ItemState,
    entry: ActivityEntry,
  ) {
    if (!item.source || !item.account || !item.externalId) return;
    const creation = target.action === 'create' && target.actor !== 'source';
    let value: true | null;
    if (creation && before.deletedAt === null && after.deletedAt !== null) value = true;
    else if (before.deletedAt !== null && after.deletedAt === null) value = null;
    else return;
    const { account, source, externalId } = item;
    outgoing.queue({
      account,
      source,
      itemId: item.id,
      externalId,
      field: DELETE_FIELD,
      value,
      synced: null,
      madeAt: entry.at,
      entryId: entry.id,
    });
  }

  // Logs a change, and queues what it changed in a Source Item's synced fields for the Source (Two-way
  // sync), in the same transaction.
  function logAndQueue(item: Item, entry: NewEntry, at: number): ActivityEntry {
    const refusal = onlyTheUserSends(
      item,
      entry.before as ItemState | null,
      entry.after as ItemState,
      entry.by,
    );
    if (refusal) throw new ItemStoreError('invalid', refusal);
    const logged = log(entry, at);
    queueChanges(outgoing, item, entry.before as ItemState, entry.after as ItemState, logged, (account) =>
      mirror.mirrors(account),
    );
    queueCommanderEventChanges(outgoing, item, entry.before as ItemState, entry.after as ItemState, logged);
    return logged;
  }

  const recordAll = sqlite.transaction((actions: ItemAction[], context: ActionContext): ActivityEntry[] =>
    actions.map((action) => record(action, context)),
  );

  // Snoozed threads whose time has come (#135) go back to the inbox: each snoozed message is marked
  // back from its snooze, the latest message unread, and (should the thread have left the inbox
  // meanwhile) back in the inbox. It is the User's snooze, so the change is theirs, not Ares's.
  const wakeSnoozed = sqlite.transaction((at: number): string[] => {
    const changed: string[] = [];
    for (const thread of emails.dueSnoozes(at)) {
      const messages = emails.messagesOf([thread]);
      const latest = messages.at(-1);
      const inInbox = messages.some((item) => (item.detail as EmailDetail).inInbox);
      const actions: ItemAction[] = [];
      for (const item of messages) {
        const detail = item.detail as EmailDetail;
        const fields: Record<string, unknown> = {};
        if (detail.snooze && !detail.snooze.returned && detail.snooze.until <= at)
          fields.snooze = { until: detail.snooze.until, returned: true };
        if (item === latest) {
          if (detail.read) fields.read = false;
          if (!inInbox) fields.inbox = true;
        }
        if (Object.keys(fields).length) actions.push({ type: 'edit-fields', itemId: item.id, fields });
      }
      for (const action of actions) {
        record(action, { by: { kind: 'user' }, why: 'Back from snooze' });
        if (action.type === 'edit-fields') changed.push(action.itemId);
      }
    }
    return changed;
  });

  // Send to Linear (linear-send.ts).
  const linearSend = linearSendIn({
    db,
    sqlite,
    readItem,
    insert: (identity, state, at) => insertItem(identity, state, at),
    log,
    link: (link, entry, at) => recordLink(link, true, entry, at),
    update,
    outgoing,
    linearTodos,
    catalog: (account) => syncState.catalog(account),
    catalogs() {
      const { sourceCatalogs } = schema;
      const rows = db.select().from(sourceCatalogs).where(eq(sourceCatalogs.source, 'linear')).all();
      return new Map<string, LinearCatalog | null>(
        rows.map((row) => {
          const parsed = linearCatalog.safeParse(row.catalog);
          return [row.account, parsed.success ? parsed.data : null];
        }),
      );
    },
    rules: () => rules.list(),
    projects: () => projects.list(),
    checkFiling: (filing) => projects.checkFiling(filing),
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  const sendToLinear = sqlite.transaction((draft: LinearIssueDraft, rawContext: ActionContext) => {
    const context = actionContext.parse(rawContext);
    const { activity } = schema;
    const last = db.select({ id: activity.id }).from(activity).orderBy(desc(activity.id)).limit(1).get();
    linearSend.send(draft, { by: context.by, why: context.why, causedBy: context.causedBy }, now());
    return db
      .select()
      .from(activity)
      .where(gt(activity.id, last?.id ?? 0))
      .orderBy(asc(activity.id))
      .all()
      .map(toEntry);
  });

  // Events Commander writes (commander-events.ts).
  const commanderEvents = commanderEventsIn({
    db,
    calendars,
    readItem,
    insert: (identity, state, at, chosenId) => insertItem(identity, state, at, chosenId),
    log,
    outgoing,
    checkFiling: (filing) => projects.checkFiling(filing),
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  // Messages written in Commander (compose.ts, #138).
  const compose = composeIn({
    db,
    now,
    readItem,
    insert: (identity, state, at, chosenId) => insertItem(identity, state, at, chosenId),
    writeState,
    rekey(itemId, externalId) {
      db.update(schema.items).set({ externalId }).where(eq(schema.items.id, itemId)).run();
      outgoing.rekey(itemId, externalId);
    },
    log,
    outgoing,
    emails,
    invalid: (message) => new ItemStoreError('invalid', message),
  });

  const composeApi: ComposeApi = {
    record: (itemId) => compose.record(itemId),
    save: sqlite.transaction((draft: ComposeDraft, context: ComposeContext) =>
      compose.save(draft, { ...context, by: actionContext.parse(context).by }, now()),
    ),
    send: sqlite.transaction((draft: ComposeDraft, context: ComposeContext, sendAt: number) =>
      compose.send(draft, { ...context, by: actionContext.parse(context).by }, sendAt, now()),
    ),
    undoSend: sqlite.transaction((itemId: string, rawContext: ActionContext) =>
      compose.undoSend(itemId, actionContext.parse(rawContext), now()),
    ),
    discard: sqlite.transaction((itemId: string, rawContext: ActionContext) =>
      compose.discard(itemId, actionContext.parse(rawContext), now()),
    ),
    retry: (itemId) => compose.retry(itemId),
    outbox: () => compose.outbox(now()),
    drafts: (account) => compose.drafts(account),
    answeredText: (itemId) => compose.answeredText(itemId),
    addressHistory() {
      const { emailDetails, items } = schema;
      return db
        .select({ data: emailDetails.data })
        .from(emailDetails)
        .innerJoin(items, eq(items.id, emailDetails.itemId))
        .where(and(isNull(items.deletedAt), eq(emailDetails.draft, false)))
        .all()
        .map(({ data }) => ({
          from: data.from,
          to: data.to,
          cc: data.cc,
          bcc: data.bcc,
          sentByMe: data.sentByMe,
          sentAt: data.sentAt,
        }));
    },
    attachmentsInUse: () => compose.attachmentsInUse(),
    releaseHeld: () => outgoing.releaseHeld(SEND_FIELD, now()),
    schedule: sqlite.transaction(
      (draft: ComposeDraft, context: ComposeContext, sendAt: number, heldBy: SendLaterHeldBy) =>
        compose.schedule(draft, { ...context, by: actionContext.parse(context).by }, sendAt, heldBy, now()),
    ),
    reschedule: sqlite.transaction((itemId: string, sendAt: number) =>
      compose.reschedule(itemId, sendAt, now()),
    ),
    sendScheduled: sqlite.transaction((itemId: string, rawContext: ActionContext, why?: string) =>
      compose.sendScheduled(itemId, actionContext.parse(rawContext), now(), why),
    ),
    unschedule: sqlite.transaction((itemId: string) => compose.unschedule(itemId, now())),
    miss: (itemId, at) => compose.miss(itemId, at),
    due: (at) => compose.due(at),
    nextDueAt: () => compose.nextDueAt(),
    scheduled: () => compose.scheduled(),
    missed: () => compose.missed(),
    settings: {
      read: () => compose.settings.read(),
      save: (settings) => compose.settings.save(settings, now()),
    },
    signatures: {
      read: (account) => compose.signatures.read(account),
      save: (account, body) => compose.signatures.save(account, body, now()),
    },
  };

  const createEvent = sqlite.transaction((draft: CommanderEventDraft, rawContext: ActionContext) => {
    const context = actionContext.parse(rawContext);
    return commanderEvents.create(
      draft,
      { by: context.by, why: context.why, causedBy: context.causedBy },
      now(),
    );
  });

  const moveEvent = sqlite.transaction(
    (itemId: string, move: CommanderEventMove, rawContext: ActionContext): ActivityEntry => {
      const context = actionContext.parse(rawContext);
      const item = requireItem(itemId);
      if (item.deletedAt !== null) throw new ItemStoreError('invalid', 'That event is gone');
      const detail = movedDetail(item, move, (message) => new ItemStoreError('invalid', message));
      return update(
        item,
        { detail },
        { by: context.by, why: context.why, causedBy: context.causedBy },
        now(),
      );
    },
  );

  function findDailyNote(day: string): Item | undefined {
    const { items, dailyNoteDetails } = schema;
    const row = db
      .select({ item: items })
      .from(items)
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, items.id))
      .where(eq(dailyNoteDetails.day, day))
      .get();
    return row && withDetails([row.item])[0];
  }

  // Fills a new Daily Note with copies of the template's Blocks: fresh ids, the same outline.
  function copyTemplate(dailyNoteId: string, entry: Pick<NewEntry, 'by' | 'causedBy'>, at: number) {
    const ids = new Map<string, string>();
    for (const block of inCopyOrder(template.read().blocks)) {
      const id = randomUUID();
      ids.set(block.id, id);
      const parentId = block.parentId === null ? null : (ids.get(block.parentId) ?? null);
      const { position, text, folded } = block;
      const copy: ItemState = {
        title: text,
        people: [],
        status: 'open',
        // `#LT` in the template's text files the copy under LT; the Blocks under it inherit that.
        filing: blockFiling.fromText(text),
        detail: { kind: 'block', dailyNoteId, parentId, position, text, folded },
        deletedAt: null,
      };
      const identity = { kind: 'block' as const, source: null, account: null, externalId: null };
      const { state } = insertItem(identity, copy, at, id);
      log(
        {
          ...entry,
          why: 'From the daily template',
          action: 'create',
          itemId: id,
          before: null,
          after: state,
        },
        at,
      );
      afterWrite(id, state, entry, at);
    }
  }

  const ensureDailyNote = sqlite.transaction((input: string, rawContext: ActionContext): Item => {
    const day = calendarDay.parse(input);
    const context = actionContext.parse(rawContext);
    const entry = { by: context.by, why: context.why, causedBy: context.causedBy };
    const existing = findDailyNote(day);
    if (existing && existing.deletedAt === null) return existing;
    const at = now();
    if (existing) {
      // A deleted Daily Note comes back rather than a second one being made for the same day.
      const before = stateOf(existing);
      const after = writeState(existing, { ...before, deletedAt: null }, at);
      log({ ...entry, action: 'update', itemId: existing.id, before, after }, at);
      return requireItem(existing.id);
    }
    const identity = { kind: 'daily-note' as const, source: null, account: null, externalId: null };
    const fresh: ItemState = {
      title: dayTitle(day),
      people: [],
      status: 'open',
      filing: null,
      detail: { kind: 'daily-note', day },
      deletedAt: null,
    };
    const { id, state } = insertItem(identity, fresh, at);
    log({ ...entry, action: 'create', itemId: id, before: null, after: state }, at);
    return requireItem(id);
  });

  // Whether a Daily Note has ever held a Block (deleted ones count: the User wrote in it).
  function everWritten(dailyNoteId: string): boolean {
    const { blockDetails } = schema;
    return !!db
      .select({ id: blockDetails.itemId })
      .from(blockDetails)
      .where(eq(blockDetails.dailyNoteId, dailyNoteId))
      .get();
  }

  // A Daily Note made as today starts with the template if there was none for the day at all, or if
  // the one there was made ahead of time (as a `[[day]]` link's target) and was never written in.
  const ensureFromTemplate = sqlite.transaction((input: string, rawContext: ActionContext): Item => {
    const existing = findDailyNote(calendarDay.parse(input));
    const fresh = !existing || (existing.deletedAt === null && !everWritten(existing.id));
    const note = ensureDailyNote(input, rawContext);
    if (fresh) copyTemplate(note.id, actionContext.parse(rawContext), now());
    return note;
  });

  function mentions(input: MentionQuery): Mention[] {
    const query = mentionQuery.parse(input);
    const { items, blockDetails, dailyNoteDetails } = schema;
    const found: Mention[] = [];
    for (const target of query.targets) {
      const blockIds = backlinks(target)
        .filter((link) => link.type === 'refers-to' && link.from.kind === 'block')
        .map((link) => link.from.id);
      if (!blockIds.length) continue;
      const rows = db
        .select({ item: items, day: dailyNoteDetails.day })
        .from(items)
        .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
        .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, blockDetails.dailyNoteId))
        .where(and(inArray(items.id, blockIds), isNull(items.deletedAt)))
        .orderBy(desc(dailyNoteDetails.day), asc(blockDetails.position), asc(items.id))
        .all();
      const blocksFound = withDetails(rows.map((row) => row.item));
      rows.forEach((row, i) => {
        found.push({ target, block: blocksFound[i] as Item, day: row.day });
      });
    }
    return found;
  }

  function dailyNotes(input: DailyNoteQuery = {}): DailyNotePage {
    const query = dailyNoteQuery.parse(input);
    const { items, dailyNoteDetails } = schema;
    // Live Blocks of the Daily Note in the outer query, with text when `written`.
    const liveBlocks = (written: boolean) => sql`(
      SELECT count(*) FROM block_details b JOIN items bi ON bi.id = b.item_id
      WHERE b.daily_note_id = ${items.id} AND bi.deleted_at IS NULL${written ? sql` AND b.text <> ''` : sql``}
    )`;
    const filters = and(
      isNull(items.deletedAt),
      query.from ? gte(dailyNoteDetails.day, query.from) : undefined,
      query.to ? lte(dailyNoteDetails.day, query.to) : undefined,
      query.withContent ? sql`${liveBlocks(true)} > 0` : undefined,
      query.before ? lt(dailyNoteDetails.day, query.before) : undefined,
    );
    const rows = db
      .select({ item: items, day: dailyNoteDetails.day, blocks: sql<number>`${liveBlocks(false)}` })
      .from(items)
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, items.id))
      .where(filters)
      .orderBy(desc(dailyNoteDetails.day))
      .limit(query.limit ?? 50)
      .all();
    const total =
      db
        .select({ total: sql<number>`count(*)` })
        .from(items)
        .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, items.id))
        .where(filters)
        .get()?.total ?? 0;
    const withItems = withDetails(rows.map((row) => row.item));
    return {
      notes: rows.map((row, i) => ({ item: withItems[i] as Item, day: row.day, blocks: row.blocks })),
      total,
    };
  }

  function blockTodos(input: BlockTodoQuery): BlockTodo[] {
    const query = blockTodoQuery.parse(input);
    if (!query.dailyNoteIds?.length && !query.todoIds?.length) return [];
    const { items, links, blockDetails, dailyNoteDetails } = schema;
    const blockItems = alias(items, 'block_items');
    const rows = db
      .select({ todo: items, block: blockItems, day: dailyNoteDetails.day })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .innerJoin(blockItems, eq(blockItems.id, links.toItemId))
      .innerJoin(blockDetails, eq(blockDetails.itemId, blockItems.id))
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, blockDetails.dailyNoteId))
      .where(
        and(
          eq(links.type, 'made-from'),
          eq(items.kind, 'todo'),
          isNull(items.deletedAt),
          isNull(blockItems.deletedAt),
          query.dailyNoteIds?.length ? inArray(blockDetails.dailyNoteId, query.dailyNoteIds) : undefined,
          query.todoIds?.length ? inArray(items.id, query.todoIds) : undefined,
        ),
      )
      .orderBy(asc(dailyNoteDetails.day), asc(blockDetails.position), asc(items.createdAt))
      .all();
    const todos = withDetails(rows.map((row) => row.todo));
    const blocksFound = withDetails(rows.map((row) => row.block));
    return rows.map((row, i) => ({ todo: todos[i] as Item, block: blocksFound[i] as Item, day: row.day }));
  }

  function blockIssues(dailyNoteIds: string[]): BlockIssue[] {
    if (!dailyNoteIds.length) return [];
    const { items, links, blockDetails } = schema;
    const blockItems = alias(items, 'block_items');
    const rows = db
      .select({ issue: items, blockId: blockItems.id })
      .from(links)
      .innerJoin(items, eq(items.id, links.fromItemId))
      .innerJoin(blockItems, eq(blockItems.id, links.toItemId))
      .innerJoin(blockDetails, eq(blockDetails.itemId, blockItems.id))
      .where(
        and(
          eq(links.type, 'made-from'),
          eq(items.kind, 'linear-issue'),
          isNull(items.deletedAt),
          isNull(blockItems.deletedAt),
          inArray(blockDetails.dailyNoteId, dailyNoteIds),
        ),
      )
      .orderBy(asc(links.id))
      .all();
    const issues = withDetails(rows.map((row) => row.issue));
    return rows.map((row, i) => ({ blockId: row.blockId, issue: issues[i] as Item }));
  }

  function dailyNoteProjects(): DailyNoteProjects[] {
    const rows = sqlite
      .prepare(
        `SELECT d.day AS day, bi.project_id AS projectId
         FROM block_details b
         JOIN items bi ON bi.id = b.item_id
         JOIN items ni ON ni.id = b.daily_note_id
         JOIN daily_note_details d ON d.item_id = b.daily_note_id
         WHERE bi.deleted_at IS NULL AND ni.deleted_at IS NULL AND b.text <> ''
         GROUP BY d.day, bi.project_id
         ORDER BY d.day DESC, bi.project_id`,
      )
      .all() as { day: string; projectId: string | null }[];
    const byDay = new Map<string, DailyNoteProjects>();
    for (const { day, projectId } of rows) {
      const found = byDay.get(day) ?? { day, projectIds: [], unfiled: false };
      byDay.set(day, found);
      if (projectId) found.projectIds.push(projectId);
      else found.unfiled = true;
    }
    return [...byDay.values()];
  }

  function projectBlocks(projectId: string): ProjectBlock[] {
    const { items, blockDetails, dailyNoteDetails } = schema;
    const notes = db
      .selectDistinct({ id: blockDetails.dailyNoteId, day: dailyNoteDetails.day })
      .from(items)
      .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
      .innerJoin(dailyNoteDetails, eq(dailyNoteDetails.itemId, blockDetails.dailyNoteId))
      .where(and(eq(items.projectId, projectId), isNull(items.deletedAt), sql`${blockDetails.text} <> ''`))
      .orderBy(desc(dailyNoteDetails.day))
      .limit(200)
      .all();
    const all = blocks(notes.map((note) => note.id));
    return notes.flatMap(({ id, day }) => {
      const children = new Map<string | null, Item[]>();
      for (const block of all) {
        if (block.detail?.kind !== 'block' || block.detail.dailyNoteId !== id) continue;
        const siblings = children.get(block.detail.parentId) ?? [];
        children.set(block.detail.parentId, [...siblings, block]);
      }
      const found: ProjectBlock[] = [];
      const walk = (parentId: string | null) => {
        for (const block of children.get(parentId) ?? []) {
          const text = block.detail?.kind === 'block' ? block.detail.text : '';
          if (block.filing?.projectId === projectId && text !== '') found.push({ block, day });
          walk(block.id);
        }
      };
      walk(null);
      return found;
    });
  }

  function blocks(dailyNoteIds: string[]): Item[] {
    if (!dailyNoteIds.length) return [];
    const { items, blockDetails } = schema;
    const rows = db
      .select({ item: items })
      .from(items)
      .innerJoin(blockDetails, eq(blockDetails.itemId, items.id))
      .where(and(inArray(blockDetails.dailyNoteId, dailyNoteIds), isNull(items.deletedAt)))
      .orderBy(asc(blockDetails.dailyNoteId), asc(blockDetails.position), asc(items.id))
      .all();
    return withDetails(rows.map((row) => row.item));
  }

  const saveFromSource = sqlite.transaction((input: SourceBatch): SaveResult => {
    const batch = sourceBatch.parse(input);
    const by: Actor = { kind: 'source', source: batch.source, account: batch.account };
    const result: SaveResult = { created: [], updated: [], tombstoned: [], unchanged: [], todos: [] };
    const active = rules.list();
    if (batch.me !== undefined) linearTodos.remember(batch.account, batch.me);
    linearTodos.takeChanged();
    githubTodos.takeChanged();
    const applyRules = (itemId: string, at: number) => {
      const item = requireItem(itemId);
      const filed = ruleFiling(item, active);
      if (filed) fileByRule(item, filed, at);
      // An email goes to its first matching Bucket Rule's Bucket too (#137).
      sorting.applyOnSave(requireItem(itemId), active, at);
    };
    // The Item's Todo (a Linear or GitHub Todo) follows it, once it is filed.
    const follow = (itemId: string, before: ItemState | null, entryId?: number) => {
      const entry = { by, causedBy: entryId ? { entryId } : null };
      linearTodos.follow(requireItem(itemId), before, entry);
      githubTodos.follow(requireItem(itemId), before, entry);
    };
    // Emails are threaded among the Account's mail as they arrive; mail already held that they join
    // to another thread is saved along with them.
    const threaded = emails.thread(batch.source, batch.account, batch.items);
    // What the steering check reads beyond the Item: an email's body, from its start.
    const bodyWords = (item: Item) =>
      item.kind === 'email' ? (emails.readBody(item.id)?.text ?? '').slice(0, STEERING_BODY_CHECKED) : '';
    for (const handed of [...threaded.items, ...threaded.moved]) {
      const at = now();
      const incoming = withItemRefs(batch.source, batch.account, handed);
      const existing = sourceIdentityOf(batch.source, batch.account, incoming, at);
      if (existing && existing.deletedAt !== null && outgoing.queued(existing.id, DELETE_FIELD)) {
        // Deleted in Commander (an undone Send to Linear), on its way to being deleted at the Source.
        result.unchanged.push(existing.id);
        continue;
      }
      if (existing) {
        const before = stateOf(existing);
        // Commander's own Bucket label still on its way: the Source's labels aren't a correction (#142).
        const mirrorQueued = existing.kind === 'email' && outgoing.queued(existing.id, BUCKET_MIRROR_FIELD);
        const after: ItemState = {
          ...before,
          title: incoming.title,
          people: incoming.people,
          deletedAt: null,
          // Changes made in Commander still on their way to the Source stay on top.
          ...withQueuedOnTop(
            outgoing,
            existing.id,
            {
              status: incoming.status,
              detail: stillSending(existing, stillCommanders(existing.detail, incoming.detail)),
            },
            before.detail,
          ),
        };
        // An email's bodies, beside it: written first, so the search index reads them.
        const bodyChanged = incoming.body ? emails.writeBody(existing.id, incoming.body) : false;
        if (isDeepStrictEqual(before, after)) {
          if (bodyChanged) {
            const { kind, account } = existing;
            search.put({ id: existing.id, kind, account, updatedAt: existing.updatedAt, ...before });
          }
          result.unchanged.push(existing.id);
          // Still judged: who the User is may be newly known, or the issue's cycle may be over.
          follow(existing.id, before);
          // And still checked, so an Item saved before the steering check gets its mark.
          warnings.check(existing, at, null, bodyWords(existing));
          continue;
        }
        writeState(existing, after, at);
        const logged = log({ by, why: batch.why, action: 'update', itemId: existing.id, before, after }, at);
        // A Commander label changed at the Source moves the email's Bucket, as the User (#142).
        if (!mirrorQueued) mirror.correct(requireItem(existing.id), before.detail, incoming.detail, at);
        applyRules(existing.id, at);
        follow(existing.id, before, logged.id);
        warnings.check(requireItem(existing.id), at, logged.id, bodyWords(existing));
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
      // An email's bodies go in first, under the id it is about to get, so its first indexing reads them.
      const newId = randomUUID();
      if (incoming.body) emails.writeBody(newId, incoming.body);
      const { id, state: stored } = insertItem(identity, state, at, newId);
      const logged = log(
        { by, why: batch.why, action: 'create', itemId: id, before: null, after: stored },
        at,
      );
      applyRules(id, at);
      follow(id, null, logged.id);
      warnings.check(requireItem(id), at, logged.id, bodyWords(requireItem(id)));
      result.created.push(id);
    }
    for (const externalId of batch.deleted) {
      const existing = findBySourceIdentity(batch.source, batch.account, externalId);
      if (!existing || existing.deletedAt !== null) continue;
      // A message written in Commander, sent, still under the id of the draft it was (#138): the draft
      // going is its sending, not the message's deletion. The sent copy's sync names it again. So too a
      // message Microsoft holds for later (#139), gone from Drafts into Exchange's Outbox.
      if (
        existing.kind === 'email' &&
        existing.detail?.kind === 'email' &&
        ((!existing.detail.draft && compose.record(existing.id)?.sendAt) ||
          compose.heldByMicrosoft(existing.id))
      )
        continue;
      const at = now();
      const before = stateOf(existing);
      const after: ItemState = { ...before, deletedAt: at };
      writeState(existing, after, at);
      // A tombstone keeps its Links and history, not an email's bodies.
      if (existing.kind === 'email') emails.deleteBodies([existing.id]);
      const logged = log({ by, action: 'tombstone', itemId: existing.id, before, after }, at);
      linearTodos.follow(requireItem(existing.id), before, { by, causedBy: { entryId: logged.id } }, true);
      githubTodos.follow(requireItem(existing.id), before, { by, causedBy: { entryId: logged.id } }, true);
      result.tombstoned.push(existing.id);
    }
    result.todos = [...new Set([...linearTodos.takeChanged(), ...githubTodos.takeChanged()])];
    // Who the Source said its people are: matched into People in the same transaction.
    people.seen(batch.items.flatMap((item) => identitiesOf(item)));
    return result;
  });

  // A database from before People existed: its Items' people are matched once, as it opens.
  if (people.empty()) {
    sqlite.transaction(() => {
      const { items } = schema;
      for (let after = ''; ; ) {
        const rows = db
          .select()
          .from(items)
          .where(and(sql`${items.people} <> '[]'`, sql`${items.id} > ${after}`))
          .orderBy(asc(items.id))
          .limit(500)
          .all();
        if (!rows.length) break;
        people.seen(withDetails(rows).flatMap((item) => identitiesOf(item)));
        after = rows.at(-1)?.id ?? '';
      }
    })();
  }

  // A GitHub review request names its pull request's Item by id: filled in from the pull request's
  // external id in the same Account (saved before it in the batch, or by an earlier sync).
  function withItemRefs<T extends { detail: ItemDetail | null }>(
    source: Source,
    account: string,
    item: T,
  ): T {
    if (item.detail?.kind !== 'review-request') return item;
    const pull = findBySourceIdentity(source, account, item.detail.pullRequest);
    return { ...item, detail: { ...item.detail, pullRequestId: pull?.id ?? null } };
  }

  // An event Commander made, still under its placeholder external id, that the Source now has (its
  // answer to the create, or a sync that got there first): the same Item, re-keyed to the Source's id,
  // with its queued changes. Only ever an event of the same Source and Account that hasn't reached it.
  function madeInCommander(
    source: Source,
    account: string,
    incoming: { externalId: string; commanderItemId?: string | undefined },
  ): Item | undefined {
    if (!incoming.commanderItemId) return undefined;
    const made = readItem(incoming.commanderItemId);
    if (
      made?.kind !== 'event' ||
      made.source !== source ||
      made.account !== account ||
      !isPendingEventExternalId(made.externalId)
    ) {
      return undefined;
    }
    db.update(schema.items)
      .set({ externalId: incoming.externalId })
      .where(eq(schema.items.id, made.id))
      .run();
    outgoing.rekey(made.id, incoming.externalId);
    return { ...made, externalId: incoming.externalId };
  }

  // The Item a Source Item is: the one holding its external id, or one Commander made that the Source
  // now has (an event, or a message written in Commander).
  function sourceIdentityOf(
    source: Source,
    account: string,
    incoming: z.output<typeof sourceBatch>['items'][number],
    at: number,
  ): Item | undefined {
    const found = findBySourceIdentity(source, account, incoming.externalId);
    return (
      writtenInCommander(source, account, incoming, found, at) ??
      found ??
      madeInCommander(source, account, incoming)
    );
  }

  // A message written in Commander (#138) that the Source now has: its draft or the sent message, as the
  // Source's answer names it (`commanderItemId`), or (a crash came between sending and saving that
  // answer) as a sync brings it, matched by its Message-ID. The same Item takes the Source's id, so the
  // message shows once in its thread. Should a copy have been saved as an Item of its own first, that
  // copy gives way (a tombstone) to the message's Item.
  function writtenInCommander(
    source: Source,
    account: string,
    incoming: z.output<typeof sourceBatch>['items'][number],
    found: Item | undefined,
    at: number,
  ): Item | undefined {
    if (incoming.detail?.kind !== 'email') return undefined;
    let target: Item | null = null;
    if (incoming.commanderItemId) {
      const named = readItem(incoming.commanderItemId);
      if (
        named?.kind === 'email' &&
        named.source === source &&
        named.account === account &&
        compose.record(named.id)
      )
        target = named;
    } else if (!found) target = compose.matchMessage(source, account, incoming.detail.messageId);
    if (!target) return undefined;
    if (incoming.commanderItemId && incoming.detail.draft && incoming.body)
      compose.answered(target.id, incoming.body.text);
    if (found?.id === target.id) return found;
    if (found) {
      // The copy saved first goes, out of the way of the identity.
      const before = stateOf(found);
      db.update(schema.items)
        .set({ externalId: `superseded:${found.id}` })
        .where(eq(schema.items.id, found.id))
        .run();
      const gone = { ...found, externalId: `superseded:${found.id}` };
      const after = writeState(gone, { ...before, deletedAt: before.deletedAt ?? at }, at);
      emails.deleteBodies([found.id]);
      log(
        { by: { kind: 'source', source, account }, action: 'tombstone', itemId: found.id, before, after },
        at,
      );
    }
    db.update(schema.items)
      .set({ externalId: incoming.externalId })
      .where(eq(schema.items.id, target.id))
      .run();
    outgoing.rekey(target.id, incoming.externalId);
    return { ...target, externalId: incoming.externalId };
  }

  // A message on its way to the Source stays sent, whatever a late answer to saving its draft says (but
  // one Microsoft is to hold for later stays unsent until it goes, #139).
  function stillSending(held: Item, incoming: ItemDetail | null): ItemDetail | null {
    if (incoming?.kind !== 'email' || !incoming.draft || !outgoing.queued(held.id, SEND_FIELD))
      return incoming;
    if (compose.heldByMicrosoft(held.id)) return incoming;
    const { draft: _draft, ...sent } = incoming;
    return held.detail?.kind === 'email' ? { ...sent, sentAt: held.detail.sentAt } : sent;
  }

  // An event Commander made stays marked as its own, even if the Source's copy has lost the marker.
  function stillCommanders(held: ItemDetail | null, incoming: ItemDetail | null): ItemDetail | null {
    if (held?.kind !== 'event' || incoming?.kind !== 'event') return incoming;
    if (!held.createdByCommander || incoming.createdByCommander) return incoming;
    return { ...incoming, createdByCommander: held.createdByCommander };
  }

  // Deletes Items as one change: they stay as tombstones, so Links to them show them as gone.
  function removeItems(found: Item[], context: ActionContext): string[] {
    const removed = found.map((item) => {
      const at = now();
      const before = stateOf(item);
      const after: ItemState = { ...before, deletedAt: at };
      writeState(item, after, at);
      log({ ...context, action: 'delete', itemId: item.id, before, after }, at);
      return item.id;
    });
    // Removed mail (an Account's, when it is removed) takes its bodies with it.
    emails.deleteBodies(found.filter((item) => item.kind === 'email').map((item) => item.id));
    return removed;
  }

  const liveSourceItems = (source: Source, account: string) => {
    const { items } = schema;
    const rows = db
      .select()
      .from(items)
      .where(and(eq(items.source, source), eq(items.account, account), isNull(items.deletedAt)))
      .all();
    return withDetails(rows);
  };

  const chatSettings = chatSettingsIn(db, {
    now,
    findChat: (account, chatId) => findBySourceIdentity('teams', account, chatId) ?? null,
    deleteItem: (itemId, context) => record({ type: 'delete', itemId }, context),
  });

  const channelSettings = channelSettingsIn(db, {
    now,
    deleteItem: (itemId, context) => record({ type: 'delete', itemId }, context),
  });

  const removeAccountItems = sqlite.transaction(
    ({ source, account }: { source: Source; account: string }, rawContext: ActionContext): string[] => {
      chatSettings.removeAccount(account);
      channelSettings.removeAccount(account);
      mirror.removeAccount(account);
      return removeItems(liveSourceItems(source, account), actionContext.parse(rawContext));
    },
  );

  const autonomy = openAutonomyStore(db, now);
  const agent = openAgentStore(db, now);
  const models = openModelStore(db, now);
  const githubWatch = githubWatchIn(db, {
    now,
    transaction: (fn) => sqlite.transaction(fn)(),
    liveItems: (account) => liveSourceItems('github', account),
    removeItems: (found, why) => removeItems(found, { by: { kind: 'user' }, why }),
  });

  const meetingChips = meetingChipsIn({
    db,
    now,
    readItem,
    withDetails,
    findDailyNote,
    create(id, state, entry) {
      const at = now();
      const identity = { kind: 'block' as const, source: null, account: null, externalId: null };
      const { state: stored } = insertItem(identity, state, at, id);
      log({ ...entry, action: 'create', itemId: id, before: null, after: stored }, at);
      afterWrite(id, stored, entry, at);
    },
    update: (item, changes, entry) => update(item, changes, entry, now()),
    remove(item, entry) {
      const at = now();
      const before = stateOf(item);
      const after: ItemState = { ...before, deletedAt: before.deletedAt ?? at };
      writeState(item, after, at);
      log({ ...entry, action: 'delete', itemId: item.id, before, after }, at);
    },
    transaction: (fn) => sqlite.transaction(fn)(),
  });

  return {
    models,
    syncState,
    outgoing,
    autonomy,
    agent,
    dashboard: openDashboardStore(db, {
      agent,
      autonomy,
      readItem: (id) =>
        withDetails(db.select().from(schema.items).where(eq(schema.items.id, id)).all())[0] ?? null,
    }),
    updates: openUpdateStore(db),
    conversations: openConversationStore(db, now),
    emailSorting: sortingAnswers.store,
    suggestedReplies,
    filing: {
      ...filing.store,
      decline: sqlite.transaction((itemId: string, suggestedProjectId: string, rawContext: ActionContext) => {
        requireItem(itemId);
        return filing.decline(itemId, suggestedProjectId, actionContext.parse(rawContext).by, now());
      }),
    },
    injectionWarnings: {
      flag: sqlite.transaction((itemId: string, quote: string) => warnings.flag(itemId, quote)),
      since: (after) => warnings.since(after),
      warning: (itemId) => warnings.warning(itemId),
      clear: sqlite.transaction((itemId: string, rawContext: ActionContext) => {
        try {
          return warnings.clear(itemId, actionContext.parse(rawContext));
        } catch (error) {
          if (error instanceof InjectionWarningError) throw new ItemStoreError('invalid', error.message);
          throw error;
        }
      }),
    },
    search: { query: (query, meaning) => search.query(query, meaning) },
    // Memories first (few, and what Ares's jobs look up), then Items; a memory's key is marked as one.
    meaning: {
      pending(model, limit) {
        const memories = memory.meaning
          .pending(model, limit)
          .map((work) => ({ ...work, key: `${MEMORY_KEY}${work.key}` }));
        return [...memories, ...search.meaning.pending(model, limit - memories.length)];
      },
      save(model, done) {
        const isMemory = (work: EmbeddedWork) => work.key.startsWith(MEMORY_KEY);
        memory.meaning.save(
          model,
          done.filter(isMemory).map((work) => ({ ...work, key: work.key.slice(MEMORY_KEY.length) })),
        );
        search.meaning.save(
          model,
          done.filter((work) => !isMemory(work)),
        );
      },
      progress(model) {
        const items = search.meaning.progress(model);
        const memories = memory.meaning.progress(model);
        return { embedded: items.embedded + memories.embedded, total: items.total + memories.total };
      },
      onPending(listener) {
        meaningListeners.add(listener);
        return () => meaningListeners.delete(listener);
      },
    },
    memory: {
      ...memory,
      learn: sqlite.transaction((input: Parameters<MemoryStore['learn']>[0]) => memory.learn(input)),
      change: sqlite.transaction((action: Parameters<MemoryStore['change']>[0]) => memory.change(action)),
      saveProgress: sqlite.transaction((name: string, value: number) => memory.saveProgress(name, value)),
    },

    saveFromSource,
    removeAccountItems,

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
            query.ids ? inArray(items.id, query.ids) : undefined,
            query.projectId === null ? isNull(items.projectId) : undefined,
            query.projectId ? eq(items.projectId, query.projectId) : undefined,
            query.source ? eq(items.source, query.source) : undefined,
            query.account ? eq(items.account, query.account) : undefined,
            query.statuses ? inArray(items.status, query.statuses) : undefined,
            query.people?.length
              ? sql`EXISTS (SELECT 1 FROM json_each(${items.people}) WHERE lower(json_each.value) IN (${sql.join(
                  query.people.map((handle) => sql`${handle.toLowerCase()}`),
                  sql`, `,
                )}))`
              : undefined,
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
      return { item, links: linksFrom(itemId), backlinks: backlinks({ targetType: 'item', id: itemId }) };
    },

    link(link, context) {
      return record({ type: 'link', ...link }, context);
    },

    backlinks,
    mentions,

    record,
    recordAll,
    sendToLinear,
    linearSendPrefill: (request) => linearSend.prefill(request),
    createEvent,
    moveEvent,
    busyCopies: commanderEvents.busyCopies,
    focusSettings: focusSettingsIn(db, now),
    schedulingSettings: schedulingSettingsIn(db, now),
    ensureDailyNote: (day, context, options) =>
      options?.fromTemplate ? ensureFromTemplate(day, context) : ensureDailyNote(day, context),
    dailyNotes,
    blocks,
    dailyTemplate: () => template.read(),
    saveDailyTemplate: (input) => template.save(input),
    blockTodos,
    blockIssues,
    dailyNoteProjects,
    projectBlocks,
    recheckIds: (account) => linearTodos.recheckIds(account),
    linearTodosLeft: (after) => linearTodos.leftSince(after),
    externalIds: ({ source, account }) => emails.externalIds(source, account),
    emailThreads: (query) => emails.threads(query),
    emailThread(account, threadKey) {
      const thread = emails.threadView(account, threadKey);
      return thread && { ...thread, suggestedReply: suggestedReplies.forThread(thread) };
    },
    emailBody: (itemId) => emails.readBody(itemId),
    compose: composeApi,
    emailViews: (query) => emails.viewCounts(query),
    emailSearch: (query) => emails.searchThreads(query),
    emailLabels: (account) => emails.labelsOf(account),
    wakeSnoozed: (at) => wakeSnoozed(at),
    nextSnoozeAt: () => emails.nextSnoozeAt(),

    fromSource({ source, account }, externalIds) {
      const { items } = schema;
      const found: Item[] = [];
      for (let i = 0; i < externalIds.length; i += 500) {
        const rows = db
          .select()
          .from(items)
          .where(
            and(
              eq(items.source, source),
              eq(items.account, account),
              inArray(items.externalId, externalIds.slice(i, i + 500)),
              isNull(items.deletedAt),
            ),
          )
          .all();
        found.push(...withDetails(rows));
      }
      return found;
    },

    events: (query) => withDetails(eventRows(db, query)),
    meetingPreps(eventIds) {
      if (!eventIds.length) return [];
      const { items, meetingPrepDetails } = schema;
      const rows = db
        .select({ item: items })
        .from(meetingPrepDetails)
        .innerJoin(items, eq(items.id, meetingPrepDetails.itemId))
        .where(and(inArray(meetingPrepDetails.eventId, eventIds), isNull(items.deletedAt)))
        .orderBy(desc(items.updatedAt))
        .all();
      // One per event: the newest, should there ever be two.
      const seen = new Set<string>();
      return withDetails(rows.map((row) => row.item)).filter((item) => {
        const eventId = item.detail?.kind === 'meeting-prep' ? item.detail.eventId : null;
        if (!eventId || seen.has(eventId)) return false;
        seen.add(eventId);
        return true;
      });
    },
    invitations: () => {
      const at = now();
      return withDetails(eventRows(db, { from: at, to: at + INVITATIONS_AHEAD_MS, limit: 5000 })).filter(
        (item) => awaitingAnswer(item, at),
      );
    },

    calendars,
    meetingChips,
    calendarSettings: calendarSettingsIn(db, now),
    emailImages: emailImagesIn(db, now),

    calendarEvents: (account, calendarId) => withDetails(calendarEventRows(db, { ...account, calendarId })),

    setCalendarOn: sqlite.transaction(
      (
        { account, calendarId, on }: { account: string; calendarId: string; on: boolean },
        rawContext: ActionContext,
      ): CalendarSummary[] => {
        const context = actionContext.parse(rawContext);
        const calendar = calendars.get(account, calendarId);
        if (!calendar || !calendars.setOn(account, calendarId, on)) {
          throw new ItemStoreError('not-found', `No calendar ${calendarId} in ${account}`);
        }
        if (!on) {
          const why = `Calendar “${calendar.name}” switched off`;
          const rows = calendarEventRows(db, { source: calendar.source, account, calendarId });
          for (const item of withDetails(rows)) {
            const at = now();
            const before = stateOf(item);
            const after: ItemState = { ...before, deletedAt: at };
            writeState(item, after, at);
            log({ ...context, why, action: 'delete', itemId: item.id, before, after }, at);
          }
        }
        return calendars.list();
      },
    ),

    activity(input = {}) {
      const query = activityQuery.parse(input);
      const { activity } = schema;
      return db
        .select()
        .from(activity)
        .where(
          and(
            query.itemId
              ? or(eq(activity.itemId, query.itemId), eq(activity.otherItemId, query.itemId))
              : undefined,
            query.after !== undefined ? gt(activity.id, query.after) : undefined,
          ),
        )
        .orderBy(desc(activity.id))
        .limit(query.limit ?? 200)
        .all()
        .map(toEntry);
    },

    projects: (query) => projects.list(query),

    changeProject: sqlite.transaction((action: ProjectAction) => projects.change(action)),

    rules: () => rules.list(),

    changeRule: sqlite.transaction((action: RuleAction): RuleChange => {
      const change = rules.change(action);
      // Deleting a Rule leaves Items where they are, and so does bringing it back.
      const leavesItems = action.type === 'delete' || action.type === 'restore';
      return {
        rule: change.rule,
        refile: leavesItems ? [] : refileCandidates(change),
        resort: leavesItems ? [] : sorting.resortCandidates(change),
      };
    }),

    ruleValues: () => githubWatchRuleValues(githubWatch.list()),

    previewRule(input) {
      const request = rulePreviewRequest.parse(input);
      const { kind } = request.rule.target;
      // A Bucket Rule sorts email only; and only Rules of the same kind of target decide between them.
      const matching = sourceItems().filter(
        (item) => (kind !== 'bucket' || item.kind === 'email') && ruleMatches(request.rule.when, item),
      );
      const overlaps = rulesFor(rules.list(), kind).filter(
        (rule) => rule.id !== request.ruleId && matching.some((item) => ruleMatches(rule.when, item)),
      );
      return {
        count: matching.length,
        sample: matching.slice(0, request.sampleSize ?? 8).map(refOf),
        overlaps,
      };
    },

    refile: sqlite.transaction((itemIds: string[]): ActivityEntry[] => {
      const active = rules.list();
      const entries: ActivityEntry[] = [];
      for (const itemId of new Set(itemIds)) {
        const item = readItem(itemId);
        if (!item || item.source === null || item.deletedAt !== null) continue;
        const filed = ruleFiling(item, active);
        if (!filed) continue;
        const logged = fileByRule(item, filed, now());
        entries.push(logged);
        linearTodos.follow(requireItem(item.id), stateOf(item), {
          by: logged.by,
          causedBy: { entryId: logged.id },
        });
        githubTodos.follow(requireItem(item.id), stateOf(item), {
          by: logged.by,
          causedBy: { entryId: logged.id },
        });
      }
      return entries;
    }),

    resort: sqlite.transaction((itemIds: string[]): ActivityEntry[] => sorting.resort(itemIds)),

    undoResort: sqlite.transaction((entryIds: number[]): ActivityEntry[] => sorting.undoResort(entryIds)),

    buckets: () => buckets.list(),

    changeBucket: sqlite.transaction((action: BucketAction): BucketChange => {
      const was = action.type === 'update' ? buckets.get(action.bucketId) : undefined;
      const change = sorting.change(action);
      // A renamed Bucket's label is renamed at the Source; a removed (or restored) one's follows (#142).
      if (was && change.bucket && change.bucket.name !== was.name) mirror.renamed(was.id, change.bucket.name);
      if (action.type === 'delete' || action.type === 'restore') mirror.touched();
      return change;
    }),
    bucketMirror: {
      list: () => mirror.list(),
      set: sqlite.transaction((change: Parameters<BucketMirrorStore['set']>[0]) => mirror.set(change)),
      mirrors: (account) => mirror.mirrors(account),
      plan: (account) => mirror.plan(account),
      planDone: sqlite.transaction((account: string, plan: MirrorPlan) => mirror.planDone(account, plan)),
      removeAccount: sqlite.transaction((account: string) => mirror.removeAccount(account)),
      onChange: (listener) => mirror.onChange(listener),
    },

    undoRefile: sqlite.transaction((entryIds: number[]): ActivityEntry[] =>
      undoFilings(entryIds, 'Undid re-filing by Rules', true),
    ),

    entry(entryId) {
      const row = db.select().from(schema.activity).where(eq(schema.activity.id, entryId)).get();
      return row ? toEntry(row) : null;
    },

    undone(entryIds) {
      if (!entryIds.length) return [];
      const { activity } = schema;
      return db
        .select({ undoes: activity.undoes })
        .from(activity)
        .where(inArray(activity.undoes, entryIds))
        .all()
        .map((row) => row.undoes as number);
    },

    transaction<T>(fn: () => T): T {
      return sqlite.transaction(fn)();
    },

    takeDailySnapshot() {
      const snapshot = takeDailySnapshot(sqlite, options.snapshotDir, now());
      // Looking after the images must never cost the snapshot (or the Core) itself.
      try {
        if (snapshot)
          attachments.afterSnapshot(sqlite, keptSnapshots(options.snapshotDir), options.snapshotDir);
      } catch (error) {
        console.warn('Could not snapshot or tidy the attachments:', error);
      }
      return snapshot;
    },

    saveAttachment: (bytes) => attachments.save(bytes),

    projectRef(projectId) {
      try {
        return projectRefOf(projectId);
      } catch (error) {
        if (error instanceof ItemStoreError && error.code === 'not-found') return null;
        throw error;
      }
    },

    markdownCopyFolder: markdownCopyFolderIn(db, now),
    chatSettings: {
      list: (account) => chatSettings.list(account),
      change: sqlite.transaction((action: ChatSettingAction, context: ActionContext) =>
        chatSettings.change(action, context),
      ),
      excluded: (account) => chatSettings.excluded(account),
      removeAccount: (account) => chatSettings.removeAccount(account),
    },
    channelSettings: {
      list: (account) => channelSettings.list(account),
      excluded: (account) => channelSettings.excluded(account),
      choices: () => channelSettings.choices(),
      change: sqlite.transaction((action: ChannelSettingAction, context: ActionContext) =>
        channelSettings.change(action, context),
      ),
      removeAccount: (account) => channelSettings.removeAccount(account),
    },

    githubWatch,
    githubDiscussions: githubDiscussionsIn(db),
    githubSummaries: {
      list: (query) => summaries.list(query),
      writtenFor: (cadence, day) => summaries.writtenFor(cadence, day),
      lastDailyTo: () => summaries.lastDailyTo(),
      markSeen: (itemId) => summaries.markSeen(itemId),
      paragraphs: () => summaries.paragraphs(),
    },
    githubOversight: githubOversightIn(db, {
      now,
      withDetails: (rows) => withDetails(rows),
      projects: () => projects.list({ includeArchived: true }),
      people: () => people.list(),
    }),

    chatWaiting: {
      judgedThrough: (itemId) => waiting.judgedThrough(itemId),
      judged: (itemId, through) => waiting.judged(itemId, through),
      flagged: () => waiting.flagged(),
      flag: (itemId, flag, at) => waiting.flag(itemId, flag, at),
      clear: (itemId, by, at) => waiting.clear(itemId, by, at),
      clearByUser: sqlite.transaction((itemId: string, rawContext: ActionContext) => {
        requireItem(itemId);
        try {
          return waiting.clearByUser(itemId, actionContext.parse(rawContext));
        } catch (error) {
          if (error instanceof ChatWaitingError) throw new ItemStoreError('invalid', error.message);
          throw error;
        }
      }),
    },

    people: {
      ...people,
      change: sqlite.transaction((action: Parameters<PeopleStore['change']>[0]) => people.change(action)),
      seen: sqlite.transaction((identities: Parameters<PeopleStore['seen']>[0]) => people.seen(identities)),
      recogniseUser: sqlite.transaction((accounts: Parameters<PeopleStore['recogniseUser']>[0]) =>
        people.recogniseUser(accounts),
      ),
    },

    close() {
      sqlite.close();
    },
  };
}
