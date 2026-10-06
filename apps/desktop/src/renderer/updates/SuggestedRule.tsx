import { bucketRuleSuggestionDraft, type QueuedAbout, ruleSuggestionDraft } from '@commander/domain';
import { useEffect, useMemo } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import { useRuleFlow } from '../rules/rule-flow';
import { rulesIn } from '../rules/rules';

export type RuleSuggestion = {
  // A Rule filing into a Project (#71), or a Bucket Rule sorting email (#141).
  about: Extract<QueuedAbout, { kind: 'rule-suggestion' | 'bucket-rule-suggestion' }>;
  queuedId: number;
  // A fresh one each time the User accepts, so accepting again reopens the editor.
  at: number;
};

/**
 * Accepting "Always file Linear team OPS under TX?" in the Update (#71): the Rule editor opens with
 * the Rule filled in, to go at the top of the list unless the User places it (the overlap question
 * asks, as for any Rule), and saving it offers to re-file the existing Items it now matches. Once the
 * Rule is saved, the line is done; cancelled, it stays queued.
 */
export function SuggestedRule({
  suggestion,
  itemStore = window.commander.itemStore,
  onSaved,
}: {
  suggestion: RuleSuggestion;
  itemStore?: ItemStoreClient;
  onSaved: (queuedId: number) => void;
}) {
  const client = useMemo(() => rulesIn(itemStore), [itemStore]);
  const flow = useRuleFlow(client);
  const { edit } = flow;

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once for each acceptance (`at`)
  useEffect(() => {
    const { about, queuedId } = suggestion;
    edit(null, undefined, {
      draft: about.kind === 'rule-suggestion' ? ruleSuggestionDraft(about) : bucketRuleSuggestionDraft(about),
      position: 0,
      onSaved: () => onSaved(queuedId),
    });
  }, [suggestion.at]);

  return <>{flow.ui}</>;
}
