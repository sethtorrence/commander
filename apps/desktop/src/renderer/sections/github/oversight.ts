import {
  type OversightRangeChoice,
  type OversightRangeSpan,
  type OversightSummary,
  oversightRange,
  type PlainLine,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';

/*
  The oversight summary at the top of the GitHub Section (#119), in plain lines: what the
  Core makes from the GitHub Items and repo health, for a range (Since yesterday, This week, Custom
  since a day) and a scope (everything, one Project, or Unfiled). Ares writes it properly in #121;
  until then, and whenever he can't, this is it.
*/

/** Everything, one Project (its id) or Unfiled. */
export type OversightScope = 'everything' | 'unfiled' | string;

export interface OversightClient {
  /** The summary for a span of time, over a scope. */
  summary(range: OversightRangeSpan, scope: OversightScope): Promise<OversightSummary>;
}

export function oversightIn(itemStore: ItemStoreClient): OversightClient {
  return {
    summary(range, scope) {
      return itemStore({
        op: 'github-oversight',
        range,
        ...(scope !== 'everything' && { projectId: scope === 'unfiled' ? null : scope }),
      });
    },
  };
}

/** The machine's time zone, which the ranges are reckoned in. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The span a range choice covers now. */
export function spanOf(
  choice: OversightRangeChoice,
  now: number,
  timeZone = localTimeZone(),
): OversightRangeSpan {
  return oversightRange(choice, now, timeZone);
}

/** What a summary line opens: one Item, several (shown together in the list), or its repo. */
export type LineTarget =
  | { kind: 'item'; itemId: string }
  | { kind: 'items'; itemIds: string[]; label: string }
  | { kind: 'repo'; repo: string };

export function targetOf(line: PlainLine): LineTarget {
  if (line.itemIds.length === 1) return { kind: 'item', itemId: line.itemIds[0] as string };
  if (line.itemIds.length > 1) return { kind: 'items', itemIds: line.itemIds, label: line.text };
  return { kind: 'repo', repo: `${line.repo.owner}/${line.repo.name}` };
}
