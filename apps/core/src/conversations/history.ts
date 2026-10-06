// What of a Conversation goes back to the model with each answer (#191): its earlier turns, as its
// history, within a budget, oldest dropped first.
import { type ConversationTurn, LINK_MARKER } from '@commander/domain';
import type { PromptTurn } from '../agent/prompt';

// About 12,000 tokens of history (at roughly four characters a token): plenty for a Conversation's
// thread, and well inside the Deep tier's context with room for the answer.
export const HISTORY_BUDGET_CHARS = 48_000;

/**
 * The turns that are the history for answering the User's turn `replyTo`: the User's turns and what
 * Ares said (an answer stopped early counts, as far as it got; a failed one doesn't), up to that turn.
 */
export function historyOf(turns: readonly ConversationTurn[], replyTo: number): PromptTurn[] {
  return turns
    .filter((turn) => turn.id <= replyTo)
    .filter(
      (turn) =>
        turn.by === 'user' ||
        ((turn.status === 'done' || turn.status === 'stopped') && turn.text.trim() !== ''),
    )
    .map((turn) => ({ by: turn.by, text: turn.by === 'ares' ? withoutRefs(turn.text) : turn.text }));
}

/**
 * His earlier answer without its refs ([I1]): those named what he was handed for that answer, and a
 * later answer's refs start again, so they would point at the wrong Items.
 */
export const withoutRefs = (text: string) =>
  text.replace(new RegExp(`[ \\t]?${LINK_MARKER.source}`, 'g'), '');

/**
 * The most recent turns that fit the budget (in characters), oldest dropped first. The last turn (the
 * User's message being answered) always stays, and what is kept starts with one of the User's turns.
 */
export function historyWithin(turns: readonly PromptTurn[], budget = HISTORY_BUDGET_CHARS): PromptTurn[] {
  if (!turns.length) return [];
  let start = 0;
  let size = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  while (size > budget && start < turns.length - 1) {
    size -= (turns[start] as PromptTurn).text.length;
    start += 1;
  }
  while (start < turns.length - 1 && turns[start]?.by === 'ares') start += 1;
  return turns.slice(start);
}
