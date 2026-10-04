import { z } from 'zod';
import { openWorkFacts } from './github-open-work';
import type { Item } from './items';
import {
  type DashboardBand,
  dashboardBands,
  dashboardCandidates,
  localDay,
  type Ranker,
  type Ranking,
  rankByBandRules,
} from './ranking';

/*
  Ares's ranking of the Dashboard (#72), as the window applies it.

  Ares's "Rank the Dashboard" job runs in the Core after each sync and when Todos change. It gives
  each open Item that may need the User a band (or none), a rank in it and a short reason in his own
  words, and the Core keeps that ranking, each entry with a fingerprint of the Item as he saw it. The
  window reads it and ranks with `aresRanker`, which implements the same Ranker interface as the band
  rules and falls back to them:

  - for an Item he ranked as it still is, his band, rank and reason (none: off the Dashboard);
  - for an Item he hasn't ranked, or that changed since, the rules' place for it, if they have one
    (an Item that changed and that the rules leave out keeps his last word until he ranks again);
  - the rules alone whenever his ranking can't be used: Ares is off for ranking, his last run failed,
    he hasn't ranked yet, or his ranking is from another day (his reasons speak of days).

  Pending "Suggest Todos" suggestions are ranked too, under ids of their own (`suggestion:12`).
*/

/** The job that ranks the Dashboard, and the action it registers (Organise, in no one Section). */
export const RANK_DASHBOARD = 'rank-dashboard';

const SUGGESTION_PREFIX = 'suggestion:';
/** A pending suggestion's place in a ranking: not an Item yet, so an id of its own. */
export const suggestionItemId = (proposalId: number) => `${SUGGESTION_PREFIX}${proposalId}`;
export const isSuggestionItemId = (itemId: string) => itemId.startsWith(SUGGESTION_PREFIX);

const timestamp = z.number().int().nonnegative();

export const aresBands = [...dashboardBands, 'none'] as const;
export const aresBand = z.enum(aresBands);
export type AresBand = z.infer<typeof aresBand>;

/** One Item as Ares ranked it: its band (or none), its rank there, his reason, and the Item as he saw it. */
export const aresRankingEntry = z.object({
  itemId: z.string().min(1),
  band: aresBand,
  rank: z.number().int().positive(),
  reason: z.string().max(300),
  fingerprint: z.string().min(1),
});
export type AresRankingEntry = z.infer<typeof aresRankingEntry>;

/**
 * The Dashboard's ranking as the Core keeps it: Ares's (with when he made it), or the rules' with
 * why, in plain words ("Ares is off for ranking"). The rules' carries no entries.
 */
export const dashboardRanking = z.object({
  by: z.enum(['ares', 'rules']),
  at: timestamp.nullable(),
  why: z.string().nullable(),
  entries: z.array(aresRankingEntry),
});
export type DashboardRanking = z.infer<typeof dashboardRanking>;

/** A row cleared from the Dashboard: the band it was in, and when. It stays off until its band changes. */
export const clearMark = z.object({ band: z.enum(dashboardBands), at: timestamp });
export type ClearMark = z.infer<typeof clearMark>;
/** The cleared rows, by Item id. */
export const dashboardClears = z.record(z.string().min(1), clearMark);
export type DashboardClears = Readonly<Record<string, ClearMark>>;

/** What the Dashboard reads from the Core: the ranking and the cleared rows. */
export const dashboardState = z.object({ ranking: dashboardRanking, clears: dashboardClears });
export type DashboardState = z.infer<typeof dashboardState>;

// FNV-1a, twice over with different seeds: short, stable and the same in the window and the Core.
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193 + 2);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/**
 * What Ares ranks an Item by, as a short fingerprint: its title, status, Project and due date, a
 * Todo's origin and backing Item, a Linear issue's state, priority, assignee, cycle and last
 * change, and a Chat's latest message, when it was read, its flags and whether Ares flagged it as
 * waiting on the User. When it changes, his ranking of the Item no longer holds.
 */
export function rankingFingerprint(item: Item): string {
  const facts: unknown[] = [
    item.kind,
    item.title,
    item.status,
    item.deletedAt,
    item.filing?.projectId ?? null,
  ];
  const { detail } = item;
  if (detail?.kind === 'todo') facts.push(detail.origin, detail.dueOn, detail.backedBy);
  if (detail?.kind === 'linear-issue') {
    facts.push(
      detail.state.id,
      detail.priority,
      detail.assignee?.id ?? null,
      detail.cycle?.id ?? null,
      detail.dueDate,
      detail.updatedAt,
    );
  }
  // A Chat: what the band rules go by, so a newer message, a read or a reply means he ranks it again.
  if (detail?.kind === 'chat') {
    facts.push(
      detail.chatType,
      detail.lastMessageAt,
      detail.lastReadAt,
      detail.mentionsMe,
      detail.latestFromMe,
      detail.messages.at(-1)?.id ?? null,
      item.waiting?.messageId ?? null,
      item.waiting?.reason ?? null,
    );
  }
  facts.push(...openWorkFacts(item));
  return hash(JSON.stringify(facts));
}

/** Who ranked the Dashboard and when, at `now`: Ares's ranking counts only on the day he made it. */
export function rankingOrigin(
  ranking: DashboardRanking | null,
  now: number,
): { by: 'ares' | 'rules'; at: number | null; why: string | null } {
  if (!ranking) return { by: 'rules', at: null, why: null };
  if (ranking.by === 'rules') return { by: 'rules', at: null, why: ranking.why };
  if (ranking.at === null || localDay(ranking.at) !== localDay(now))
    return { by: 'rules', at: null, why: 'Ares hasn’t ranked it today yet' };
  return { by: 'ares', at: ranking.at, why: null };
}

/**
 * A Ranker from Ares's ranking, falling back to `fallback` (the band rules): within each band, his
 * Items in his order, then those the rules placed in theirs.
 */
export function aresRanker(ranking: DashboardRanking | null, fallback: Ranker = rankByBandRules): Ranker {
  return (items, context) => {
    if (!ranking || rankingOrigin(ranking, context.now).by !== 'ares') return fallback(items, context);
    const entries = new Map(ranking.entries.map((entry) => [entry.itemId, entry]));
    const candidates = dashboardCandidates(items, context.muted);
    const byId = new Map(candidates.map((item) => [item.id, item]));
    // The rules see every Item, as they pick their own candidates (a review request needs its Todo).
    const ruled = new Map(fallback(items, context).map((found) => [found.itemId, found]));
    const his: AresRankingEntry[] = [];
    const theirs: Ranking[] = [];
    for (const item of candidates) {
      const entry = entries.get(item.id);
      const rules = ruled.get(item.id);
      if (entry && (entry.fingerprint === rankingFingerprint(item) || !rules)) {
        if (entry.band !== 'none') his.push(entry);
      } else if (rules) theirs.push(rules);
    }
    // A meeting about to start (placed by the rules: Ares isn't given events) can't wait: it goes first.
    const meetings = theirs.filter((found) => byId.get(found.itemId)?.kind === 'event');
    const others = theirs.filter((found) => byId.get(found.itemId)?.kind !== 'event');
    return dashboardBands.flatMap((band: DashboardBand) =>
      [
        ...meetings
          .filter((found) => found.band === band)
          .sort((a, b) => a.rank - b.rank)
          .map(({ itemId, reason }) => ({ itemId, reason })),
        ...his
          .filter((entry) => entry.band === band)
          .sort((a, b) => a.rank - b.rank)
          .map(({ itemId, reason }) => ({ itemId, reason })),
        ...others
          .filter((found) => found.band === band)
          .sort((a, b) => a.rank - b.rank)
          .map(({ itemId, reason }) => ({ itemId, reason })),
      ].map(({ itemId, reason }, index) => ({ itemId, band, rank: index + 1, reason })),
    );
  };
}
