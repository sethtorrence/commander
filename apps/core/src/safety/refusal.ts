// Visible refusals (#201): when the prompt builder (or the models wiring) won't send a prompt because
// its material holds one of the User's keys or sign-in tokens, the Items it came from are recorded as
// skipped (item-store/refusals.ts): an activity entry the Update counts, and a note on each Item.
// What is recorded says what was skipped and why, never the secret.
import type { PromptRefused } from '../agent/prompt';
import type { RefusalStore } from '../item-store';

/**
 * Records the Items a refusal names as skipped by a job. Returns the Items newly noted, so open views
 * catch up (an Item already noted for the words it has now is left as it is).
 */
export function heedRefusal(
  refusal: PromptRefused,
  job: string,
  refusals: Pick<RefusalStore, 'record'> | undefined,
  onItemsChanged?: (itemIds: string[]) => void,
): string[] {
  if (!refusals || !refusal.itemIds.length) return [];
  const noted = [...new Set(refusals.record(refusal.itemIds, job).map((entry) => entry.itemId))];
  if (noted.length) onItemsChanged?.(noted);
  return noted;
}
