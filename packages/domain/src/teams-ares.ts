import { z } from 'zod';
import type { ChatWaiting } from './items';
import type { SkillInfo } from './skills';
import type { ChatDetail, ChatMessage } from './teams';

/*
  Ares on Teams (#109): what the window and the Core share about his two Teams jobs.

  - "Spot what's waiting on you" (a Quick job, after each Teams sync) flags a Chat when someone in it
    is waiting on the User (a question, a request, a decision), with the message and his reason in
    one short sentence. The flag decorates the Chat's Item (`waiting`): the Dashboard places it in
    Today with his reason, and the Teams Section marks it and filters by it. It holds until the User
    replies after the message (`stillWaiting`), Ares judges on a later run that it's no longer
    waiting, or the User clears it by hand (an undoable correction).
  - "Summarise Chat" (a Deep job) summarises a Chat on request, over a range of its messages
    (`messagesInRange`), and the busy Chats in the Update: an unmuted Chat with at least
    `busyChatThreshold` messages from others since the last Update.

  Both change no Item and write nothing to Teams, so neither goes through the gate (ADR 0004's
  amendment); what they write is shown through AresText.
*/

/** The job that spots what's waiting on the User, and the action it registers (Organise). */
export const SPOT_WAITING_ON_YOU = 'spot-waiting-on-you';
/** The job that summarises a Chat, on request or for the Update. */
export const SUMMARISE_CHAT = 'summarise-chat';

/** How many messages from others since the last Update make a Chat busy, unless Settings → Ares says. */
export const BUSY_CHAT_MESSAGES = 20;

export const busyChatThreshold = (settings: { busyChatMessages?: number }) =>
  settings.busyChatMessages ?? BUSY_CHAT_MESSAGES;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A message that was said: not a system event, not deleted. */
export const isSpoken = (message: ChatMessage) => message.from !== null && !message.deleted;

/**
 * Whether a flag still stands: its message is still in the Chat, from someone else, and the User
 * hasn't said anything since. `me` is the User's Teams user id in the Chat's Account; without it, the
 * Chat's own derived flag (the latest message is the User's) decides.
 */
export function stillWaiting(
  detail: Pick<ChatDetail, 'messages' | 'latestFromMe'>,
  waiting: ChatWaiting | null | undefined,
  me: string | null,
): boolean {
  if (!waiting) return false;
  const flagged = detail.messages.find((message) => message.id === waiting.messageId);
  if (!flagged || !isSpoken(flagged)) return false;
  if (me === null) return !detail.latestFromMe;
  if (flagged.from?.userId === me) return false;
  return !detail.messages.some(
    (message) => isSpoken(message) && message.from?.userId === me && message.createdAt > flagged.createdAt,
  );
}

/** The messages from others since a moment (after it), oldest first: what makes a Chat busy. */
export function fromOthersSince(
  detail: Pick<ChatDetail, 'messages'>,
  me: string | null,
  since: number,
): ChatMessage[] {
  return detail.messages.filter(
    (message) =>
      isSpoken(message) && message.createdAt > since && (me === null || message.from?.userId !== me),
  );
}

// ---------------------------------------------------------------------------------------------
// Summaries

/** What a summary on request covers: since the User last read the Chat (the default), today, this week. */
export const summaryRanges = ['since-read', 'today', 'week'] as const;
export const summaryRange = z.enum(summaryRanges);
export type SummaryRange = z.infer<typeof summaryRange>;

export const SUMMARY_RANGE_NAMES: Record<SummaryRange, string> = {
  'since-read': 'Since I last read',
  today: 'Today',
  week: 'This week',
};

/**
 * Where a range starts: when the User last read the Chat (the last day if never), local midnight
 * today, or seven days ago.
 */
export function summaryRangeStart(
  detail: Pick<ChatDetail, 'lastReadAt'>,
  range: SummaryRange,
  now: number,
): number {
  if (range === 'since-read') return detail.lastReadAt ?? now - DAY;
  if (range === 'week') return now - 7 * DAY;
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The messages a range covers, oldest first: said (not system events or deleted), after it starts. */
export function messagesInRange(
  detail: Pick<ChatDetail, 'messages' | 'lastReadAt'>,
  range: SummaryRange,
  now: number,
): ChatMessage[] {
  const start = summaryRangeStart(detail, range, now);
  return detail.messages
    .filter((message) => isSpoken(message) && message.createdAt > start)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * A summary of a Chat as the window shows it (through AresText): Ares's words, how many messages it
 * covers, and the messages' text, the only places a link in it may point to. Null text: nothing to
 * summarise in that range.
 */
export const chatSummary = z.object({
  itemId: z.string().min(1),
  range: summaryRange,
  text: z.string().max(2000).nullable(),
  count: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  sources: z.array(z.string()),
});
export type ChatSummary = z.infer<typeof chatSummary>;

/** Summarise: one of Ares's Skills, on a Chat. */
export const SUMMARISE_SKILL: SkillInfo = {
  name: 'summarise',
  description:
    'Summarise a Teams Chat for the User: what was said and settled, and anything that needs them, over the messages since they last read it, today, or this week.',
};
