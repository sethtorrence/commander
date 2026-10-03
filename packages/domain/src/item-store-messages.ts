import { z } from 'zod';
import {
  type ActivityEntry,
  activityEntry,
  activityQuery,
  type DailyNotePage,
  dailyNotePage,
  dailyNoteQuery,
  type Item,
  type ItemView,
  item,
  itemAction,
  itemQuery,
  itemView,
} from './items';
import { type Project, project, projectAction, projectQuery } from './projects';

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
  // The Daily Note for a calendar day, made if there isn't one yet.
  z.object({ op: z.literal('daily-note'), day: z.iso.date() }),
  z.object({ op: z.literal('daily-notes'), query: dailyNoteQuery.default({}) }),
  z.object({ op: z.literal('blocks'), dailyNoteIds: z.array(z.string().min(1)).max(1000) }),
]);
export type ItemStoreRequest = z.input<typeof itemStoreRequest>;
export type ItemStoreOp = ItemStoreRequest['op'];

export type ItemStoreResults = {
  query: Item[];
  get: ItemView | null;
  activity: ActivityEntry[];
  record: ActivityEntry;
  projects: Project[];
  'change-project': Project;
  'record-all': ActivityEntry[];
  'daily-note': Item;
  'daily-notes': DailyNotePage;
  blocks: Item[];
};

export const itemStoreResult = {
  query: z.array(item),
  get: itemView.nullable(),
  activity: z.array(activityEntry),
  record: activityEntry,
  projects: z.array(project),
  'change-project': project,
  'record-all': z.array(activityEntry),
  'daily-note': item,
  'daily-notes': dailyNotePage,
  blocks: z.array(item),
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
