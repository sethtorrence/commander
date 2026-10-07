import {
  type AresActivity,
  dashboardBands,
  type Item,
  type Ranking,
  suggestionItemId,
} from '@commander/domain';

/*
  Ares's suggested Todos on the Dashboard (#72): each pending "Suggest Todos" suggestion is shown as
  the Todo it would add, styled as a suggestion, with Add (the User accepts it through the gate) and
  Dismiss. It isn't an Item yet, so it goes by an id of its own (`suggestion:12`), which Ares's ranking
  uses too. One he hasn't ranked waits at the end of Today, with why he suggested it. One from a Teams
  Chat (#110) opens the Chat at the message it came from; one from an email (#144) opens its thread;
  one from a Daily Note opens its Block.
*/

const SUGGEST_TODOS = 'suggest-todos';

/** What a suggestion row knows besides the Todo it would add. */
export interface SuggestedTodo {
  /** The gate's proposal id: what Add and Dismiss settle. */
  proposalId: number;
  /** The Block it was suggested for (or the Chat, for one from Teams). */
  blockId: string;
  /** Why Ares suggested it, in his words. */
  reason: string;
  /** The Block's text (or the Chat's name): what his words may link to (AresText). */
  source: string;
  /** For one from a Teams Chat (#110): the Chat and the message it came from, where it opens. */
  fromMessage?: { itemId: string; messageId: string };
  /** For one from an email (#144): it opens the email's thread. */
  fromEmail?: boolean;
}

/** A pending Suggest Todos suggestion as a Dashboard row's Item, or null for anything else. */
export function suggestedTodoOf(row: AresActivity): { item: Item; suggestion: SuggestedTodo } | null {
  if (row.status !== 'pending' || row.action !== SUGGEST_TODOS) return null;
  const create = row.itemActions.find((step) => step.type === 'create' && step.item.kind === 'todo');
  if (create?.type !== 'create') return null;
  const item: Item = {
    id: suggestionItemId(row.id),
    kind: 'todo',
    source: null,
    account: null,
    externalId: null,
    title: create.item.title,
    people: [],
    filing: create.item.filing ?? null,
    status: 'open',
    createdAt: row.at,
    updatedAt: row.at,
    deletedAt: null,
    detail: {
      kind: 'todo',
      origin: 'ares',
      dueOn: create.item.detail?.kind === 'todo' ? create.item.detail.dueOn : null,
      backedBy: null,
    },
  };
  const fromMessage = create.item.detail?.kind === 'todo' ? create.item.detail.fromMessage : null;
  return {
    item,
    suggestion: {
      proposalId: row.id,
      blockId: row.itemId,
      reason: row.reason,
      source: row.item?.title ?? '',
      ...(fromMessage && { fromMessage }),
      ...(row.item?.kind === 'email' && { fromEmail: true }),
    },
  };
}

/**
 * The rankings with the suggestions no one ranked added at the end of Today. `decided`: the ids Ares
 * ranked (into a band or none), which stay as he put them.
 */
export function withSuggestions(
  rankings: readonly Ranking[],
  suggested: readonly { item: Item; suggestion: SuggestedTodo }[],
  decided: ReadonlySet<string>,
): Ranking[] {
  const placed = new Set(rankings.map((ranking) => ranking.itemId));
  const waiting = suggested.filter(({ item }) => !placed.has(item.id) && !decided.has(item.id));
  if (!waiting.length) return [...rankings];
  const today = rankings.filter((ranking) => ranking.band === 'today').length;
  const added: Ranking[] = waiting.map(({ item, suggestion }, index) => ({
    itemId: item.id,
    band: 'today',
    rank: today + index + 1,
    reason: suggestion.reason,
  }));
  return dashboardBands.flatMap((band) => [
    ...rankings.filter((ranking) => ranking.band === band),
    ...added.filter((ranking) => ranking.band === band),
  ]);
}
