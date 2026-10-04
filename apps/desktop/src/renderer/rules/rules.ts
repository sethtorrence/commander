import {
  type ActivityEntry,
  describeRule,
  type Item,
  isGroup,
  type Project,
  RULE_FIELDS,
  type Rule,
  type RuleAction,
  type RuleChange,
  type RuleCondition,
  type RuleDraft,
  type RuleFieldValue,
  type RulePreview,
  type RuleTerm,
  type RuleWhen,
} from '@commander/domain';
import type { ItemStoreClient } from '../item-store/client';

/*
  The renderer's view of Rules in the Item store: the one ordered list, changing it, the editor's live
  preview, and re-filing existing Items after a change. Matching happens in the Core; the field
  registry (which fields each Source offers, and how a Rule reads) comes from @commander/domain.
*/

export interface RulesClient {
  /** The Rules in their order: the first that matches an Item files it. */
  list(): Promise<Rule[]>;
  /** Creates, edits, moves, deletes or restores a Rule; answers with the Items it would re-file. */
  change(action: RuleAction): Promise<RuleChange>;
  /** The editor's live count and sample, and the Rules a draft overlaps. */
  preview(rule: RuleDraft, ruleId?: string): Promise<RulePreview>;
  /** Re-files these Items by the Rules, as one change. */
  refile(itemIds: string[]): Promise<ActivityEntry[]>;
  /** Undoes a re-filing, all at once. */
  undoRefile(entryIds: number[]): Promise<ActivityEntry[]>;
  /** The Items whose values the editor offers (every Linear issue, calendar event and Chat held). */
  items(): Promise<Item[]>;
}

export function rulesIn(itemStore: ItemStoreClient): RulesClient {
  return {
    list: () => itemStore({ op: 'rules' }),
    change: (action) => itemStore({ op: 'change-rule', action }),
    preview: (rule, ruleId) => itemStore({ op: 'preview-rule', request: { rule, ruleId, sampleSize: 6 } }),
    refile: (itemIds) => itemStore({ op: 'refile', itemIds }),
    undoRefile: (entryIds) => itemStore({ op: 'undo-refile', entryIds }),
    items: () => itemStore({ op: 'query', query: { kinds: ['linear-issue', 'event', 'chat'], limit: 1000 } }),
  };
}

/** A Rule as it reads in a list: "team is ENG → TL". */
export function ruleText(rule: Pick<Rule, 'when' | 'target'>, projects: readonly Project[]): string {
  const project = projects.find((p) => p.id === rule.target.projectId);
  return `${describeRule(rule.when)} → ${project?.code ?? '?'}`;
}

/**
 * The values held Items have for a field, for the editor's choices: each once, sorted by how they
 * read. `names` renames values the Items only know by id (a workspace's Account).
 */
export function fieldChoices(
  items: readonly Item[],
  fieldId: string,
  names: ReadonlyMap<string, string> = new Map(),
): RuleFieldValue[] {
  const field = RULE_FIELDS.get(fieldId);
  if (!field) return [];
  const seen = new Map<string, RuleFieldValue>();
  for (const item of items) {
    for (const each of field.read(item)) {
      if (!seen.has(each.value))
        seen.set(each.value, { ...each, label: names.get(each.value) ?? each.label });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** A place a Rule can go, said against the Rules it overlaps: "Above team is ENG → TL". */
export type Placement = { position: number; label: string };

/**
 * Where a new or edited Rule can go when it overlaps other Rules: above or below each of them, as
 * positions in the list without the Rule itself (what the Core expects).
 */
export function placements(
  rules: readonly Rule[],
  overlaps: readonly Rule[],
  projects: readonly Project[],
  editing?: string,
): Placement[] {
  const others = rules.filter((rule) => rule.id !== editing);
  const overlapping = new Set(overlaps.map((rule) => rule.id));
  const byPosition = new Map<number, string[]>();
  others.forEach((rule, index) => {
    if (!overlapping.has(rule.id)) return;
    const text = ruleText(rule, projects);
    byPosition.set(index, [...(byPosition.get(index) ?? []), `above ${text}`]);
    byPosition.set(index + 1, [`below ${text}`, ...(byPosition.get(index + 1) ?? [])]);
  });
  return [...byPosition.entries()]
    .sort(([a], [b]) => a - b)
    .map(([position, words]) => {
      const label = words.join(', ');
      return { position, label: label.charAt(0).toUpperCase() + label.slice(1) };
    });
}

// ---------------------------------------------------------------------------------------------
// Drafts in the editor

/** A condition being written: the value may still be empty. */
export type ConditionDraft = { field: string; op: RuleCondition['op']; value: string; label: string };
export type TermDraft = ConditionDraft | { join: RuleWhen['join']; conditions: ConditionDraft[] };
export type WhenDraft = { join: RuleWhen['join']; terms: TermDraft[] };

export const isGroupDraft = (term: TermDraft): term is Extract<TermDraft, { conditions: unknown }> =>
  'conditions' in term;

export function newCondition(fieldId = 'linear.team'): ConditionDraft {
  const field = RULE_FIELDS.get(fieldId);
  return { field: fieldId, op: field?.ops[0] ?? 'is', value: '', label: '' };
}

export const newGroup = (): TermDraft => ({ join: 'or', conditions: [newCondition('linear.label')] });

/** A Rule's conditions as the editor holds them. */
export function whenDraftOf(when?: RuleWhen): WhenDraft {
  if (!when) return { join: 'and', terms: [newCondition()] };
  const copy = (term: RuleTerm): TermDraft =>
    isGroup(term) ? { join: term.join, conditions: term.conditions.map((c) => ({ ...c })) } : { ...term };
  return { join: when.join, terms: when.terms.map(copy) };
}

const complete = (condition: ConditionDraft) => condition.value.trim() !== '';

/** The conditions as a Rule can hold them, or null while any is unfinished. */
export function whenOf(draft: WhenDraft): RuleWhen | null {
  const conditionOf = (c: ConditionDraft): RuleCondition => ({
    field: c.field,
    op: c.op,
    value: c.value.trim(),
    label: (c.op === 'contains' ? c.value : c.label || c.value).trim(),
  });
  if (!draft.terms.length) return null;
  const terms: RuleTerm[] = [];
  for (const term of draft.terms) {
    if (isGroupDraft(term)) {
      if (!term.conditions.length || !term.conditions.every(complete)) return null;
      terms.push({ join: term.join, conditions: term.conditions.map(conditionOf) });
    } else {
      if (!complete(term)) return null;
      terms.push(conditionOf(term));
    }
  }
  return { join: draft.join, terms };
}
