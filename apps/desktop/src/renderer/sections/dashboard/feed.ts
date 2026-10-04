import {
  type DashboardBand,
  dashboardBands,
  daysBetween,
  type Item,
  inReview,
  localDay,
  type Ranking,
} from '@commander/domain';
import { dateOf } from '../notes/days';
import { originLabel } from '../todos/origin';

/*
  The Dashboard's list, worked out from the rankings (a Ranker's answer) and the Items they rank:
  which rows show (cleared rows stay off while they're in the band they were cleared from), the
  counts per band, and how each row is labelled. Pure functions, so the Dashboard's state and its
  tests share them. The Project filter is applied beside these (projects/filter.ts).
*/

/** A row on the Dashboard: a ranked Item. `done` when it was ticked here and is kept, struck through. */
export interface FeedRow {
  item: Item;
  band: DashboardBand;
  reason: string;
  rank: number;
  done: boolean;
}

/** A row cleared from the Dashboard: the band it was in, and when. */
export interface ClearMark {
  band: DashboardBand;
  at: number;
}
/** The cleared rows, by Item id. */
export type Clears = Readonly<Record<string, ClearMark>>;

const DAY = 86_400_000;
// A clear whose Item has been off the Dashboard this long is forgotten.
const FORGET_AFTER = 30 * DAY;

/**
 * The rows, band by band in ranked order: each ranking with its Item, less the cleared ones, plus the
 * rows ticked here (kept in place, done, until the Dashboard is left). An Item ranked again (unticked)
 * shows as ranked.
 */
export function feedRows(
  rankings: readonly Ranking[],
  items: readonly Item[],
  clears: Clears,
  tickedHere: ReadonlyMap<string, FeedRow>,
): FeedRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ranked = new Set(rankings.map((ranking) => ranking.itemId));
  const rows: FeedRow[] = [];
  for (const { itemId, band, reason, rank } of rankings) {
    const item = byId.get(itemId);
    if (!item || clears[itemId]?.band === band) continue;
    rows.push({ item, band, reason, rank, done: false });
  }
  for (const [itemId, row] of tickedHere) if (!ranked.has(itemId)) rows.push(row);
  const bandIndex = (band: DashboardBand) => dashboardBands.indexOf(band);
  // Stable: a kept row goes before a ranked row of the same rank.
  return rows.sort((a, b) => bandIndex(a.band) - bandIndex(b.band) || a.rank - b.rank || +b.done - +a.done);
}

/** Clears the row: it stays off the Dashboard until its Item moves to another band. */
export function clearRow(clears: Clears, row: Pick<FeedRow, 'item' | 'band'>, now: number): Clears {
  return { ...clears, [row.item.id]: { band: row.band, at: now } };
}

/**
 * The clears still worth keeping: forgets those whose Item is ranked into another band (it comes
 * back), and those whose Item has been off the Dashboard for 30 days. Returns `clears` itself when
 * nothing is forgotten.
 */
export function keepClears(clears: Clears, rankings: readonly Ranking[], now: number): Clears {
  const bands = new Map(rankings.map((ranking) => [ranking.itemId, ranking.band]));
  const kept = Object.entries(clears).filter(([itemId, mark]) => {
    const band = bands.get(itemId);
    return band ? band === mark.band : now - mark.at < FORGET_AFTER;
  });
  return kept.length === Object.keys(clears).length ? clears : Object.fromEntries(kept);
}

export type BandCounts = Record<DashboardBand, number>;

/** How many open (not ticked) rows each band holds. */
export function bandCounts(rows: readonly FeedRow[]): BandCounts {
  const counts: BandCounts = { now: 0, today: 0, waiting: 0, fyi: 0 };
  for (const row of rows) if (!row.done) counts[row.band] += 1;
  return counts;
}

/** The Dashboard tab's count: the open rows in Now and Today. */
export function tabCount(rows: readonly FeedRow[]): number {
  const counts = bandCounts(rows);
  return counts.now + counts.today;
}

// ---------------------------------------------------------------------------------------------
// Labels

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dueOf = (item: Item) =>
  item.detail?.kind === 'todo'
    ? item.detail.dueOn
    : item.detail?.kind === 'linear-issue'
      ? item.detail.dueDate
      : null;

/** The row's Source stamp and what follows it: `TODO` Manual · due Fri, `LIN` In Progress. */
export function sourceTag(item: Item): { stamp: string; text: string } {
  if (item.detail?.kind === 'linear-issue') return { stamp: 'LIN', text: item.detail.state.name };
  const due = dueOf(item);
  const origin = originLabel(item);
  return { stamp: 'TODO', text: due ? `${origin} · due ${SHORT_DAYS[dateOf(due).getDay()]}` : origin };
}

/** The row's right-hand column, big then small: ["3D", "Overdue"], ["Today", "Due"], ["ENG", "Cycle 41"]. */
export function rowMeta(row: FeedRow, now: number): [string, string] {
  const { item, band } = row;
  const today = localDay(now);
  const due = dueOf(item);
  if (due && due < today) return [`${daysBetween(due, today)}D`, 'Overdue'];
  if (due === today) return ['Today', 'Due'];
  if (item.detail?.kind !== 'linear-issue')
    return due ? [SHORT_DAYS[dateOf(due).getDay()] ?? '', 'Due'] : ['—', ''];
  const { detail } = item;
  if (band === 'fyi') {
    const hours = Math.floor((now - detail.updatedAt) / 3_600_000);
    return hours
      ? [`${hours}H`, 'Changed']
      : [`${Math.max(1, Math.floor((now - detail.updatedAt) / 60_000))}M`, 'Changed'];
  }
  if (detail.priority === 1 && band === 'now') return ['Urgent', detail.team.key];
  if (inReview(detail.state)) return ['Rev', 'Reviewers'];
  if (detail.state.type === 'started') return [detail.team.key, detail.state.name];
  if (detail.cycle) return [detail.team.key, `Cycle ${detail.cycle.number}`];
  return [detail.team.key, detail.state.name];
}
