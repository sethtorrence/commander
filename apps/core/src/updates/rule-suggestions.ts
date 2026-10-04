// "Suggest rules" (#71): when the User keeps answering Ares's filing the same way, he offers a Rule
// in the next Update. A producer for his queue, looking whenever the others do.
//
// - Counts each Item once, by the User's latest correction or confirmation of it, and the Item's
//   Source field values as they are now (team, Linear project, label, workspace).
// - A value is suggested for a Project when at least RULE_SUGGESTION_AT Items with it went there and
//   every answer for that value chose it (one that went elsewhere, or Unfiled, means the pattern
//   isn't clear yet). When a more specific field points at the same Items (team over workspace), only
//   it is offered.
// - Nothing is offered for a Project that is gone or archived, or when a Rule already files every
//   one of those Items. Each suggestion is offered once: dismissed (or accepted) it never comes back.
// - It needs no model: the pattern is a count, and "Put Updates together" words the line.
import {
  firstMatch,
  type Item,
  RULE_FIELDS,
  RULE_SUGGESTION_AT,
  RULE_SUGGESTION_FIELDS,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { UpdateQueue } from './queue';

const IMPORTANCE = 0.5;

type Candidate = { field: string; value: string; label: string; projectId: string; itemIds: Set<string> };

const specificity = (field: string) => RULE_SUGGESTION_FIELDS.indexOf(field);

export const ruleSuggestionKey = ({
  field,
  value,
  projectId,
}: Pick<Candidate, 'field' | 'value' | 'projectId'>) => `rule-suggestion:${field}:${value}:${projectId}`;

export function createRuleSuggestions({ itemStore, queue }: { itemStore: ItemStore; queue: UpdateQueue }) {
  function candidates(): Candidate[] {
    // Each Item's latest answer (feedback is newest first).
    const latest = new Map<string, string | null>();
    for (const answer of itemStore.filing.feedback()) {
      if (!latest.has(answer.itemId)) latest.set(answer.itemId, answer.chosen);
    }
    // By field and value: where each Item went, and how the value reads.
    const byValue = new Map<
      string,
      { field: string; value: string; label: string; went: Map<string | null, Set<string>> }
    >();
    for (const [itemId, chosen] of latest) {
      const item = itemStore.get(itemId)?.item;
      if (!item || item.deletedAt !== null) continue;
      for (const field of RULE_SUGGESTION_FIELDS) {
        for (const { value, label } of RULE_FIELDS.get(field)?.read(item) ?? []) {
          const key = `${field}\u0000${value}`;
          const found = byValue.get(key) ?? { field, value, label, went: new Map() };
          byValue.set(key, found);
          found.went.set(chosen, (found.went.get(chosen) ?? new Set()).add(itemId));
        }
      }
    }
    const live = new Set(itemStore.projects().map((project) => project.id));
    const found: Candidate[] = [];
    for (const { field, value, label, went } of byValue.values()) {
      if (went.size !== 1) continue;
      const [[projectId, itemIds]] = [...went] as [[string | null, Set<string>]];
      if (!projectId || !live.has(projectId) || itemIds.size < RULE_SUGGESTION_AT) continue;
      found.push({ field, value, label, projectId, itemIds });
    }
    // Only the most specific field for the same Items.
    return found.filter(
      (each) =>
        !found.some(
          (other) =>
            other !== each &&
            other.projectId === each.projectId &&
            specificity(other.field) < specificity(each.field) &&
            [...each.itemIds].every((id) => other.itemIds.has(id)),
        ),
    );
  }

  // Whether a Rule already files every one of these Items.
  function covered(itemIds: Iterable<string>): boolean {
    const rules = itemStore.rules();
    return [...itemIds].every((id) => {
      const item = itemStore.get(id)?.item as Item | undefined;
      return !!item && !!firstMatch(rules, item);
    });
  }

  return {
    sweep() {
      for (const candidate of candidates()) {
        const mergeKey = ruleSuggestionKey(candidate);
        if (itemStore.updates.lastWithKey(mergeKey) || covered(candidate.itemIds)) continue;
        const code = itemStore.projectRef(candidate.projectId)?.code;
        if (!code) continue;
        queue.enqueue({
          group: 'decision',
          mergeKey,
          about: {
            kind: 'rule-suggestion',
            field: candidate.field,
            value: candidate.value,
            label: candidate.label,
            projectId: candidate.projectId,
            code,
            count: candidate.itemIds.size,
          },
          itemIds: [...candidate.itemIds],
          section: 'linear',
          importance: IMPORTANCE,
        });
      }
    },
  };
}
