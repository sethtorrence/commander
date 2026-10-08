import { z } from 'zod';
import { MAX_EMAIL_DRAFT } from './email-drafts';
import { MAX_REPLY_LENGTH } from './teams';
import { snoozeChoice } from './updates';

/*
  What Ares's Skills make for an answer to show (#198, decision #24): drafts and a meeting's prep,
  kept on his answer and shown under it, in the Ares Section and the Ares button's pop-up alike.

  - Draft writes the User's reply to an email thread (#143, kept as its suggested reply) or a Teams
    Chat (#110), in their own style, from what the User asked it to say: their own message, never the
    model's words. Open in composer makes it an ordinary Draft (or fills the Chat's reply box) for the
    User to edit and send. Nothing is sent from a Conversation, and nothing of it changes an Item, so
    it never goes to the gate (ADR 0004, eleventh amendment).
  - Schedule's booking link (action-skills.ts) is a reply too, but in Commander's own words, "Book a
    time here: <link>", opened the same way (ADR 0004, sixteenth amendment).
  - Meeting prep runs "Prepare for meetings" (#130) for the event the User named, and the answer shows
    the prep as it stands, linked to the event.

  - A line action (#236): in a Conversation about an Update line, one of the line's own actions
    (Done, Dismiss, Snooze, Open, Accept, Retry, or one of its Items' own), proposed by Ares and shown
    as a card the User confirms with one key. Confirming does exactly what the line's button does, by
    the same path; Ares can only ever prepare it (update-line-replies.ts).

  What Draft and Meeting prep are given there is in conversation-skills.ts.
*/

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// The longest booking-link reply ("Book a time here: <link>").
const MAX_BOOKING_REPLY = 600;

// What Ares may propose for an Update line he is asked about (#236): on the whole line, its own buttons
// (Done, Dismiss, Snooze, Open, and Accept or Retry where the line offers them)…
export const lineActions = ['done', 'dismiss', 'snooze', 'open', 'accept', 'retry'] as const;
// …and on one of its Items, that Item's own, except a missed send-later's Send now and Discard: only the
// User's own buttons send a message or throw a draft away (ADR 0004, eleventh amendment).
export const lineItemActions = [
  'open',
  'reply',
  'accept',
  'dismiss',
  'tick',
  'not-an-instruction',
  'edit',
  'retry',
] as const;
type LineAction = (typeof lineActions)[number];
type LineItemAction = (typeof lineItemActions)[number];
// Every one of them, by name.
export const lineActionNames = [
  'done',
  'dismiss',
  'snooze',
  'open',
  'accept',
  'retry',
  'reply',
  'tick',
  'not-an-instruction',
  'edit',
] as const satisfies readonly (LineAction | LineItemAction)[];
export const lineActionName = z.enum(lineActionNames);
export type LineActionName = z.infer<typeof lineActionName>;

// Where a line action's card stands: waiting for the User, confirmed (carried out as the button would),
// or declined (Not now).
export const lineActionStatuses = ['waiting', 'confirmed', 'declined'] as const;
export const lineActionStatus = z.enum(lineActionStatuses);
export type LineActionStatus = z.infer<typeof lineActionStatus>;

export const conversationMade = z.discriminatedUnion('kind', [
  // A reply Ares drafted to an email thread, kept as its suggested reply: `itemId`, the message it
  // answers (Open in composer opens that suggested reply); `title`, the thread's subject.
  z.object({
    kind: z.literal('email-draft'),
    itemId: id,
    title: z.string(),
    body: z.string().min(1).max(MAX_EMAIL_DRAFT),
    // Links he added that are in neither the thread nor the User's sent mail.
    addedLinks: z.array(z.string()),
    sure: z.boolean(),
  }),
  // A reply Ares drafted to a Teams Chat, for its reply box.
  z.object({
    kind: z.literal('chat-draft'),
    itemId: id,
    title: z.string(),
    text: z.string().min(1).max(MAX_REPLY_LENGTH),
  }),
  // A reply holding the User's booking link, to an email or a Chat: Commander's words, not his.
  z.object({
    kind: z.literal('booking-reply'),
    itemId: id,
    title: z.string(),
    to: z.enum(['email', 'chat']),
    text: z.string().min(1).max(MAX_BOOKING_REPLY),
    link: z.string().min(1),
  }),
  // A meeting's prep, by its event: shown as the prep stands now.
  z.object({ kind: z.literal('meeting-prep'), eventId: id, title: z.string(), startsAt: timestamp }),
  // One of an Update line's own actions (#236), waiting for the User's Confirm: on the whole line
  // (`itemId` null) or one of its Items. `updateId`: the Update the line was given in, whose line the
  // button belongs to. `what`: what it does, in Commander's own words ("Mark the line done").
  z.object({
    kind: z.literal('line-action'),
    updateId: z.number().int().positive(),
    queuedId: z.number().int().positive(),
    itemId: id.nullable(),
    action: lineActionName,
    snooze: snoozeChoice.nullable(),
    what: z.string().min(1),
    status: lineActionStatus,
  }),
]);
export type ConversationMade = z.infer<typeof conversationMade>;
