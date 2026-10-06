// Bucket Rule suggestions (#141): the "Suggest rules" producer (#71) for email. When the User keeps
// answering Ares's sorting the same way, he offers a Bucket Rule in the next Update ("Always put mail
// from stripe.com in Receipts?"). A producer for his queue, looking whenever the others do.
//
// - Counts each email once, by the User's latest correction or confirmation of it, and the email's
//   sender address, sender domain (and its parents) and mailing list.
// - A value is suggested for a Bucket when at least RULE_SUGGESTION_AT emails with it went there and
//   every answer for that value chose it (one that went elsewhere, or to Unsorted, means the pattern
//   isn't clear yet). When a more specific field points at the same emails (a mailing list over its
//   sender, a sender over their domain), only it is offered; of a domain and its parent pointing at
//   the same emails, the parent ("stripe.com" over "email.stripe.com").
// - Nothing is offered for a Bucket that is gone, or when a Bucket Rule already sorts every one of
//   those emails. Each suggestion is offered once: dismissed (or accepted) it never comes back.
// - It needs no model: the pattern is a count, and "Put Updates together" words the line.
import {
  BUCKET_RULE_SUGGESTION_FIELDS,
  firstMatchFor,
  RULE_FIELDS,
  RULE_SUGGESTION_AT,
} from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { UpdateQueue } from './queue';

const IMPORTANCE = 0.5;

type Candidate = { field: string; value: string; label: string; bucketId: string; itemIds: Set<string> };

const specificity = (field: string) => BUCKET_RULE_SUGGESTION_FIELDS.indexOf(field);
const sameItems = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));

export const bucketRuleSuggestionKey = ({
  field,
  value,
  bucketId,
}: Pick<Candidate, 'field' | 'value' | 'bucketId'>) => `bucket-rule-suggestion:${field}:${value}:${bucketId}`;

export function createBucketRuleSuggestions({
  itemStore,
  queue,
}: {
  itemStore: ItemStore;
  queue: UpdateQueue;
}) {
  function candidates(): Candidate[] {
    // Each email's latest answer (feedback is newest first).
    const latest = new Map<string, string | null>();
    for (const answer of itemStore.emailSorting.feedback()) {
      if (!latest.has(answer.itemId)) latest.set(answer.itemId, answer.chosen);
    }
    const byValue = new Map<
      string,
      { field: string; value: string; label: string; went: Map<string | null, Set<string>> }
    >();
    for (const [itemId, chosen] of latest) {
      const item = itemStore.get(itemId)?.item;
      if (!item || item.deletedAt !== null) continue;
      for (const field of BUCKET_RULE_SUGGESTION_FIELDS) {
        for (const { value, label } of RULE_FIELDS.get(field)?.read(item) ?? []) {
          const key = `${field}\u0000${value}`;
          const found = byValue.get(key) ?? { field, value, label, went: new Map() };
          byValue.set(key, found);
          found.went.set(chosen, (found.went.get(chosen) ?? new Set()).add(itemId));
        }
      }
    }
    const live = new Set(itemStore.buckets().map((bucket) => bucket.id));
    const found: Candidate[] = [];
    for (const { field, value, label, went } of byValue.values()) {
      if (went.size !== 1) continue;
      const [[bucketId, itemIds]] = [...went] as [[string | null, Set<string>]];
      if (!bucketId || !live.has(bucketId) || itemIds.size < RULE_SUGGESTION_AT) continue;
      found.push({ field, value, label, bucketId, itemIds });
    }
    // Only the most specific field for the same emails; of the same field, the shortest value (a
    // domain's parent).
    const beats = (other: Candidate, each: Candidate) =>
      specificity(other.field) < specificity(each.field) ||
      (other.field === each.field && other.value.length < each.value.length);
    return found.filter(
      (each) =>
        !found.some(
          (other) =>
            other !== each &&
            other.bucketId === each.bucketId &&
            beats(other, each) &&
            (other.field === each.field
              ? sameItems(other.itemIds, each.itemIds)
              : [...each.itemIds].every((id) => other.itemIds.has(id))),
        ),
    );
  }

  // Whether a Bucket Rule already sorts every one of these emails.
  function covered(itemIds: Iterable<string>): boolean {
    const rules = itemStore.rules();
    return [...itemIds].every((id) => {
      const item = itemStore.get(id)?.item;
      return !!item && !!firstMatchFor(rules, 'bucket', item);
    });
  }

  return {
    sweep() {
      for (const candidate of candidates()) {
        const mergeKey = bucketRuleSuggestionKey(candidate);
        if (itemStore.updates.lastWithKey(mergeKey) || covered(candidate.itemIds)) continue;
        const name = itemStore.buckets().find((bucket) => bucket.id === candidate.bucketId)?.name;
        if (!name) continue;
        queue.enqueue({
          group: 'decision',
          mergeKey,
          about: {
            kind: 'bucket-rule-suggestion',
            field: candidate.field,
            value: candidate.value,
            label: candidate.label,
            bucketId: candidate.bucketId,
            name,
            count: candidate.itemIds.size,
          },
          itemIds: [...candidate.itemIds],
          section: 'email',
          importance: IMPORTANCE,
        });
      }
    },
  };
}
