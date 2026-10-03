import { z } from 'zod';
import { activityEntry, causedBy, itemChanges, itemRef, linkType, newItem } from './items';

// Autonomy settings: how far Ares may go on his own, per Action kind, with Section and per-action
// overrides, under hard limits no setting can lift. Every Ares action goes through `decide`.

// Ordered from least to most freedom.
export const autonomyLevels = ['off', 'ask', 'auto-when-sure', 'auto'] as const;
export const autonomyLevel = z.enum(autonomyLevels);
export type AutonomyLevel = z.infer<typeof autonomyLevel>;

export const AUTONOMY_LEVEL_NAMES: Record<AutonomyLevel, string> = {
  off: 'Off',
  ask: 'Ask',
  'auto-when-sure': 'Auto when sure',
  auto: 'Auto',
};

// Grouped by who can see the result.
export const actionKinds = ['organise', 'tidy-sources', 'act-for-you', 'delete'] as const;
export const actionKind = z.enum(actionKinds);
export type ActionKind = z.infer<typeof actionKind>;

export const ACTION_KIND_NAMES: Record<ActionKind, string> = {
  organise: 'Organise',
  'tidy-sources': 'Tidy your Sources',
  'act-for-you': 'Act for you',
  delete: 'Delete',
};

// The highest level each kind may ever run at. Act for you is seen by other people and Delete is
// permanent, so Ares only ever suggests them.
export const HARD_LIMITS: Record<ActionKind, AutonomyLevel> = {
  organise: 'auto',
  'tidy-sources': 'auto',
  'act-for-you': 'ask',
  delete: 'ask',
};

// Auto when sure acts only at or above this confidence. Built in: not User-tunable in v1.
export const CONFIDENCE_BAR = 0.8;

// The Sections an Autonomy setting can be overridden in: those holding Items Ares acts on. Teams
// joins with its Section.
export const autonomySections = ['notes', 'todos', 'linear', 'email', 'calendar', 'github'] as const;
export const autonomySection = z.enum(autonomySections);
export type AutonomySection = z.infer<typeof autonomySection>;

export const AUTONOMY_SECTION_NAMES: Record<AutonomySection, string> = {
  notes: 'Notes',
  todos: 'Todos',
  linear: 'Linear',
  email: 'Email',
  calendar: 'Calendar',
  github: 'GitHub',
};

// An action a job has registered: its id (what proposals name), its Action kind and the name the
// Settings grid shows ("Suggest Todos"), with an optional hint about how it treats the levels.
export const registeredAction = z.object({
  action: z.string().min(1),
  actionKind,
  name: z.string().min(1),
  hint: z.string().optional(),
});
export type RegisteredAction = z.infer<typeof registeredAction>;

export const autonomySettings = z.object({
  // One level per Action kind, for everything.
  everywhere: z.record(actionKind, autonomyLevel),
  // Section overrides, by Action kind.
  sections: z.partialRecord(autonomySection, z.partialRecord(actionKind, autonomyLevel)),
  // Per-action overrides, by registered action id.
  actions: z.record(z.string().min(1), autonomyLevel),
});
export type AutonomySettings = z.infer<typeof autonomySettings>;

export const DEFAULT_AUTONOMY: AutonomySettings = {
  everywhere: { organise: 'auto-when-sure', 'tidy-sources': 'ask', 'act-for-you': 'ask', delete: 'off' },
  sections: {},
  actions: {},
};

export function isAllowed(kind: ActionKind, level: AutonomyLevel): boolean {
  return autonomyLevels.indexOf(level) <= autonomyLevels.indexOf(HARD_LIMITS[kind]);
}

// The level the settings choose for an action, before the hard limit: the per-action override,
// else the Section override, else Everywhere.
export function chosenLevel(
  settings: AutonomySettings,
  { actionKind, action, section }: Pick<DecisionInput, 'actionKind' | 'action' | 'section'>,
): AutonomyLevel {
  return (
    settings.actions[action] ??
    (section ? settings.sections[section]?.[actionKind] : undefined) ??
    settings.everywhere[actionKind]
  );
}

export type DecisionInput = {
  actionKind: ActionKind;
  action: string;
  // null for actions that belong to no one Section (ranking the Dashboard).
  section: AutonomySection | null;
  // Ares's confidence, from 0 to 1.
  confidence: number;
  // Suggested for another Item because of outside content: always Ask.
  chained: boolean;
};

// What the gate does with a proposal: drop it, keep it as a suggestion, or carry it out.
export type Decision = 'off' | 'ask' | 'auto';

export function decide(input: DecisionInput, settings: AutonomySettings = DEFAULT_AUTONOMY): Decision {
  const chosen = chosenLevel(settings, input);
  const level = isAllowed(input.actionKind, chosen) ? chosen : HARD_LIMITS[input.actionKind];
  if (level === 'off') return 'off';
  if (input.chained || level === 'ask') return 'ask';
  if (level === 'auto') return 'auto';
  return input.confidence >= CONFIDENCE_BAR ? 'auto' : 'ask';
}

// Proposals: what Ares's jobs hand the gate. Ares only ever proposes; the gate decides.

const id = z.string().min(1);
const entryId = z.number().int().positive();
const timestamp = z.number().int().nonnegative();

// The Item a proposed step acts on: an existing Item's id, or the Item an earlier step of the same
// proposal creates ({ step: 0 } is the Item the first step creates).
export const stepTarget = z.union([id, z.object({ step: z.number().int().nonnegative() })]);
export type StepTarget = z.infer<typeof stepTarget>;

// The Item actions a proposal would take, carried out in order through the Item store.
export const proposedItemAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), item: newItem }),
  z.object({ type: z.literal('update'), itemId: stepTarget, changes: itemChanges }),
  z.object({ type: z.literal('delete'), itemId: stepTarget }),
  z.object({ type: z.literal('link'), from: stepTarget, linkType, to: stepTarget }),
  z.object({ type: z.literal('unlink'), from: stepTarget, linkType, to: stepTarget }),
]);
export type ProposedItemAction = z.input<typeof proposedItemAction>;

export const proposal = z.object({
  actionKind,
  // A registered action's id.
  action: z.string().min(1),
  section: autonomySection.nullable(),
  // The Item the proposal is about, where it shows as a suggestion.
  itemId: id,
  itemActions: z.array(proposedItemAction).min(1),
  confidence: z.number().min(0).max(1),
  // Why, in plain words: shown with the suggestion and recorded in the activity log.
  reason: z.string().trim().min(1),
  // What caused it: an Item (the email behind it) and/or an activity entry.
  causedBy: causedBy.optional(),
  // Suggested for another Item because of outside content: always Ask, and shows its cause.
  chained: z.boolean().default(false),
});
export type Proposal = z.input<typeof proposal>;

// A suggestion waits for the User (pending, then accepted or dismissed); a proposal carried out
// automatically is done.
export const proposalStatuses = ['pending', 'accepted', 'dismissed', 'done'] as const;
export const proposalStatus = z.enum(proposalStatuses);
export type ProposalStatus = z.infer<typeof proposalStatus>;

// A proposal the gate kept: an Ask suggestion or an action Ares carried out.
export const proposalRecord = proposal.extend({
  id: z.number().int().positive(),
  at: timestamp,
  causedBy: causedBy.nullable(),
  chained: z.boolean(),
  decision: z.enum(['ask', 'auto']),
  status: proposalStatus,
  settledAt: timestamp.nullable(),
  // The activity entries recorded when it was carried out, in order.
  entryIds: z.array(entryId),
});
export type ProposalRecord = z.infer<typeof proposalRecord>;

export const proposalQuery = z.object({
  itemId: id.optional(),
  actionKinds: z.array(actionKind).optional(),
  section: autonomySection.optional(),
  statuses: z.array(proposalStatus).optional(),
  // Only the proposal whose carrying out recorded this activity entry.
  entryId: entryId.optional(),
  limit: z.number().int().positive().max(1000).optional(),
});
export type ProposalQuery = z.input<typeof proposalQuery>;

// One line of Ares's activity page: a proposal with what it's about, what caused it, and whether
// it can still be undone.
export const aresActivity = proposalRecord.extend({
  // The registered action's name ("Suggest Todos").
  name: z.string(),
  item: itemRef.nullable(),
  cause: z.object({ item: itemRef.nullable(), entry: activityEntry.nullable() }).nullable(),
  undoable: z.boolean(),
});
export type AresActivity = z.infer<typeof aresActivity>;

// What the gate did with a proposal.
export type ProposalOutcome =
  | { decision: 'off' }
  | { decision: 'ask'; suggestion: ProposalRecord }
  | { decision: 'auto'; done: ProposalRecord };

// Where a Settings grid change applies: Everywhere, one Section, or one registered action.
export const autonomyTarget = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('everywhere'), actionKind }),
  z.object({ scope: z.literal('section'), section: autonomySection, actionKind }),
  z.object({ scope: z.literal('action'), action: z.string().min(1) }),
]);
export type AutonomyTarget = z.infer<typeof autonomyTarget>;
