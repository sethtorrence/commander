import { z } from 'zod';
import { itemKind } from './items';
import { skillInfo } from './skills';
import { updateSection } from './updates';

// Conversations (#24, #191): the User talks to Ares in the Ares Section. Each Conversation is a
// thread of turns of text, the User's and Ares's, kept in the Item store's database; several can run
// at once. Ares never starts one or writes into one unprompted: each of his turns answers one of the
// User's. A turn is only text, tied to nothing on screen, so voice can come later.
//
// With Skills (#192) an answer can rest on the User's own data: each Item it was given carries a ref
// (I1, I2…) for that answer, and the answer names the ones its claims rest on as [I1]; those are its
// links, each opening its Item in its Section. Commander keeps only refs it handed out in that answer.
// An answer that gave the Update names it, shown in the Conversation with its lines and actions.
//
// A Conversation can be about one Item (#193): the Ares button on an Item (or `a` on the focused one)
// starts a new Conversation from it in a small pop-up beside the Item. That Item is handed to Ares
// with every message as I1, in a data block of its own by where it came from (a Source's Item as
// outside material, the User's own Todos and Blocks as theirs), and the pop-up can be expanded into
// the Ares Section, where the Conversation carries on like any other.
//
// With action Skills (#196) an answer can also do things: each action goes to the gate under the
// User's Autonomy settings, and the answer names the proposals, shown under it as cards (done, with
// Undo, or waiting for the User to confirm with one key).

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
// - failed: no key, the monthly cap, a failed call, or Commander's core stopping while he wrote it
//   (#200): `problem` says why, in his voice, and the User's message is kept to send again.
export const turnStatuses = ['queued', 'streaming', 'done', 'stopped', 'failed'] as const;
export const turnStatus = z.enum(turnStatuses);
export type TurnStatus = z.infer<typeof turnStatus>;

// How an answer names an Item it rests on: [I1], [I2]… in its text.
export const LINK_REF = /^I[1-9]\d{0,2}$/;
export const LINK_MARKER = /\[(I[1-9]\d{0,2})\]/g;

// One Item an answer rests on, as its link shows it: named by its Source's short name (ENG-418) or
// its title, and opening in its Section.
export const conversationLink = z.object({
  ref: z.string().regex(LINK_REF),
  itemId: z.string().min(1),
  kind: itemKind,
  title: z.string(),
  label: z.string().nullable(),
  section: updateSection,
});
export type ConversationLink = z.infer<typeof conversationLink>;

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
  // The Items his answer names, by their refs in its text (#192). Empty on the User's turns.
  links: z.array(conversationLink),
  // The Update he gave in this answer, shown with its lines and actions; null when he gave none.
  updateId: z.number().int().positive().nullable(),
  // The Skills he used for this answer, in order, by name (one may run more than once).
  skills: z.array(z.string()),
  // What his action Skills (#196) handed the gate for this answer, by proposal: each shows under it as
  // a card, done (with Undo) or waiting for the User to confirm.
  proposalIds: z.array(z.number().int().positive()),
});
export type ConversationTurn = z.infer<typeof conversationTurn>;

/** An answer's text cut into plain pieces and the links it names, in order, for drawing. */
export function piecesOf(
  text: string,
  links: readonly ConversationLink[],
): ({ text: string } | { link: ConversationLink })[] {
  const byRef = new Map(links.map((link) => [link.ref, link]));
  const pieces: ({ text: string } | { link: ConversationLink })[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK_MARKER)) {
    const link = byRef.get(match[1] as string);
    if (!link) continue;
    const index = match.index ?? 0;
    if (index > at) pieces.push({ text: text.slice(at, index) });
    pieces.push({ link });
    at = index + match[0].length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

// A Skill as the "What Ares can do" page lists it: from the Skill registry, and whether he can use
// it in a Conversation yet (the rest are used where they live, Draft on a Teams Chat).
export const conversationSkill = skillInfo.extend({ inConversations: z.boolean() });
export type ConversationSkill = z.infer<typeof conversationSkill>;

// The Item a Conversation is about, as its pop-up and the Ares Section name it, opening in its Section.
export const conversationAbout = conversationLink.omit({ ref: true });
export type ConversationAbout = z.infer<typeof conversationAbout>;

// The ref the Item a Conversation is about always has in his answers.
export const ABOUT_REF = 'I1';

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
  // The Item it was started from with the Ares button (#193), kept by its id, or null.
  aboutItemId: z.string().nullable(),
  // That Item as it is now, named for the window (the Conversations module reads it); null when the
  // Conversation is about none, or the Item is no longer in Commander.
  about: conversationAbout.nullable(),
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
  // New Conversation: another one, at any time. `about`: the Item the Ares button was pressed on
  // (#193), which Ares is handed with every message.
  z.object({ op: z.literal('new'), day: z.iso.date(), about: z.string().min(1).optional() }),
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
  // What Ares can do: every Skill he has (#192).
  z.object({ op: z.literal('skills') }),
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
  skills: ConversationSkill[];
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
  skills: z.array(conversationSkill),
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
