import { z } from 'zod';
import { oversightRangeSpan } from './github-oversight';
import { personParagraph, summaryRequest } from './github-summary';
import { item } from './items';
import { type ChatSummary, chatSummary, summaryRange } from './teams-ares';
import { type ChatDraft, chatDraft } from './teams-work';
import {
  type QueuedLine,
  queuedAction,
  queuedLine,
  snoozeChoice,
  type UpdateSummary,
  type UpdatesState,
  type UpdateView,
  updateSummary,
  updatesState,
  updateView,
} from './updates';

// What the window may ask of Ares's Updates, relayed by the main process and validated on both
// sides. The window never enqueues: only the Core's producers do.
const id = z.number().int().positive();

// What asking Ares for a GitHub summary comes to: the summary (an Item of his), or why there is none.
export const githubSummaryAnswer = z.object({ summary: item.nullable(), problem: z.string().nullable() });
export type GitHubSummaryAnswer = z.infer<typeof githubSummaryAnswer>;

// Refresh on a People card (#122): Ares writes one Person's paragraph again, over a range.
export const personParagraphRequest = z.object({ personId: z.string().min(1), range: oversightRangeSpan });
export type PersonParagraphRequest = z.infer<typeof personParagraphRequest>;
// What it comes to: the paragraph he wrote (kept in his latest summary), or why there is none.
export const personParagraphAnswer = z.object({
  paragraph: personParagraph.nullable(),
  problem: z.string().nullable(),
});
export type PersonParagraphAnswer = z.infer<typeof personParagraphAnswer>;

export const updatesRequest = z.discriminatedUnion('op', [
  // The quiet count and whether the User is here, for the header, the tray and the Dashboard.
  z.object({ op: z.literal('state') }),
  // Runs one of Ares's Skills. The Update is the only one so far: it gives (and keeps) an Update,
  // or null when nothing is queued.
  z.object({ op: z.literal('run-skill'), skill: z.literal('update') }),
  // Summarise (#109): Ares summarises a Chat over a range of its messages, on request.
  z.object({ op: z.literal('summarise-chat'), itemId: z.string().min(1), range: summaryRange }),
  // Draft (#110): Ares drafts a reply to a Chat, on request, for the User to edit and send.
  z.object({ op: z.literal('draft-reply'), itemId: z.string().min(1) }),
  // Ask Ares to write the GitHub summary (#121) for a range and scope: the summary he wrote, or why
  // he didn't (the plain summary shows then).
  z.object({ op: z.literal('summarise-github'), request: summaryRequest }),
  // Refresh one Person's paragraph on the People view (#122).
  z.object({ op: z.literal('refresh-person-paragraph'), request: personParagraphRequest }),
  // Past Updates, newest first, and one of them reopened.
  z.object({ op: z.literal('history'), limit: z.number().int().positive().max(200).optional() }),
  z.object({ op: z.literal('past'), id }),
  // Done, Dismiss, Snooze (later today or tomorrow), or accepting a suggestion in place.
  z.object({
    op: z.literal('act'),
    queuedId: id,
    action: queuedAction,
    snooze: snoozeChoice.optional(),
  }),
]);
export type UpdatesRequest = z.input<typeof updatesRequest>;
export type UpdatesOp = UpdatesRequest['op'];

export type UpdatesResults = {
  state: UpdatesState;
  'run-skill': UpdateView | null;
  'summarise-chat': ChatSummary;
  'draft-reply': ChatDraft;
  'summarise-github': GitHubSummaryAnswer;
  'refresh-person-paragraph': PersonParagraphAnswer;
  history: UpdateSummary[];
  past: UpdateView;
  act: QueuedLine;
};

export const updatesResult = {
  state: updatesState,
  'run-skill': updateView.nullable(),
  'summarise-chat': chatSummary,
  'draft-reply': chatDraft,
  'summarise-github': githubSummaryAnswer,
  'refresh-person-paragraph': personParagraphAnswer,
  history: z.array(updateSummary),
  past: updateView,
  act: queuedLine,
} satisfies Record<UpdatesOp, z.ZodType>;

export type UpdatesResponse<Op extends UpdatesOp = UpdatesOp> =
  | { ok: true; result: UpdatesResults[Op] }
  | { ok: false; error: string };

// The envelopes between the main process and the Core.
export const UPDATES_MESSAGES = { request: 'updates-request', reply: 'updates-reply' } as const;

// Main process → Core: what powerMonitor says, every few seconds and on lock, unlock, sleep and wake.
export const presenceReport = z.object({
  type: z.literal('presence-report'),
  // Seconds since the last keyboard or mouse input.
  idleSeconds: z.number().nonnegative(),
  locked: z.boolean(),
});
export type PresenceReport = z.infer<typeof presenceReport>;
