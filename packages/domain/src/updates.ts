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
export const updateSections = [...autonomySections, 'teams', 'ares'] as const;
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

// What a queued line is about, by what queued it. Later producers (meeting prep, the GitHub summary,
// missed send-later) add their own kind here.
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

// An Update as the panel shows it: each line with where its queued line stands now, so lines acted
// on show as such and only the rest offer Done, Dismiss, Snooze, Open and Accept.
export const updateView = givenUpdate.extend({
  lines: z.array(updateLine.extend({ queued: queuedLine.nullable() })),
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
