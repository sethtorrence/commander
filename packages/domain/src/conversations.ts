import { z } from 'zod';

// Conversations (#24, #191): the User talks to Ares in the Ares Section. Each Conversation is a
// thread of turns of text, the User's and Ares's, kept in the Item store's database; several can run
// at once. Ares never starts one or writes into one unprompted: each of his turns answers one of the
// User's. A turn is only text, tied to nothing on screen, so voice can come later.

const timestamp = z.number().int().nonnegative();
const conversationId = z.string().min(1);
const turnId = z.number().int().positive();

// The longest message the User can send in one turn.
export const MAX_TURN_TEXT = 20_000;

// Who wrote a turn.
export const turnAuthors = ['user', 'ares'] as const;
export const turnAuthor = z.enum(turnAuthors);
export type TurnAuthor = z.infer<typeof turnAuthor>;

// Where one of Ares's answers stands. The User's turns are always `done`.
// - queued: waiting its turn on a local model, which another Conversation is using.
// - streaming: Ares is writing it.
// - done: he finished.
// - stopped: the User stopped him (or Commander closed): what he had written is kept.
// - failed: no key, the monthly cap, or a failed call: `problem` says why, in his voice, and the
//   User's message is kept to send again.
export const turnStatuses = ['queued', 'streaming', 'done', 'stopped', 'failed'] as const;
export const turnStatus = z.enum(turnStatuses);
export type TurnStatus = z.infer<typeof turnStatus>;

export const conversationTurn = z.object({
  id: turnId,
  conversationId,
  by: turnAuthor,
  text: z.string(),
  at: timestamp,
  status: turnStatus,
  // The User's turn one of Ares's answers; null on the User's own turns.
  replyTo: turnId.nullable(),
  // He answered from the model's own knowledge, not the User's data: shown as "From Ares's own
  // knowledge".
  ownKnowledge: z.boolean(),
  // Why a failed answer failed, in his voice.
  problem: z.string().nullable(),
  // When he finished, stopped or failed.
  endedAt: timestamp.nullable(),
});
export type ConversationTurn = z.infer<typeof conversationTurn>;

export const conversation = z.object({
  id: conversationId,
  // From the first words the User wrote; null until they write.
  title: z.string().nullable(),
  // The day it was made (the User's local date).
  day: z.iso.date(),
  // It is that day's own Conversation (made on the first open of the day), rather than one the User
  // started with New Conversation.
  daily: z.boolean(),
  createdAt: timestamp,
  // Its last turn, or when it was made.
  updatedAt: timestamp,
  // Ares is answering in it now (or waiting his turn to).
  answering: z.boolean(),
});
export type Conversation = z.infer<typeof conversation>;

export const conversationView = z.object({ conversation, turns: z.array(conversationTurn) });
export type ConversationView = z.infer<typeof conversationView>;

// How a Conversation is named until the User writes in it.
export const conversationName = (
  conversation: Pick<Conversation, 'title' | 'daily'>,
  untitledDaily = 'Today',
): string => conversation.title ?? (conversation.daily ? untitledDaily : 'New Conversation');

// A Conversation's name from the first words the User wrote: the first line, at most six words and
// 48 characters, with an ellipsis when cut.
export function titleFrom(text: string): string | null {
  const line =
    text
      .split('\n')
      .map((each) => each.trim())
      .find(Boolean) ?? '';
  if (!line) return null;
  const words = line.split(/\s+/);
  let title = words.slice(0, 6).join(' ');
  let cut = words.length > 6;
  if (title.length > 48) {
    title = title.slice(0, 48).replace(/\s+\S*$/, '') || title.slice(0, 48);
    cut = true;
  }
  return cut ? `${title.replace(/[\s.,;:!?-]+$/, '')}…` : title;
}

// What the window may ask of Conversations, relayed by the main process and validated on both sides.
// Nothing here lets the window write one of Ares's turns: only the Core does, answering the User.
export const conversationsRequest = z.discriminatedUnion('op', [
  // Every Conversation, newest first (by its last turn).
  z.object({ op: z.literal('list') }),
  // Today's Conversation, made on the first open of the day (`day`: the window's local date).
  z.object({ op: z.literal('today'), day: z.iso.date() }),
  // New Conversation: another one, at any time.
  z.object({ op: z.literal('new'), day: z.iso.date() }),
  z.object({ op: z.literal('open'), conversationId }),
  // The User's message: saved as their turn, and Ares starts answering (or waits his turn). Refused
  // while he is still answering in that Conversation.
  z.object({
    op: z.literal('send'),
    conversationId,
    text: z.string().trim().min(1).max(MAX_TURN_TEXT),
  }),
  // Send again: Ares answers the User's last message again, after a failed answer (or one stopped
  // before he wrote anything).
  z.object({ op: z.literal('retry'), conversationId }),
  // Stop: ends his answer early, keeping what he wrote (or takes it out of the queue).
  z.object({ op: z.literal('stop'), conversationId }),
  // Removes a Conversation and its turns; Undo (while the toast shows) puts them back.
  z.object({ op: z.literal('delete'), conversationId }),
  z.object({ op: z.literal('undo-delete'), conversationId }),
]);
export type ConversationsRequest = z.input<typeof conversationsRequest>;
export type ConversationsOp = ConversationsRequest['op'];

export type ConversationsResults = {
  list: Conversation[];
  today: ConversationView;
  new: ConversationView;
  open: ConversationView;
  send: ConversationView;
  retry: ConversationView;
  stop: ConversationView;
  delete: { conversationId: string };
  'undo-delete': ConversationView;
};

export const conversationsResult = {
  list: z.array(conversation),
  today: conversationView,
  new: conversationView,
  open: conversationView,
  send: conversationView,
  retry: conversationView,
  stop: conversationView,
  delete: z.object({ conversationId }),
  'undo-delete': conversationView,
} satisfies Record<ConversationsOp, z.ZodType>;

export type ConversationsResponse<Op extends ConversationsOp = ConversationsOp> =
  | { ok: true; result: ConversationsResults[Op] }
  | { ok: false; error: string };

// The envelopes between the main process and the Core.
export const CONVERSATIONS_MESSAGES = {
  request: 'conversations-request',
  reply: 'conversations-reply',
} as const;

// Core → window (core-messages.ts): a piece of Ares's answer as he writes it. The answer so far is
// its text up to `from`, followed by `tokens`; `from` is below what the window holds only when the
// Core's checks on his words (ADR 0004) changed something he had already written.
export const conversationTokens = z.object({
  type: z.literal('conversation-tokens'),
  conversationId,
  turnId,
  from: z.number().int().nonnegative(),
  tokens: z.string(),
});
export type ConversationTokens = z.infer<typeof conversationTokens>;

// Core → window: one of Ares's turns changed (it started, finished, stopped, failed, or waits its
// turn), as it now stands.
export const conversationTurnChanged = z.object({
  type: z.literal('conversation-turn'),
  turn: conversationTurn,
});
export type ConversationTurnChanged = z.infer<typeof conversationTurnChanged>;

/** The answer so far, once a piece of it has arrived. */
export const withTokens = (text: string, piece: Pick<ConversationTokens, 'from' | 'tokens'>): string =>
  text.slice(0, piece.from) + piece.tokens;
