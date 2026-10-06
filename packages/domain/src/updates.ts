import { z } from 'zod';
import { actionKind, autonomyLevel, autonomySection, autonomySections } from './autonomy';

// Updates (#23, #70): Ares never interrupts. Anything he wants to tell the User goes in his queue,
// and he delivers it only when the User is active and asks (`U`, the header button, the tray, the
// palette, or later a Conversation). Each Update he gives is kept, so the User can reopen it.

const id = z.number().int().positive();
const itemId = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// The three groups an Update is in, in order.
export const updateGroups = ['now', 'decision', 'fyi'] as const;
export const updateGroup = z.enum(updateGroups);
export type UpdateGroup = z.infer<typeof updateGroup>;

export const UPDATE_GROUP_NAMES: Record<UpdateGroup, string> = {
  now: 'Needs you now',
  decision: 'Waiting on your decision',
  fyi: 'For your information',
};

// Where a queued line's Items live, for folding the smaller things by Section after time away.
export const updateSections = [...autonomySections, 'ares'] as const;
export const updateSection = z.enum(updateSections);
export type UpdateSection = z.infer<typeof updateSection>;

export const UPDATE_SECTION_NAMES: Record<UpdateSection, string> = {
  notes: 'Notes',
  todos: 'Todos',
  linear: 'Linear',
  email: 'Email',
  calendar: 'Calendar',
  github: 'GitHub',
  teams: 'Teams',
  ares: 'Ares',
};

// A Linear issue a queued line is about, by its Item and its identifier (ENG-418).
const linearIssueOnLine = z.object({ itemId, identifier: z.string().min(1) });

// What a queued line is about, by what queued it. Later producers add their own kind here.
export const queuedAbout = z.discriminatedUnion('kind', [
  // Ask suggestions of one action Ares wasn't sure about, merged into one line.
  z.object({
    kind: z.literal('suggestions'),
    action: z.string().min(1),
    name: z.string().min(1),
    actionKind,
    proposalIds: z.array(id).min(1),
  }),
  // A suggestion made because of another Item (outside content): always its own line.
  z.object({
    kind: z.literal('chained'),
    action: z.string().min(1),
    name: z.string().min(1),
    actionKind,
    proposalId: id,
  }),
  // Outside Items that held instructions aimed at Ares (their injection-warning activity entries).
  z.object({ kind: z.literal('injection-warnings'), entryIds: z.array(id).min(1) }),
  // Items Ares sent to no model because they hold one of the User's keys or sign-in tokens (#201):
  // their refusal activity entries, merged into one line. Never the secret itself.
  z.object({ kind: z.literal('refusals'), entryIds: z.array(id).min(1) }),
  // The month's model spend reached 80% of the cap.
  z.object({
    kind: z.literal('cap-warning'),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    spentUsd: z.number().nonnegative(),
    capUsd: z.number().positive(),
  }),
  // "You've accepted my last 20 … without changing any. Want me to just do them?" Accepting raises
  // the action's level one step, never above its hard limit.
  z.object({
    kind: z.literal('autonomy-change'),
    action: z.string().min(1),
    name: z.string().min(1),
    actionKind,
    section: autonomySection.nullable(),
    from: autonomyLevel,
    to: autonomyLevel,
    accepted: z.number().int().positive(),
    // The newest suggestion the streak counted, so the next streak starts after it.
    lastProposalId: id,
  }),
  // Linear issues taken off the User's list by a sync (reassigned, unassigned, cancelled, moved out
  // of the Todo states, deleted), whose Linear Todos went: their activity entries, merged into one
  // line ("3 of your Linear issues were reassigned"). `why` is the entry's ("ENG-418 was reassigned
  // to Priya Patel").
  z.object({
    kind: z.literal('linear-left'),
    entryIds: z.array(id).min(1),
    issues: z
      .array(linearIssueOnLine.extend({ todoId: itemId, why: z.string().min(1), reassigned: z.boolean() }))
      .min(1),
  }),
  // The User's Linear issues Ares judged stuck, merged by team, each with his one-sentence reason and
  // when it last changed: it leaves the line once the issue changes.
  z.object({
    kind: z.literal('linear-stuck'),
    team: z.object({ id: z.string().min(1), key: z.string(), name: z.string() }),
    issues: z.array(linearIssueOnLine.extend({ reason: z.string().min(1), changedAt: timestamp })).min(1),
  }),
  // An Account whose sign-in needs reconnecting: its syncing is paused until the User signs in again.
  z.object({
    kind: z.literal('reconnect'),
    account: z.string().min(1),
    // The Source as the User knows it ("Linear"), and the Account's name ("Acme"), when known.
    sourceName: z.string().min(1),
    name: z.string().nullable(),
  }),
  // A meeting's prep is ready (#130): "Prep for “1:1 with Priya” at 15:00 is ready". Open opens the
  // meeting with its prep; the line expires when the meeting ends. `title` is the event's (outside
  // words), for the plain sentence.
  z.object({
    kind: z.literal('meeting-prep'),
    eventId: itemId,
    prepId: itemId,
    title: z.string(),
    startsAt: timestamp,
  }),
  // A busy Chat (#109): an unmuted Chat with many messages from others since the last Update, merged
  // per Chat. Ares summarises it when the Update is put together, never ahead of time. `since` is
  // where its messages start; `count` how many from others there were when last looked.
  z.object({
    kind: z.literal('chat-summary'),
    itemId,
    count: z.number().int().positive(),
    since: timestamp,
  }),
  // Ares's latest unseen GitHub summary (#121), daily or the Monday roll-up: its first lines (his
  // words, shown with AresText), with Open. A newer one takes its place; opening it marks it seen and
  // the line goes. `label` says what it covers ("GitHub summary · since yesterday").
  z.object({
    kind: z.literal('github-summary'),
    summaryId: itemId,
    label: z.string().min(1),
    lead: z.string().min(1),
    onFire: z.boolean(),
  }),
  // "Always file Linear team OPS under TX?" (#71): the User's corrections and confirmations point one
  // Source field value at one Project often enough. Accepting opens the Rule, filled in, to go at the
  // top of the list; dismissing it stops it coming back.
  z.object({
    kind: z.literal('rule-suggestion'),
    // The Rule field (`linear.team`), the value's id and how it reads ("OPS").
    field: z.string().min(1),
    value: z.string().min(1),
    label: z.string().min(1),
    projectId: itemId,
    // The Project's code when it was suggested, for the plain sentence.
    code: z.string().min(1),
    // How many Items the User filed that way.
    count: z.number().int().positive(),
  }),
  // "Always put mail from stripe.com in Receipts?" (#141): the User's answers to Ares's sorting point
  // one sender address, domain or mailing list at one Bucket often enough. Accepting opens the Bucket
  // Rule, filled in, to go at the top of the list; dismissing it stops it coming back.
  z.object({
    kind: z.literal('bucket-rule-suggestion'),
    // The email Rule field (`gmail.domain`), the value and how it reads ("stripe.com").
    field: z.string().min(1),
    value: z.string().min(1),
    label: z.string().min(1),
    bucketId: z.string().min(1),
    // The Bucket's name when it was suggested, for the plain sentence.
    name: z.string().min(1),
    // How many emails the User sorted that way.
    count: z.number().int().positive(),
  }),
  // A Bucket Ares suggests the User adds (#141), from the week's corrections and unsure sorts: its
  // name and description, and his reason (his words, shown with AresText). Nothing is added until the
  // User accepts (Add Bucket, editable first); dismissing it stops it coming back.
  z.object({
    kind: z.literal('bucket-suggestion'),
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().max(500),
    reason: z.string().trim().max(300),
  }),
  // A Gmail message (or a personal Outlook one) whose send-later time passed while Commander was
  // closed or the machine asleep (#139): "Your email to Dana was due at 09:00. Send it now?", with Send
  // now, Edit and Discard. It never went by itself; the line goes once the User decides, here or in
  // Scheduled. `missedAt` tells one miss from a later one of the same message.
  z.object({
    kind: z.literal('missed-send'),
    itemId,
    dueAt: timestamp,
    missedAt: timestamp,
  }),
]);
export type QueuedAbout = z.infer<typeof queuedAbout>;
export type QueuedKind = QueuedAbout['kind'];

// A line acted on is done or dismissed; one whose subject was settled elsewhere (its suggestions
// accepted on the activity page, say) is resolved; a time-bound one past mattering is expired.
export const queuedStatuses = ['queued', 'done', 'dismissed', 'resolved', 'expired'] as const;
export const queuedStatus = z.enum(queuedStatuses);
export type QueuedStatus = z.infer<typeof queuedStatus>;

export const queuedLine = z.object({
  id,
  group: updateGroup,
  // Lines with the same key merge while queued ("12 suggestions I wasn't sure about").
  mergeKey: z.string().min(1),
  about: queuedAbout,
  // The Items it is about.
  itemIds: z.array(itemId),
  section: updateSection,
  // From 0 to 1: after time away, the five most important lead.
  importance: z.number().min(0).max(1),
  createdAt: timestamp,
  updatedAt: timestamp,
  // A time-bound line drops out once it stops mattering.
  expiresAt: timestamp.nullable(),
  snoozedUntil: timestamp.nullable(),
  status: queuedStatus,
  settledAt: timestamp.nullable(),
});
export type QueuedLine = z.infer<typeof queuedLine>;

// What any part of Commander hands the queue.
export type Enqueue = {
  group: UpdateGroup;
  mergeKey: string;
  about: QueuedAbout;
  itemIds: string[];
  section: UpdateSection;
  importance?: number;
  expiresAt?: number | null;
};

// One line of an Update as Ares gave it: what he said about a queued line.
export const updateLine = z.object({
  queuedId: id,
  group: updateGroup,
  kind: z.string().min(1),
  // One or two plain sentences, in Ares's voice (or the plain template when the model wasn't there).
  text: z.string().min(1),
  itemIds: z.array(itemId),
  section: updateSection,
  // The Items' titles: the only places a URL in the text may link to (AresText).
  sources: z.array(z.string()),
  // Folded below the lead after real time away.
  folded: z.boolean(),
  // Queued (or changed) since the User last asked.
  fresh: z.boolean(),
});
export type UpdateLine = z.infer<typeof updateLine>;

export const givenUpdate = z.object({
  id,
  at: timestamp,
  // The longest stretch with no activity since the Update before: over 8 hours folds the smaller things.
  awayMs: z.number().int().nonnegative(),
  folded: z.boolean(),
  // Who wrote the sentences: Ares through the model, or the plain templates.
  voice: z.enum(['ares', 'template']),
  lines: z.array(updateLine),
});
export type GivenUpdate = z.infer<typeof givenUpdate>;

// What the User can do to one Item of a line, right there in the Update (#186). Open and Reply open
// it where it lives (Reply at the message waiting on them); the rest the Core carries out.
// A missed send-later (#139) offers Send now, Edit (the composer, opened in the window) and Discard.
export const updateRowActions = [
  'open',
  'reply',
  'accept',
  'dismiss',
  'tick',
  'not-an-instruction',
  'send-now',
  'edit',
  'discard',
] as const;
export const updateRowAction = z.enum(updateRowActions);
export type UpdateRowAction = z.infer<typeof updateRowAction>;
export const rowActions = ['accept', 'dismiss', 'tick', 'not-an-instruction', 'send-now', 'discard'] as const;
export const rowAction = z.enum(rowActions);
export type RowAction = z.infer<typeof rowAction>;

// One Item of a line, as the Update lists it under the line (#186): named, with a few words on where
// it stands and its own actions, opening in its own Section.
export const updateRow = z.object({
  itemId,
  // The Source's short name for it, when it has one (ENG-418, acme/api#12).
  label: z.string().nullable(),
  title: z.string(),
  section: updateSection,
  // A few words on where it stands: "Reassigned to Priya Patel", "In Review · unchanged for 12 days".
  state: z.string(),
  // What in it read like an instruction to Ares (an injection warning), word for word.
  quote: z.string().nullable(),
  // Where Reply opens it: the message waiting on the User.
  focus: z.string().nullable(),
  actions: z.array(updateRowAction),
  // What became of it once it was dealt with ("Not an instruction", "Dismissed"), else null.
  settled: z.string().nullable(),
});
export type UpdateRow = z.infer<typeof updateRow>;

// An Update as the panel shows it: each line with where its queued line stands now, so lines acted
// on show as such and only the rest offer Done, Dismiss, Snooze, Open and Accept, and with its Items.
export const updateView = givenUpdate.extend({
  lines: z.array(updateLine.extend({ queued: queuedLine.nullable(), rows: z.array(updateRow) })),
});
export type UpdateView = z.infer<typeof updateView>;
export type UpdateViewLine = UpdateView['lines'][number];

export const updateSummary = z.object({
  id,
  at: timestamp,
  lines: z.number().int().nonnegative(),
  folded: z.boolean(),
  voice: z.enum(['ares', 'template']),
});
export type UpdateSummary = z.infer<typeof updateSummary>;

// Whether the User is at the machine: active (unlocked, input in the last 5 minutes), idle (no
// input for longer), locked, or away (no activity for more than 8 hours). Only the status module's
// "You're here / away" and having the Update ready on return depend on it; it never draws the
// User's attention.
export const presenceStates = ['active', 'idle', 'locked', 'away'] as const;
export const presenceState = z.enum(presenceStates);
export type PresenceState = z.infer<typeof presenceState>;

export const presence = z.object({
  state: presenceState,
  // When the User last did something (the start of the current stretch for active).
  since: timestamp,
});
export type Presence = z.infer<typeof presence>;

export const updatesState = z.object({ queued: z.number().int().nonnegative(), presence });
export type UpdatesState = z.infer<typeof updatesState>;

export const snoozeChoices = ['later-today', 'tomorrow'] as const;
export const snoozeChoice = z.enum(snoozeChoices);
export type SnoozeChoice = z.infer<typeof snoozeChoice>;

export const queuedActions = ['done', 'dismiss', 'snooze', 'accept'] as const;
export const queuedAction = z.enum(queuedActions);
export type QueuedAction = z.infer<typeof queuedAction>;

// Ares's group importance, then each line's own: what leads after time away.
const GROUP_RANK: Record<UpdateGroup, number> = { now: 0, decision: 1, fyi: 2 };

/** Queued lines in the order an Update gives them: by group, then most important, then newest. */
export function inUpdateOrder<T extends Pick<QueuedLine, 'group' | 'importance' | 'updatedAt' | 'id'>>(
  lines: readonly T[],
): T[] {
  return [...lines].sort(
    (a, b) =>
      GROUP_RANK[a.group] - GROUP_RANK[b.group] ||
      b.importance - a.importance ||
      b.updatedAt - a.updatedAt ||
      b.id - a.id,
  );
}

/** The next moment a snooze wakes: "later today" is three hours on, "tomorrow" is 9:00 tomorrow. */
export function snoozedUntil(choice: SnoozeChoice, now: number): number {
  if (choice === 'later-today') return now + 3 * 60 * 60_000;
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 9).getTime();
}
