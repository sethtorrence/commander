import { z } from 'zod';
import { type DashboardClears, type DashboardState, dashboardClears, dashboardState } from './ares-ranking';
import { attachmentMaxBytes, attachmentNamePattern } from './attachments';
import {
  type CalendarSettings,
  type CalendarSummary,
  calendarSettings,
  calendarSummary,
  eventQuery,
} from './calendar';
import { commanderEventDraft } from './commander-events';
import { type DailyTemplate, dailyTemplate } from './daily-template';
import type { EmailLabel } from './email';
import {
  type EmailSearchResult,
  type EmailThread,
  type EmailThreadList,
  type EmailViewCounts,
  emailLabelList,
  emailSearchQuery,
  emailSearchResult,
  emailThread,
  emailThreadList,
  emailThreadQuery,
  emailViewCounts,
  emailViewQuery,
} from './email-threads';
import { type FocusSettings, focusSettings } from './focus-time';
import {
  type OversightSettings,
  type OversightSummary,
  oversightRangeSpan,
  oversightSettings,
  oversightSummarySchema,
} from './github-oversight';
import { summaryCadence, summaryWriterState } from './github-summary';
import {
  type ActivityEntry,
  activityEntry,
  activityQuery,
  type BlockIssue,
  type BlockTodo,
  blockIssue,
  blockTodo,
  blockTodoQuery,
  type DailyNotePage,
  type DailyNoteProjects,
  dailyNotePage,
  dailyNoteProjects,
  dailyNoteQuery,
  type Item,
  type ItemView,
  item,
  itemAction,
  itemQuery,
  itemView,
  type Mention,
  mention,
  mentionQuery,
  type ProjectBlock,
  projectBlock,
} from './items';
import { type LinearCatalog, linearCatalog } from './linear';
import { type LinearSendPrefill, linearIssueDraft, linearSendPrefill } from './linear-send';
import { type OutgoingChange, outgoingChange, outgoingQuery } from './outgoing';
import { type PeopleChange, type Person, peopleAction, peopleChange, person } from './people';
import {
  type Project,
  type ProjectChange,
  project,
  projectAction,
  projectChange,
  projectQuery,
} from './projects';
import {
  type Rule,
  type RuleChange,
  type RulePreview,
  rule,
  ruleAction,
  ruleChange,
  rulePreview,
  rulePreviewRequest,
} from './rules';
import {
  type FindTimeResult,
  findTimeRequest,
  findTimeResult,
  type SchedulingSettings,
  schedulingSettings,
} from './scheduling';
import { type SearchResult, searchQuery, searchResult } from './search';
import { type ChatSetting, chatSetting, chatSettingAction } from './teams';

// What the window may ask of the Item store. It reaches the store only through these requests,
// validated in the main process and again in the Core. Actions from the window are always the User's.
// Ares's GitHub summaries (#121), newest first, and how his writing stands.
export const githubSummaries = z.object({ summaries: z.array(item), writer: summaryWriterState });
export type GitHubSummaries = z.infer<typeof githubSummaries>;

export const itemStoreRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('query'), query: itemQuery.default({}) }),
  z.object({ op: z.literal('get'), itemId: z.string().min(1) }),
  z.object({ op: z.literal('activity'), query: activityQuery.default({}) }),
  z.object({ op: z.literal('record'), action: itemAction, why: z.string().optional() }),
  z.object({ op: z.literal('projects'), query: projectQuery.default({}) }),
  z.object({ op: z.literal('change-project'), action: projectAction }),
  // Several actions, recorded in order as one: all of them or none.
  z.object({
    op: z.literal('record-all'),
    actions: z.array(itemAction).min(1).max(500),
    why: z.string().optional(),
  }),
  // The Daily Note for a calendar day, made if there isn't one yet. `fromTemplate` when the day is
  // being made as today: a new Daily Note then starts with a copy of the daily template.
  z.object({ op: z.literal('daily-note'), day: z.iso.date(), fromTemplate: z.boolean().optional() }),
  z.object({ op: z.literal('daily-notes'), query: dailyNoteQuery.default({}) }),
  z.object({ op: z.literal('blocks'), dailyNoteIds: z.array(z.string().min(1)).max(1000) }),
  // Settings → Notes → Daily template. A setting, not an Item change, so not in the activity log.
  z.object({ op: z.literal('daily-template') }),
  z.object({ op: z.literal('save-daily-template'), template: dailyTemplate }),
  // Todos made from Blocks, by their Daily Notes or by the Todos.
  z.object({ op: z.literal('block-todos'), query: blockTodoQuery }),
  // A pasted image's bytes, saved by the Core into attachments/ (it checks they are an image).
  z.object({
    op: z.literal('save-attachment'),
    bytes: z
      .custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected the image’s bytes')
      .refine((bytes) => bytes.byteLength <= attachmentMaxBytes, 'Images can be up to 20 MB.'),
  }),
  // Settings → Rules: the one ordered list, changing it, the editor's live preview, and re-filing
  // existing Items after a change (one undoable change, undone with `undo-refile`).
  z.object({ op: z.literal('rules') }),
  z.object({ op: z.literal('change-rule'), action: ruleAction }),
  z.object({ op: z.literal('preview-rule'), request: rulePreviewRequest }),
  z.object({ op: z.literal('refile'), itemIds: z.array(z.string().min(1)).min(1).max(1000) }),
  z.object({ op: z.literal('undo-refile'), entryIds: z.array(z.number().int().positive()).min(1).max(1000) }),
  // Global search (the Ctrl+K palette): local, ranked, never waiting on a model.
  z.object({ op: z.literal('search'), query: searchQuery }),
  // Two-way sync: changes waiting to reach their Source (or that couldn't sync), and Retry for an
  // Item's changes that couldn't sync.
  z.object({ op: z.literal('outgoing'), query: outgoingQuery.default({}) }),
  z.object({ op: z.literal('retry-outgoing'), itemId: z.string().min(1) }),
  // What an Account's Source offers the detail pane's pickers (Linear: each team's states, members,
  // labels, cycles and Linear projects), as its last sync fetched it; null before the first.
  z.object({ op: z.literal('source-catalog'), account: z.string().min(1) }),
  // The Project filter in Notes: which Projects each written Daily Note has Blocks in.
  z.object({ op: z.literal('daily-note-projects') }),
  // A Project page's Notes list: the Project's written Blocks, by day.
  z.object({ op: z.literal('project-blocks'), projectId: z.string().min(1) }),
  // The Blocks whose `[[` links point at these days' Daily Notes or Projects ("Mentioned in").
  z.object({ op: z.literal('mentions'), query: mentionQuery }),
  // Send to Linear: a new Linear issue from a Todo, a Block or the Linear Section, as one change (its
  // entries come back, the issue's creation first, so undoing them all undoes it); where the dialog
  // starts; and the issues made from these Daily Notes' Blocks, for their chips.
  z.object({ op: z.literal('send-to-linear'), draft: linearIssueDraft }),
  z.object({
    op: z.literal('linear-send-prefill'),
    from: z.string().min(1).optional(),
    projectId: z.string().min(1).nullable().optional(),
  }),
  z.object({ op: z.literal('block-issues'), dailyNoteIds: z.array(z.string().min(1)).max(1000) }),
  // The Dashboard (ares-ranking.ts): Ares's ranking (or why the rules rank it) and the rows cleared
  // from it, and replacing those. Clearing changes no Item, so it is not in the activity log.
  z.object({ op: z.literal('dashboard') }),
  z.object({ op: z.literal('save-dashboard-clears'), clears: dashboardClears }),
  // Teams: the Chats the User muted or excluded (all Accounts, or one), and muting, excluding or
  // including one again. Commander settings, not Item changes, except that excluding a Chat deletes
  // its Item (in the activity log, by the User).
  z.object({ op: z.literal('chat-settings'), account: z.string().min(1).optional() }),
  z.object({ op: z.literal('change-chat-setting'), action: chatSettingAction }),
  // "Not waiting on you" (#109): the User clears Ares's waiting flag on a Chat by hand. A correction
  // in the activity log (kept as an example for Memory), undone like any change.
  z.object({ op: z.literal('clear-chat-waiting'), itemId: z.string().min(1) }),
  // The Calendar Section: live events overlapping a time range, earliest first; every Account's
  // calendars and whether each is on; and switching one on or off (off hides its events at once and
  // stops syncing it; on syncs it again).
  z.object({ op: z.literal('events'), query: eventQuery }),
  z.object({ op: z.literal('calendars') }),
  z.object({
    op: z.literal('set-calendar-enabled'),
    account: z.string().min(1),
    calendarId: z.string().min(1),
    on: z.boolean(),
  }),
  // Settings → Calendar: the opt-in heads-up 2 minutes before each meeting (off by default).
  z.object({ op: z.literal('calendar-settings') }),
  z.object({ op: z.literal('save-calendar-settings'), settings: calendarSettings }),
  // The Email Section (email-threads.ts): the inbox as threads, and one thread's messages with their
  // plain-text bodies.
  z.object({ op: z.literal('email-threads'), query: emailThreadQuery.default({}) }),
  z.object({ op: z.literal('email-thread'), account: z.string().min(1), threadKey: z.string().min(1) }),
  // Organising email (#135): each view's counts, the Section's search, and the labels to pick from.
  z.object({ op: z.literal('email-views'), query: emailViewQuery.default({}) }),
  z.object({ op: z.literal('email-search'), query: emailSearchQuery }),
  z.object({ op: z.literal('email-labels'), account: z.string().min(1).optional() }),
  // Ares's meeting preps (#130) for these events: at most one each.
  z.object({ op: z.literal('meeting-preps'), eventIds: z.array(z.string().min(1)).max(500) }),
  // The oversight summary (#119): the summary for a range, over everything, one Project (its id) or
  // Unfiled (null); and Settings → GitHub's oversight settings.
  z.object({
    op: z.literal('github-oversight'),
    range: oversightRangeSpan,
    projectId: z.string().min(1).nullable().optional(),
  }),
  z.object({ op: z.literal('github-oversight-settings') }),
  z.object({ op: z.literal('save-github-oversight-settings'), settings: oversightSettings }),
  // Ares's GitHub summaries (#121), newest first (of these cadences, when given), with how his writing
  // stands; and one opened (on the Dashboard, in the Update or the GitHub Section): seen.
  z.object({
    op: z.literal('github-summaries'),
    cadences: z.array(summaryCadence).optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  z.object({ op: z.literal('github-summary-seen'), itemId: z.string().min(1) }),
  // Settings → People (#117): everyone Commander knows, and the User's merges, splits, renames and
  // undos, each kept in the People log. People are not Items: not in the activity log.
  z.object({ op: z.literal('people') }),
  z.object({ op: z.literal('change-people'), action: peopleAction }),
  // Invitations still to come that wait for the User's answer, earliest first (the Dashboard's Today).
  z.object({ op: z.literal('invitations') }),
  // Settings → Calendar's focus time (#131): working hours, the Account focus blocks go in, and the
  // pairs of Block time across Accounts.
  z.object({ op: z.literal('focus-settings') }),
  z.object({ op: z.literal('save-focus-settings'), settings: focusSettings }),
  // Ares's scheduler (#132): Settings → Calendar's new events calendar and booking link; Find time (the
  // User's free time across every Account, narrowed by guests' free/busy where a provider allows, up to
  // 5 slots, answered once the providers have); and making a meeting the User set up there (as the User,
  // through the outgoing queue like every event Commander makes).
  z.object({ op: z.literal('scheduling-settings') }),
  z.object({ op: z.literal('save-scheduling-settings'), settings: schedulingSettings }),
  z.object({ op: z.literal('find-time'), request: findTimeRequest }),
  z.object({
    op: z.literal('create-meeting'),
    draft: commanderEventDraft.refine((draft) => draft.kind === 'meeting', 'Only a meeting is made this way'),
  }),
]);
export type ItemStoreRequest = z.input<typeof itemStoreRequest>;
export type ItemStoreOp = ItemStoreRequest['op'];

// What a change to a Chat's setting did: the setting as it now stands, the Chat's Item (null when
// Commander holds none), and the activity entry deleting it, when excluding did.
export const chatSettingChange = z.object({
  setting: chatSetting,
  itemId: z.string().nullable(),
  entry: activityEntry.nullable(),
});
export type ChatSettingChange = z.infer<typeof chatSettingChange>;

export type ItemStoreResults = {
  query: Item[];
  get: ItemView | null;
  activity: ActivityEntry[];
  record: ActivityEntry;
  projects: Project[];
  'change-project': ProjectChange;
  'record-all': ActivityEntry[];
  'daily-note': Item;
  'daily-notes': DailyNotePage;
  blocks: Item[];
  'daily-template': DailyTemplate;
  'save-daily-template': DailyTemplate;
  'block-todos': BlockTodo[];
  'save-attachment': { name: string };
  rules: Rule[];
  'change-rule': RuleChange;
  'preview-rule': RulePreview;
  refile: ActivityEntry[];
  'undo-refile': ActivityEntry[];
  search: SearchResult;
  outgoing: OutgoingChange[];
  'retry-outgoing': OutgoingChange[];
  'source-catalog': LinearCatalog | null;
  'daily-note-projects': DailyNoteProjects[];
  'project-blocks': ProjectBlock[];
  mentions: Mention[];
  'send-to-linear': ActivityEntry[];
  'linear-send-prefill': LinearSendPrefill;
  'block-issues': BlockIssue[];
  dashboard: DashboardState;
  'save-dashboard-clears': DashboardClears;
  'chat-settings': ChatSetting[];
  'change-chat-setting': ChatSettingChange;
  'clear-chat-waiting': ActivityEntry;
  events: Item[];
  calendars: CalendarSummary[];
  'set-calendar-enabled': CalendarSummary[];
  'calendar-settings': CalendarSettings;
  'save-calendar-settings': CalendarSettings;
  'email-threads': EmailThreadList;
  'email-thread': EmailThread | null;
  'email-views': EmailViewCounts;
  'email-search': EmailSearchResult;
  'email-labels': EmailLabel[];
  'meeting-preps': Item[];
  'github-oversight': OversightSummary;
  'github-oversight-settings': OversightSettings;
  'save-github-oversight-settings': OversightSettings;
  'github-summaries': GitHubSummaries;
  'github-summary-seen': Item | null;
  people: Person[];
  'change-people': PeopleChange;
  invitations: Item[];
  'focus-settings': FocusSettings;
  'save-focus-settings': FocusSettings;
  'scheduling-settings': SchedulingSettings;
  'save-scheduling-settings': SchedulingSettings;
  'find-time': FindTimeResult;
  'create-meeting': ActivityEntry;
};

export const itemStoreResult = {
  query: z.array(item),
  get: itemView.nullable(),
  activity: z.array(activityEntry),
  record: activityEntry,
  projects: z.array(project),
  'change-project': projectChange,
  'record-all': z.array(activityEntry),
  'daily-note': item,
  'daily-notes': dailyNotePage,
  blocks: z.array(item),
  'daily-template': dailyTemplate,
  'save-daily-template': dailyTemplate,
  'block-todos': z.array(blockTodo),
  'save-attachment': z.object({ name: z.string().regex(attachmentNamePattern) }),
  rules: z.array(rule),
  'change-rule': ruleChange,
  'preview-rule': rulePreview,
  refile: z.array(activityEntry),
  'undo-refile': z.array(activityEntry),
  search: searchResult,
  outgoing: z.array(outgoingChange),
  'retry-outgoing': z.array(outgoingChange),
  'source-catalog': linearCatalog.nullable(),
  'daily-note-projects': z.array(dailyNoteProjects),
  'project-blocks': z.array(projectBlock),
  mentions: z.array(mention),
  'send-to-linear': z.array(activityEntry),
  'linear-send-prefill': linearSendPrefill,
  'block-issues': z.array(blockIssue),
  dashboard: dashboardState,
  'save-dashboard-clears': dashboardClears,
  'chat-settings': z.array(chatSetting),
  'change-chat-setting': chatSettingChange,
  'clear-chat-waiting': activityEntry,
  events: z.array(item),
  calendars: z.array(calendarSummary),
  'set-calendar-enabled': z.array(calendarSummary),
  'calendar-settings': calendarSettings,
  'save-calendar-settings': calendarSettings,
  'email-threads': emailThreadList,
  'email-thread': emailThread.nullable(),
  'email-views': emailViewCounts,
  'email-search': emailSearchResult,
  'email-labels': emailLabelList,
  'meeting-preps': z.array(item),
  'github-oversight': oversightSummarySchema,
  'github-oversight-settings': oversightSettings,
  'save-github-oversight-settings': oversightSettings,
  'github-summaries': githubSummaries,
  'github-summary-seen': item.nullable(),
  people: z.array(person),
  'change-people': peopleChange,
  invitations: z.array(item),
  'focus-settings': focusSettings,
  'save-focus-settings': focusSettings,
  'scheduling-settings': schedulingSettings,
  'save-scheduling-settings': schedulingSettings,
  'find-time': findTimeResult,
  'create-meeting': activityEntry,
} satisfies Record<ItemStoreOp, z.ZodType>;

export type ItemStoreResponse<Op extends ItemStoreOp = ItemStoreOp> =
  | { ok: true; result: ItemStoreResults[Op] }
  | { ok: false; error: string };

const requestId = z.number().int().positive();

// Main process → Core.
export const coreItemStoreRequest = z.object({
  type: z.literal('item-store-request'),
  id: requestId,
  request: itemStoreRequest,
});
export type CoreItemStoreRequest = z.input<typeof coreItemStoreRequest>;

// Core → main process. The result is checked against the request's op by whoever asked.
export const coreItemStoreReply = z.object({
  type: z.literal('item-store-reply'),
  id: requestId,
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});
export type CoreItemStoreReply = z.infer<typeof coreItemStoreReply>;
