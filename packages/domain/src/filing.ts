import { z } from 'zod';
import { source } from './items';
import { RULE_FIELDS, type RuleDraft } from './rules';
import type { QueuedAbout } from './updates';

// Ares files Items into Projects (#71): what the Rules miss, he files himself ("filed under TL by
// Ares") when he is sure, and otherwise leaves the dashed Badge with Confirm and Change. The User's
// answers are corrections and confirmations in the activity log; when enough of them point one
// Source field value at one Project, he asks in the Update whether to make it a Rule.

// The registered action (and job) "File into Projects": Organise, in the Linear Section.
export const FILE_INTO_PROJECTS = 'file-into-projects';

// How many corrections or confirmations pointing one Source field value at one Project make a Rule
// suggestion.
export const RULE_SUGGESTION_AT = 5;

// The Source fields a Rule suggestion can be about: groupings an Item belongs to, most specific
// first. When two point at the same Items, the more specific one is offered. For Chats, the people
// in them (#108): a Chat is one Item, so "this Chat" never counts five, and a whole Teams Account is
// rarely one Project. For events, their calendar (#127), read from Google's and Outlook's alike. For
// GitHub Items (#118), their repo, then its org.
export const RULE_SUGGESTION_FIELDS = [
  'linear.team',
  'linear.project',
  'linear.label',
  'linear.workspace',
  'teams.person',
  'google-calendar.calendar',
  'github.repo',
  'github.org',
];

// Whether a Rule suggestion is about calendar events (its field is a calendar Source's).
export const isCalendarSuggestionField = (field: string) =>
  field.startsWith('google-calendar.') || field.startsWith('outlook-calendar.');

/** The Section a Rule suggestion about this field belongs to, for the Update. */
export const ruleSuggestionSection = (field: string): 'linear' | 'teams' | 'calendar' | 'github' =>
  field.startsWith('teams.')
    ? 'teams'
    : field.startsWith('github.')
      ? 'github'
      : isCalendarSuggestionField(field)
        ? 'calendar'
        : 'linear';

// One of the User's answers to Ares's filing: the Item, his suggestion, and the User's choice (null:
// Unfiled).
export const filingFeedback = z.object({
  entryId: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  kind: z.enum(['correction', 'confirmation']),
  itemId: z.string().min(1),
  suggested: z.string().min(1),
  chosen: z.string().min(1).nullable(),
});
export type FilingFeedback = z.infer<typeof filingFeedback>;

// Ares's filing record, for his activity page: how many Items he filed on his own, how many he
// suggested (the dashed Badge), and how many of them the User confirmed or corrected; in all, and
// by the Items' Source (#108: his filing on Teams, read on its own), in the Sources' order. Items
// made in Commander have no Source (null).
const counts = z.object({
  filed: z.number().int().nonnegative(),
  suggested: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  corrected: z.number().int().nonnegative(),
});
export type FilingCounts = z.infer<typeof counts>;

export const filingRecord = counts.extend({
  bySource: z.array(counts.extend({ source: source.nullable() })),
});
export type FilingRecord = z.infer<typeof filingRecord>;

/** Of the filings the User answered, the share they kept: null before any answer. */
export function filingAccuracy({ confirmed, corrected }: FilingCounts): number | null {
  const answered = confirmed + corrected;
  return answered ? confirmed / answered : null;
}

type RuleSuggestion = Extract<QueuedAbout, { kind: 'rule-suggestion' }>;

/** The Rule a suggestion would make: "team is OPS", filing into its Project. */
export function ruleSuggestionDraft(
  about: Pick<RuleSuggestion, 'field' | 'value' | 'label' | 'projectId'>,
): RuleDraft {
  return {
    target: { kind: 'project', projectId: about.projectId },
    when: { join: 'and', terms: [{ field: about.field, op: 'is', value: about.value, label: about.label }] },
  };
}

/** The question in the Update: "Always file Linear team OPS under TX?". */
export function ruleSuggestionQuestion(about: Pick<RuleSuggestion, 'field' | 'label' | 'code'>): string {
  if (about.field === 'teams.person') return `Always file Chats with ${about.label} under ${about.code}?`;
  // A repo reads as itself: "Always file acme/titanlink-api under TL?".
  if (about.field === 'github.repo') return `Always file ${about.label} under ${about.code}?`;
  if (about.field === 'github.org') return `Always file GitHub org ${about.label} under ${about.code}?`;
  if (isCalendarSuggestionField(about.field)) {
    return `Always file events in ${RULE_FIELDS.get(about.field)?.name ?? 'calendar'} ${about.label} under ${about.code}?`;
  }
  const name = RULE_FIELDS.get(about.field)?.name ?? about.field;
  const source = about.field.split('.')[0] === 'linear' && !name.startsWith('Linear') ? 'Linear ' : '';
  return `Always file ${source}${name} ${about.label} under ${about.code}?`;
}

// How the Items a suggestion counted read, by field: "from team OPS".
const COUNTED: Record<string, (label: string) => string> = {
  'linear.team': (label) => `from team ${label}`,
  'linear.project': (label) => `in Linear project ${label}`,
  'linear.label': (label) => `labelled ${label}`,
  'linear.workspace': (label) => `from workspace ${label}`,
  'teams.person': (label) => `with ${label}`,
  'google-calendar.calendar': (label) => `in calendar ${label}`,
  'github.repo': (label) => `from ${label}`,
  'github.org': (label) => `from org ${label}`,
};

/** The Update's plain sentence: "You filed 5 Linear issues from team OPS under TX. Always file …?" */
export function ruleSuggestionText(
  about: Pick<RuleSuggestion, 'field' | 'label' | 'code' | 'count'>,
): string {
  const counted = COUNTED[about.field]?.(about.label) ?? `with ${about.label}`;
  const items = about.field.startsWith('linear.')
    ? 'Linear issues'
    : about.field.startsWith('teams.')
      ? 'Chats'
      : isCalendarSuggestionField(about.field)
        ? 'events'
        : about.field.startsWith('github.')
          ? 'GitHub Items'
          : 'items';
  return `You filed ${about.count} ${items} ${counted} under ${about.code}. ${ruleSuggestionQuestion(about)}`;
}
