import {
  type GitHubSummaries,
  type GitHubSummaryAnswer,
  type GitHubSummaryItem,
  isGitHubSummary,
  localDay,
  type OversightRangeChoice,
  type OversightRangeSpan,
  type OversightSummary,
  oversightRange,
  type PlainLine,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import type { UpdatesClient } from '../../updates/updates';

/*
  The oversight summary at the top of the GitHub Section: Ares's (#121) when he has written one for
  what is shown, else the plain lines the Core makes from the GitHub Items and repo health (#119), for
  a range (Since yesterday, This week, Custom since a day) and a scope (everything, one Project, or
  Unfiled). His summaries are kept, so Past summaries reopens any of them.
*/

/** Everything, one Project (its id) or Unfiled. */
export type OversightScope = 'everything' | 'unfiled' | string;

export interface OversightClient {
  /** The summary's facts for a span of time, over a scope. */
  summary(range: OversightRangeSpan, scope: OversightScope): Promise<OversightSummary>;
  /** Ares's summaries, newest first, with how his writing stands. */
  summaries?(): Promise<GitHubSummaries>;
  /** Ask Ares to write it, for a span and scope: the summary he wrote, or why there is none. */
  ask?(
    range: OversightRangeSpan,
    scope: OversightScope,
    choice: OversightRangeChoice,
  ): Promise<GitHubSummaryAnswer>;
  /** The User opened one of his summaries. */
  seen?(itemId: string): Promise<void>;
  /** One of his summaries, by its id; null when the id is something else. */
  find?(itemId: string): Promise<GitHubSummaryItem | null>;
}

const projectIdOf = (scope: OversightScope) => (scope === 'unfiled' ? null : scope);

export function oversightIn(itemStore: ItemStoreClient, updates?: UpdatesClient): OversightClient {
  return {
    summary(range, scope) {
      return itemStore({
        op: 'github-oversight',
        range,
        ...(scope !== 'everything' && { projectId: projectIdOf(scope) }),
      });
    },
    summaries: () => itemStore({ op: 'github-summaries', limit: 100 }),
    ...(updates && {
      ask: (range: OversightRangeSpan, scope: OversightScope, choice: OversightRangeChoice) =>
        updates({
          op: 'summarise-github',
          request: { range, choice, ...(scope !== 'everything' && { projectId: projectIdOf(scope) }) },
        }),
    }),
    async seen(itemId) {
      await itemStore({ op: 'github-summary-seen', itemId });
    },
    async find(itemId) {
      const view = await itemStore({ op: 'get', itemId });
      return isGitHubSummary(view?.item) ? view.item : null;
    },
  };
}

/** The scope a summary covers, as the Project picker says it. */
export function scopeOf(summary: GitHubSummaryItem): OversightScope {
  const { projectId } = summary.detail;
  return projectId === undefined ? 'everything' : projectId === null ? 'unfiled' : projectId;
}

const sameChoice = (a: OversightRangeChoice | null, b: OversightRangeChoice) =>
  !!a && a.kind === b.kind && (a.kind !== 'since' || (b.kind === 'since' && a.day === b.day));

/**
 * Ares's summary for what the pickers show, written today: one asked for with the same range and
 * scope, or (since yesterday, over everything) today's daily summary. Null when he hasn't written one.
 */
export function summaryFor(
  summaries: readonly GitHubSummaryItem[],
  choice: OversightRangeChoice,
  scope: OversightScope,
  now: number,
): GitHubSummaryItem | null {
  const today = localDay(now);
  return (
    summaries.find((summary) => {
      const { detail } = summary;
      if (localDay(detail.writtenAt) !== today || scopeOf(summary) !== scope) return false;
      if (detail.cadence === 'on-demand') return sameChoice(detail.choice, choice);
      return detail.cadence === 'daily' && choice.kind === 'since-yesterday';
    }) ?? null
  );
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

export function targetOf(line: Pick<PlainLine, 'itemIds' | 'repo' | 'text'>): LineTarget {
  if (line.itemIds.length === 1) return { kind: 'item', itemId: line.itemIds[0] as string };
  if (line.itemIds.length > 1) return { kind: 'items', itemIds: line.itemIds, label: line.text };
  return { kind: 'repo', repo: `${line.repo.owner}/${line.repo.name}` };
}
