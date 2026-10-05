import { z } from 'zod';
import { emailBucket } from './buckets';
import { eventRuleFields } from './calendar';
import { emailRuleFields } from './email-rules';
import { filing, type Item, itemRef } from './items';
import { teamsRuleFields } from './teams-rules';

// Rules: conditions the User sets that file matching Items into a Project, or sort emails into a
// Bucket (#137). They sit in one list the User orders, and the first match from the top wins (per
// kind of target: a Project Rule and a Bucket Rule can both match one email). A Rule's conditions name fields from a
// per-Source registry (below), so a new Source registers its own fields without changing how Rules
// are stored, matched or described.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// How a field compares: `is` and `is-not` against one of the values Items have for it (a Linear
// team, a label), `contains` against text (a title).
export const ruleOperators = ['is', 'is-not', 'contains'] as const;
export const ruleOperator = z.enum(ruleOperators);
export type RuleOperator = z.infer<typeof ruleOperator>;

export const ruleCondition = z.object({
  // A field from the registry, namespaced by its Source: `linear.team`.
  field: z.string().regex(/^[a-z][a-z-]*\.[a-z-]+$/, 'A Rule condition needs a field'),
  op: ruleOperator,
  // For `is` and `is-not`, the value's stable id (a team's id); for `contains`, the text.
  value: z.string().trim().min(1, 'A Rule condition needs a value'),
  // How the value reads ("ENG"), kept from when the condition was made so the Rule reads the same
  // even when no Item has the value any more.
  label: z.string().trim().min(1),
});
export type RuleCondition = z.infer<typeof ruleCondition>;

export const ruleJoins = ['and', 'or'] as const;
export const ruleJoin = z.enum(ruleJoins);
export type RuleJoin = z.infer<typeof ruleJoin>;

// One level of grouping: "team is ENG AND (label is infra OR label is perf)".
export const ruleGroup = z.object({
  join: ruleJoin,
  conditions: z.array(ruleCondition).min(1, 'A group needs a condition'),
});
export type RuleGroup = z.infer<typeof ruleGroup>;

export const ruleTerm = z.union([ruleCondition, ruleGroup]);
export type RuleTerm = z.infer<typeof ruleTerm>;

export const ruleWhen = z.object({
  join: ruleJoin,
  terms: z.array(ruleTerm).min(1, 'A Rule needs a condition'),
});
export type RuleWhen = z.infer<typeof ruleWhen>;

// What a Rule files matching Items into: a Project, or (emails only) a Bucket. Both kinds sit in the
// same list; the first match per kind of target wins.
export const ruleTargetKinds = ['project', 'bucket'] as const;
export type RuleTargetKind = (typeof ruleTargetKinds)[number];
export const ruleTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), projectId: id }),
  z.object({ kind: z.literal('bucket'), bucketId: id }),
]);
export type RuleTarget = z.infer<typeof ruleTarget>;
export type ProjectTarget = Extract<RuleTarget, { kind: 'project' }>;
export type BucketTarget = Extract<RuleTarget, { kind: 'bucket' }>;

export const rule = z.object({
  id,
  target: ruleTarget,
  when: ruleWhen,
  // Its place in the one list: 0 is the top, checked first.
  order: z.number().int().nonnegative(),
  createdAt: timestamp,
});
export type Rule = z.infer<typeof rule>;

// A Rule as the User writes it, before it has a place in the list.
export const ruleDraft = z.object({ target: ruleTarget, when: ruleWhen });
export type RuleDraft = z.infer<typeof ruleDraft>;

// Where a new or edited Rule goes: an index in the list as it will be (0 is the top). Left out, a
// new Rule goes to the bottom and an edited one stays where it is.
const position = z.number().int().nonnegative();

export const ruleAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), rule: ruleDraft, position: position.optional() }),
  z.object({ type: z.literal('update'), ruleId: id, rule: ruleDraft, position: position.optional() }),
  z.object({ type: z.literal('move'), ruleId: id, position }),
  // Deleting a Rule leaves the Items it filed where they are.
  z.object({ type: z.literal('delete'), ruleId: id }),
  // Brings a deleted Rule back, at the place it had (undoing a delete).
  z.object({ type: z.literal('restore'), ruleId: id }),
]);
export type RuleAction = z.input<typeof ruleAction>;

// An Item a Rule change would move: where it is now and where the Rules file it.
export const refileCandidate = z.object({
  item: itemRef,
  from: filing,
  to: z.object({ projectId: id, filedBy: z.literal('rule') }),
  ruleId: id,
});
export type RefileCandidate = z.infer<typeof refileCandidate>;

// An email a Bucket Rule change would move: its Bucket now (null: Unsorted) and the one the Rules
// sort it into.
export const resortCandidate = z.object({
  item: itemRef,
  from: emailBucket.nullable(),
  to: z.object({ bucketId: id, sortedBy: z.literal('rule') }),
  ruleId: id,
});
export type ResortCandidate = z.infer<typeof resortCandidate>;

// What a Rule change did: the Rule as it is now (null once deleted), and the existing Items the
// changed list now files elsewhere, for "Also re-file 42 existing items?", or the emails it now sorts
// into another Bucket, for "Also re-sort 42 existing emails?". Items the User filed or sorted by hand
// never appear there.
export const ruleChange = z.object({
  rule: rule.nullable(),
  refile: z.array(refileCandidate),
  resort: z.array(resortCandidate).default([]),
});
export type RuleChange = z.infer<typeof ruleChange>;

// The live count and sample for the editor, and the Rules a draft overlaps (they match an Item it
// matches too), which decide where it goes.
export const rulePreviewRequest = z.object({
  rule: ruleDraft,
  // When editing: the Rule being edited, left out of the overlaps.
  ruleId: id.optional(),
  sampleSize: z.number().int().positive().max(50).optional(),
});
export type RulePreviewRequest = z.input<typeof rulePreviewRequest>;

export const rulePreview = z.object({
  count: z.number().int().nonnegative(),
  sample: z.array(itemRef),
  overlaps: z.array(rule),
});
export type RulePreview = z.infer<typeof rulePreview>;

// ---------------------------------------------------------------------------------------------
// The field registry

// One value an Item has for a field: its stable id and how it reads.
export type RuleFieldValue = { value: string; label: string };

export type RuleField = {
  // `linear.team`: the Source, then the field.
  id: string;
  // How the field reads in a Rule: "team is ENG".
  name: string;
  // The editor's label for it: "Team".
  label: string;
  ops: readonly RuleOperator[];
  // The values the Item has for the field; none when it is not that Source's. (A Chat is named by
  // its Teams id, the Item's external id.)
  read(
    item: Pick<Item, 'kind' | 'source' | 'account' | 'title' | 'detail'> & Partial<Pick<Item, 'externalId'>>,
  ): RuleFieldValue[];
};

const linearIssue = (item: Pick<Item, 'detail'>) =>
  item.detail?.kind === 'linear-issue' ? item.detail : null;

const person = (user: { id: string; name: string } | null): RuleFieldValue[] =>
  user ? [{ value: user.id, label: user.name }] : [];

const choices = ['is', 'is-not'] as const;

// Linear's fields: what a Linear issue can be filed by.
export const linearRuleFields: readonly RuleField[] = [
  {
    id: 'linear.workspace',
    name: 'workspace',
    label: 'Workspace',
    ops: choices,
    read: (item) =>
      item.source === 'linear' && item.account ? [{ value: item.account, label: item.account }] : [],
  },
  {
    id: 'linear.team',
    name: 'team',
    label: 'Team',
    ops: choices,
    read: (item) => {
      const issue = linearIssue(item);
      return issue ? [{ value: issue.team.id, label: issue.team.key }] : [];
    },
  },
  {
    id: 'linear.project',
    name: 'Linear project',
    label: 'Linear project',
    ops: choices,
    read: (item) => {
      const project = linearIssue(item)?.linearProject;
      return project ? [{ value: project.id, label: project.name }] : [];
    },
  },
  {
    id: 'linear.label',
    name: 'label',
    label: 'Label',
    ops: choices,
    read: (item) => linearIssue(item)?.labels.map((label) => ({ value: label.id, label: label.name })) ?? [],
  },
  {
    id: 'linear.state',
    name: 'state',
    label: 'State',
    ops: choices,
    read: (item) => {
      const issue = linearIssue(item);
      return issue ? [{ value: issue.state.id, label: issue.state.name }] : [];
    },
  },
  {
    id: 'linear.assignee',
    name: 'assignee',
    label: 'Assignee',
    ops: choices,
    read: (item) => person(linearIssue(item)?.assignee ?? null),
  },
  {
    id: 'linear.creator',
    name: 'creator',
    label: 'Creator',
    ops: choices,
    read: (item) => person(linearIssue(item)?.creator ?? null),
  },
  {
    id: 'linear.title',
    name: 'title',
    label: 'Title',
    ops: ['contains'],
    read: (item) => (item.kind === 'linear-issue' ? [{ value: item.title, label: item.title }] : []),
  },
];

// Google Calendar's and Outlook Calendar's fields: the shared calendar readers (calendar.ts), which
// read the events of both, so a calendar Rule files Google and Microsoft events alike.
export const googleCalendarRuleFields: readonly RuleField[] = eventRuleFields('google-calendar');
export const outlookCalendarRuleFields: readonly RuleField[] = eventRuleFields('outlook-calendar');

// Gmail's and Outlook's fields (#137): the shared email readers (email-rules.ts), which read the mail
// of both, so an email Rule sorts Gmail and Outlook mail alike.
export const gmailRuleFields: readonly RuleField[] = emailRuleFields('gmail');
export const outlookRuleFields: readonly RuleField[] = emailRuleFields('outlook');

// Every Source's fields, by id. A Source adds its fields here (GitHub: org, repo); matching and
// describing need nothing more.
export const RULE_FIELDS: ReadonlyMap<string, RuleField> = new Map(
  [
    ...linearRuleFields,
    ...googleCalendarRuleFields,
    ...outlookCalendarRuleFields,
    ...teamsRuleFields,
    ...gmailRuleFields,
    ...outlookRuleFields,
  ].map((field) => [field.id, field]),
);

// The Sources whose fields Rules can use, with their fields in the editor's order. The calendar and
// email fields read every calendar's events and every Account's mail, so the editor offers them once,
// as Calendar and Email (under the Google ids).
export const RULE_SOURCES: readonly { source: string; name: string; fields: readonly RuleField[] }[] = [
  { source: 'linear', name: 'Linear', fields: linearRuleFields },
  { source: 'calendar', name: 'Calendar', fields: googleCalendarRuleFields },
  { source: 'teams', name: 'Teams', fields: teamsRuleFields },
  { source: 'email', name: 'Email', fields: gmailRuleFields },
];

// ---------------------------------------------------------------------------------------------
// Matching

type Matchable = Parameters<RuleField['read']>[0];

export const isGroup = (term: RuleTerm): term is RuleGroup => 'conditions' in term;

function conditionMatches(condition: RuleCondition, target: Matchable): boolean {
  const field = RULE_FIELDS.get(condition.field);
  if (!field) return false;
  const values = field.read(target);
  switch (condition.op) {
    case 'is':
      return values.some((each) => each.value === condition.value);
    case 'is-not':
      // Only an Item that has the field can lack the value: "team is not ENG" never matches an email.
      return values.length > 0 && !values.some((each) => each.value === condition.value);
    case 'contains': {
      const text = condition.value.toLocaleLowerCase();
      return values.some((each) => each.label.toLocaleLowerCase().includes(text));
    }
  }
}

function joined<T>(join: RuleJoin, terms: readonly T[], matches: (term: T) => boolean): boolean {
  return join === 'and' ? terms.every(matches) : terms.some(matches);
}

// Whether an Item meets a Rule's conditions.
export function ruleMatches(when: RuleWhen, target: Matchable): boolean {
  return joined(when.join, when.terms, (term) =>
    isGroup(term)
      ? joined(term.join, term.conditions, (condition) => conditionMatches(condition, target))
      : conditionMatches(term, target),
  );
}

// The first Rule in the list (in order) that the Item meets, if any.
export function firstMatch<R extends Pick<Rule, 'when'>>(
  rules: readonly R[],
  target: Matchable,
): R | undefined {
  return rules.find((each) => ruleMatches(each.when, target));
}

type RuleOf<K extends RuleTargetKind> = Rule & { target: Extract<RuleTarget, { kind: K }> };

/** A list's Rules of one kind of target, in order. */
export const rulesFor = <K extends RuleTargetKind>(rules: readonly Rule[], kind: K): RuleOf<K>[] =>
  rules.filter((each): each is RuleOf<K> => each.target.kind === kind);

/** The first Rule of one kind of target that the Item meets: the one that files it, or sorts it. */
export function firstMatchFor<K extends RuleTargetKind>(
  rules: readonly Rule[],
  kind: K,
  target: Matchable,
): RuleOf<K> | undefined {
  return firstMatch(rulesFor(rules, kind), target);
}

// ---------------------------------------------------------------------------------------------
// Wording

const OPERATOR_WORDS: Record<RuleOperator, string> = { is: 'is', 'is-not': 'is not', contains: 'contains' };

export function describeCondition(condition: RuleCondition): string {
  const name = RULE_FIELDS.get(condition.field)?.name ?? condition.field;
  const label = condition.op === 'contains' ? `“${condition.label}”` : condition.label;
  return `${name} ${OPERATOR_WORDS[condition.op]} ${label}`;
}

// A Rule's conditions as a sentence: "team is ENG AND (label is infra OR label is perf)".
export function describeRule(when: RuleWhen): string {
  const word = (join: RuleJoin) => ` ${join.toUpperCase()} `;
  return when.terms
    .map((term) => {
      if (!isGroup(term)) return describeCondition(term);
      const inner = term.conditions.map(describeCondition).join(word(term.join));
      return term.conditions.length > 1 && when.terms.length > 1 ? `(${inner})` : inner;
    })
    .join(word(when.join));
}
