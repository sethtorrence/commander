import { z } from 'zod';
import { aresStatus } from './agent';
import { conversationTokens, conversationTurnChanged } from './conversations';
import { markdownCopyStatus } from './markdown-copy-messages';
import { updatesState } from './updates';

// Messages the Core sends to the window.
// Every message crossing a process seam is validated against this contract.
const heartbeat = z.object({
  type: z.literal('heartbeat'),
  beats: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});

// Ares did or suggested something (through the gate): views of his activity reload.
const aresActivity = z.object({ type: z.literal('ares-activity'), at: z.number().int().nonnegative() });

// Ares started or finished a job: the Ares status module shows him working or idle.
const aresStatusChanged = aresStatus.extend({ type: z.literal('ares-status') });

// Ares's "Rank the Dashboard" job finished a run: the Dashboard reads its ranking again (his, or the
// rules' when he couldn't rank it).
const dashboardRanked = z.object({ type: z.literal('dashboard-ranked'), at: z.number().int().nonnegative() });
// Ares's queue or the User's presence changed: the quiet count and "You're here / away" follow.
const aresUpdates = updatesState.extend({ type: z.literal('ares-updates') });

// Items were changed in the Item store (by the window, a sync, or Ares through the gate): open
// views showing them catch up.
const itemsChanged = z.object({
  type: z.literal('items-changed'),
  itemIds: z.array(z.string().min(1)).min(1),
});

// The Core changed today's meeting chips itself (#128): a Notes view showing that Daily Note reads it
// again (not while the User is writing in it).
const meetingChipsChanged = z.object({
  type: z.literal('meeting-chips'),
  dailyNoteId: z.string().min(1),
});

// A meeting starts in 2 minutes and the User asked to hear about it (Settings → Calendar): the main
// process shows a system notification with the meeting's title and time, which opens the event.
// The one interruption Commander makes (decision #23); it says nothing beyond the meeting itself.
const meetingHeadsUp = z.object({
  type: z.literal('meeting-heads-up'),
  itemId: z.string().min(1),
  title: z.string(),
  // "10:00–10:30"
  times: z.string(),
  startsAt: z.number().int().nonnegative(),
});

// How the Markdown copy of the Daily Notes stands changed (markdown-copy-messages.ts): Settings shows it.
const markdownCopyChanged = z.object({ type: z.literal('markdown-copy-status'), status: markdownCopyStatus });

// A new Core is running after one stopped (#200). Sent by the main process, not the Core: views
// holding what the Core pushes as it changes (Ares working, the quiet count, an answer being written)
// ask again, since the old Core's word may never have come.
const coreRestarted = z.object({ type: z.literal('core-restarted'), at: z.number().int().nonnegative() });

// Conversations (#191, conversations.ts): Ares's answer as he writes it, and his turn as it changes.
export const coreMessage = z.discriminatedUnion('type', [
  heartbeat,
  aresActivity,
  aresStatusChanged,
  conversationTokens,
  conversationTurnChanged,
  coreRestarted,
  dashboardRanked,
  aresUpdates,
  itemsChanged,
  markdownCopyChanged,
  meetingChipsChanged,
  meetingHeadsUp,
]);
export type CoreMessage = z.infer<typeof coreMessage>;

export type CoreMessageParseResult = { ok: true; message: CoreMessage } | { ok: false; error: string };

export function parseCoreMessage(input: unknown): CoreMessageParseResult {
  const result = coreMessage.safeParse(input);
  return result.success ? { ok: true, message: result.data } : { ok: false, error: result.error.message };
}
