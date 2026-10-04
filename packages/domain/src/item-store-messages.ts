import { z } from 'zod';
import { attachmentMaxBytes, attachmentNamePattern } from './attachments';
import { type DailyTemplate, dailyTemplate } from './daily-template';
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
import { type SearchResult, searchQuery, searchResult } from './search';

// What the window may ask of the Item store. It reaches the store only through these requests,
// validated in the main process and again in the Core. Actions from the window are always the User's.
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
]);
export type ItemStoreRequest = z.input<typeof itemStoreRequest>;
export type ItemStoreOp = ItemStoreRequest['op'];

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
