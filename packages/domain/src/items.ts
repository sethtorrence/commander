import { z } from 'zod';
import { linearIssueDetail } from './linear';

// Items: everything Commander tracks, in one shape (ADR 0001). A shared core plus
// kind-specific detail, typed Links between Items, and one activity log of every change.

export const itemKinds = [
  'email',
  'event',
  'linear-issue',
  'pull-request',
  'review-request',
  'chat',
  'channel-post',
  'todo',
  'daily-note',
  'block',
] as const;
export const itemKind = z.enum(itemKinds);
export type ItemKind = z.infer<typeof itemKind>;

export const sources = ['gmail', 'outlook', 'google-calendar', 'teams', 'linear', 'github'] as const;
export const source = z.enum(sources);
export type Source = z.infer<typeof source>;

export const itemStatuses = ['open', 'done', 'archived'] as const;
export const itemStatus = z.enum(itemStatuses);
export type ItemStatus = z.infer<typeof itemStatus>;

// How an Item came to be in its Project.
export const filedBy = z.enum(['rule', 'ares', 'user', 'inherited']);
export type FiledBy = z.infer<typeof filedBy>;

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// null means the Item is Unfiled.
export const filing = z.object({ projectId: id, filedBy }).nullable();
export type Filing = z.infer<typeof filing>;

// People involved, by handle (email address, GitHub or Linear user) until Person matching lands.
export const people = z.array(z.string().min(1));

// Where a Todo came from: one the User added, a suggestion from Ares the User accepted, a Linear
// issue assigned to the User, or a Block of a Daily Note (made from it, with a made-from Link).
export const todoOrigins = ['manual', 'ares', 'linear', 'daily-note'] as const;
export const todoOrigin = z.enum(todoOrigins);
export type TodoOrigin = z.infer<typeof todoOrigin>;

// Kind-specific detail. Each kind with detail gets its own variant (and table).
export const todoDetail = z.object({
  kind: z.literal('todo'),
  origin: todoOrigin,
  // Calendar day the Todo is due, as YYYY-MM-DD.
  dueOn: z.iso.date().nullable(),
  // The Item behind a backed Todo (a Linear issue, a review request); ticking writes through to it.
  backedBy: id.nullable(),
});
// A Daily Note: the single note for one calendar day (ADR 0002), keyed by that local date.
export const dailyNoteDetail = z.object({
  kind: z.literal('daily-note'),
  day: z.iso.date(),
});
export type DailyNoteDetail = z.infer<typeof dailyNoteDetail>;

// A Block: one line of a Daily Note. Blocks nest under one another; siblings sort by position, a
// fractional index ("a0" < "a0V" < "a1") so a move or insert changes only the Block itself. The text
// is the Block's own, and its Item's title follows it.
export const blockDetail = z.object({
  kind: z.literal('block'),
  dailyNoteId: id,
  // null for a Block at the top of its Daily Note.
  parentId: id.nullable(),
  position: z.string().min(1),
  text: z.string(),
  // Whether its children are hidden.
  folded: z.boolean(),
});
export type BlockDetail = z.infer<typeof blockDetail>;

export const itemDetail = z.discriminatedUnion('kind', [
  todoDetail,
  dailyNoteDetail,
  blockDetail,
  linearIssueDetail,
]);
export type ItemDetail = z.infer<typeof itemDetail>;

export const item = z.object({
  id,
  kind: itemKind,
  // null for Items made in Commander (Todos, Blocks).
  source: source.nullable(),
  account: id.nullable(),
  externalId: id.nullable(),
  title: z.string(),
  people,
  filing,
  status: itemStatus,
  detail: itemDetail.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  // Set when the Item was deleted (at its Source, or in Commander). Its Links and history remain.
  deletedAt: timestamp.nullable(),
});
export type Item = z.infer<typeof item>;

// The part of an Item that changes, and that the activity log records before and after each change.
export const itemState = item.pick({
  title: true,
  people: true,
  status: true,
  filing: true,
  detail: true,
  deletedAt: true,
});
export type ItemState = z.infer<typeof itemState>;

// An Item as a Source adapter hands it over. Filing is never set by a Source: it belongs to the User,
// Rules and Ares, and survives every sync.
export const sourceItem = z.object({
  externalId: id,
  kind: itemKind,
  title: z.string(),
  people: people.default([]),
  status: itemStatus.default('open'),
  detail: itemDetail.nullable().default(null),
});
export type SourceItem = z.input<typeof sourceItem>;

// One sync's worth of changes from one Account. `deleted` lists externalIds removed at the Source.
export const sourceBatch = z.object({
  source,
  account: id,
  items: z.array(sourceItem).default([]),
  deleted: z.array(id).default([]),
});
export type SourceBatch = z.input<typeof sourceBatch>;

export type SaveResult = { created: string[]; updated: string[]; tombstoned: string[]; unchanged: string[] };

export const linkTypes = ['made-from', 'refers-to', 'finishes', 'about', 'caused-by'] as const;
export const linkType = z.enum(linkTypes);
export type LinkType = z.infer<typeof linkType>;

// A short view of the Item at one end of a Link, enough to show "deleted in Gmail".
export const itemRef = item.pick({ id: true, kind: true, title: true, source: true, deletedAt: true });
export type ItemRef = z.infer<typeof itemRef>;

export const link = z.object({ type: linkType, from: itemRef, to: itemRef, createdAt: timestamp });
export type Link = z.infer<typeof link>;

// An Item with its Links (from it) and backlinks (to it).
export const itemView = z.object({ item, links: z.array(link), backlinks: z.array(link) });
export type ItemView = z.infer<typeof itemView>;

export const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('ares') }),
  z.object({ kind: z.literal('rule'), ruleId: id }),
  z.object({ kind: z.literal('source'), source, account: id }),
]);
export type Actor = z.infer<typeof actor>;

// What caused a change: an Item (the email behind a suggestion) and/or an earlier activity entry.
export const causedBy = z.object({ itemId: id.optional(), entryId: z.number().int().positive().optional() });
export type CausedBy = z.infer<typeof causedBy>;

export const newItem = z.object({
  // Items made in Commander may come with their id, chosen by the caller (e.g. a Block the window shows
  // before the Core answers). The Core makes one up otherwise.
  id: z.uuid().optional(),
  kind: itemKind,
  title: z.string(),
  people: people.default([]),
  status: itemStatus.default('open'),
  filing: filing.default(null),
  detail: itemDetail.nullable().default(null),
});

export const itemChanges = z
  .object({
    title: z.string(),
    people,
    status: itemStatus,
    filing,
    detail: itemDetail.nullable(),
  })
  .partial();

const linkEnds = { from: id, linkType, to: id };

// Every change made in Commander is one of these actions, and each records an activity entry.
export const itemAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), item: newItem }),
  z.object({ type: z.literal('update'), itemId: id, changes: itemChanges }),
  z.object({ type: z.literal('delete'), itemId: id }),
  z.object({ type: z.literal('link'), ...linkEnds }),
  z.object({ type: z.literal('unlink'), ...linkEnds }),
  // Restores what the entry changed. Undoing an undo redoes it.
  z.object({ type: z.literal('undo'), entryId: z.number().int().positive() }),
]);
export type ItemAction = z.input<typeof itemAction>;

// One field an action changed on an Item, with its value before and after.
const fieldChange = <F extends keyof ItemState>(field: F) =>
  z.object({ field: z.literal(field), before: itemState.shape[field], after: itemState.shape[field] });
export const itemChange = z.discriminatedUnion('field', [
  fieldChange('title'),
  fieldChange('people'),
  fieldChange('status'),
  fieldChange('filing'),
  fieldChange('detail'),
  fieldChange('deletedAt'),
]);
export type ItemChange = z.infer<typeof itemChange>;

export const activityAction = z.enum(['create', 'update', 'delete', 'tombstone', 'link', 'unlink', 'undo']);
export type ActivityAction = z.infer<typeof activityAction>;

export const activityEntry = z.object({
  id: z.number().int().positive(),
  at: timestamp,
  by: actor,
  action: activityAction,
  // The Item changed, or the Item a Link starts from.
  itemId: id,
  // The Item a Link points to, for link and unlink (and their undos).
  otherItemId: id.nullable(),
  why: z.string().nullable(),
  causedBy: causedBy.nullable(),
  // For an undo: the entry it reversed.
  undoes: z.number().int().positive().nullable(),
  // The Item fields the entry changed. Empty for a creation, and for Links.
  changes: z.array(itemChange),
});
export type ActivityEntry = z.infer<typeof activityEntry>;

export const itemQuery = z.object({
  kinds: z.array(itemKind).optional(),
  // A Project's id, or null for Unfiled Items.
  projectId: id.nullable().optional(),
  source: source.optional(),
  account: id.optional(),
  statuses: z.array(itemStatus).optional(),
  // Case-insensitive match on the title (full-text search comes with global search).
  titleContains: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type ItemQuery = z.input<typeof itemQuery>;

export const activityQuery = z.object({
  itemId: id.optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type ActivityQuery = z.input<typeof activityQuery>;

// Who did it, why and what caused it: recorded with every action.
export const actionContext = z.object({
  by: actor,
  why: z.string().optional(),
  causedBy: causedBy.optional(),
});
export type ActionContext = z.input<typeof actionContext>;

// Daily Notes, newest first. `before` and `limit` page through: ask for the days before the oldest one
// shown so far.
export const dailyNoteQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  // Only Daily Notes with at least one Block that has text.
  withContent: z.boolean().optional(),
  // Only days before this one: the next page after the oldest day already shown.
  before: z.iso.date().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type DailyNoteQuery = z.input<typeof dailyNoteQuery>;

export const dailyNoteSummary = z.object({
  item,
  day: z.iso.date(),
  // How many Blocks it holds.
  blocks: z.number().int().nonnegative(),
});
export type DailyNoteSummary = z.infer<typeof dailyNoteSummary>;

// One page of Daily Notes, and how many match the query without its limit (so whether there are more).
export const dailyNotePage = z.object({
  notes: z.array(dailyNoteSummary),
  total: z.number().int().nonnegative(),
});
export type DailyNotePage = z.infer<typeof dailyNotePage>;

// Todos made from Blocks (`[]` at the start of a Block): those with a made-from Link to a Block of
// these Daily Notes, or these Todos themselves. Only live Todos of live Blocks.
export const blockTodoQuery = z.object({
  dailyNoteIds: z.array(id).max(1000).optional(),
  todoIds: z.array(id).max(1000).optional(),
});
export type BlockTodoQuery = z.input<typeof blockTodoQuery>;

// A Todo made from a Block, with that Block and its Daily Note's day.
export const blockTodo = z.object({ todo: item, block: item, day: z.iso.date() });
export type BlockTodo = z.infer<typeof blockTodo>;
