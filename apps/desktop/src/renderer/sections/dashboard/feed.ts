import {
  type ChatAttention,
  type ChatType,
  type ClearMark,
  chatAttention,
  clockOf,
  type DashboardBand,
  type DashboardClears,
  dashboardBands,
  daysBetween,
  type Item,
  inReview,
  localDay,
  meetingTimes,
  type Ranking,
} from '@commander/domain';
import { dateOf } from '../notes/days';
import { originLabel } from '../todos/origin';
import type { SuggestedTodo } from './suggested-todos';

/*
  The Dashboard's list, worked out from the rankings (a Ranker's answer) and the Items they rank:
  which rows show (cleared rows stay off while they're in the band they were cleared from), the
  counts per band, and how each row is labelled. Pure functions, so the Dashboard's state and its
  tests share them. The Project filter is applied beside these (projects/filter.ts).
*/

/**
 * A row on the Dashboard: a ranked Item. `done` when it was ticked here and is kept, struck through.
 * A suggested Todo of Ares's (not an Item yet) carries its `suggestion`.
 */
export interface FeedRow {
  item: Item;
  band: DashboardBand;
  reason: string;
  rank: number;
  done: boolean;
  suggestion?: SuggestedTodo;
  /** A Chat's row: the message it is about, which Enter opens the Chat at. */
  focus?: ChatFocus;
}

/**
 * The message a Chat's row is about: what put it on the Dashboard (the message Ares judged is
 * waiting on the User, an unread mention of the User, the one-to-one message they haven't answered),
 * else, for a Chat Ares placed, its latest message.
 */
export type ChatFocus = { messageId: string; at: number; why: ChatAttention['why'] | 'latest' };

/** What a Chat's row needs to know: who the User is in each Account, and the time. */
export type ChatContext = { users: Readonly<Record<string, string>>; now: number };

export function chatFocus(item: Item, { users, now }: ChatContext): ChatFocus | null {
  if (item.detail?.kind !== 'chat') return null;
  const me = item.account ? (users[item.account] ?? null) : null;
  const attention = chatAttention(item, me, now);
  if (attention)
    return { messageId: attention.message.id, at: attention.message.createdAt, why: attention.why };
  const latest = item.detail.messages.filter((message) => message.from !== null && !message.deleted).at(-1);
  return latest ? { messageId: latest.id, at: latest.createdAt, why: 'latest' } : null;
}

export type { ClearMark };
/** The cleared rows, by Item id (kept by the Core). */
export type Clears = DashboardClears;

/**
 * Whether a clear still holds for an Item ranked into `band`: while it stays in the band it was
 * cleared from; a Chat's, until it gets a newer qualifying message, whatever its band.
 */
export function clearHolds(
  mark: ClearMark | undefined,
  band: DashboardBand,
  item: Item | undefined,
  chats: ChatContext,
): boolean {
  if (!mark) return false;
  if (item?.detail?.kind === 'chat') return (chatFocus(item, chats)?.at ?? 0) <= mark.at;
  return mark.band === band;
}

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
  suggestions: ReadonlyMap<string, SuggestedTodo> = new Map(),
  chats: ChatContext = { users: {}, now: 0 },
): FeedRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ranked = new Set(rankings.map((ranking) => ranking.itemId));
  const rows: FeedRow[] = [];
  for (const { itemId, band, reason, rank } of rankings) {
    const item = byId.get(itemId);
    if (!item || clearHolds(clears[itemId], band, item, chats)) continue;
    const suggestion = suggestions.get(itemId);
    const focus = chatFocus(item, chats);
    rows.push({
      item,
      band,
      reason,
      rank,
      done: false,
      ...(suggestion && { suggestion }),
      ...(focus && { focus }),
    });
  }
  for (const [itemId, row] of tickedHere) if (!ranked.has(itemId)) rows.push(row);
  const bandIndex = (band: DashboardBand) => dashboardBands.indexOf(band);
  // Stable: a kept row goes before a ranked row of the same rank.
  return rows.sort((a, b) => bandIndex(a.band) - bandIndex(b.band) || a.rank - b.rank || +b.done - +a.done);
}

/**
 * Clears the row: it stays off the Dashboard until its Item moves to another band (a Chat: until
 * it gets a newer qualifying message).
 */
export function clearRow(clears: Clears, row: Pick<FeedRow, 'item' | 'band'>, now: number): Clears {
  return { ...clears, [row.item.id]: { band: row.band, at: now } };
}

/**
 * The clears still worth keeping: forgets those whose Item is ranked into another band, or whose
 * Chat got a newer qualifying message (it comes back), and those whose Item has been off the
 * Dashboard for 30 days. Returns `clears` itself when nothing is forgotten.
 */
export function keepClears(
  clears: Clears,
  rankings: readonly Ranking[],
  now: number,
  items: readonly Item[] = [],
  users: Readonly<Record<string, string>> = {},
): Clears {
  const bands = new Map(rankings.map((ranking) => [ranking.itemId, ranking.band]));
  const byId = new Map(items.map((item) => [item.id, item]));
  const kept = Object.entries(clears).filter(([itemId, mark]) => {
    const band = bands.get(itemId);
    return band ? clearHolds(mark, band, byId.get(itemId), { users, now }) : now - mark.at < FORGET_AFTER;
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

const CHAT_TYPES: Record<ChatType, string> = {
  'one-on-one': 'One-to-one',
  group: 'Group',
  meeting: 'Meeting',
};
const CHAT_WHY: Record<ChatFocus['why'], string> = {
  waiting: 'Waiting',
  mention: 'Mention',
  unanswered: 'Unanswered',
  latest: 'Teams',
};

// How long ago, in the right-hand column's few letters: 40M, 3H, 2D.
function shortAgo(at: number, now: number): string {
  const minutes = Math.max(1, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}M`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}H`;
  return `${Math.floor(minutes / (24 * 60))}D`;
}

const dueOf = (item: Item) =>
  item.detail?.kind === 'todo'
    ? item.detail.dueOn
    : item.detail?.kind === 'linear-issue'
      ? item.detail.dueDate
      : null;

/**
 * The row's Source stamp and what follows it: `TODO` Manual · due Fri, `LIN` In Progress, `ARES`
 * Suggested Todo, `CAL` Titanlink · 10:00–10:30.
 */
export function sourceTag(item: Item, suggested = false): { stamp: string; text: string } {
  if (suggested) return { stamp: 'ARES', text: 'Suggested Todo' };
  if (item.detail?.kind === 'event')
    return { stamp: 'CAL', text: `${item.detail.calendar.name} · ${meetingTimes(item.detail)}` };
  if (item.detail?.kind === 'chat') return { stamp: 'TMS', text: `${CHAT_TYPES[item.detail.chatType]} chat` };
  if (item.detail?.kind === 'linear-issue') return { stamp: 'LIN', text: item.detail.state.name };
  const due = dueOf(item);
  const origin = originLabel(item);
  return { stamp: 'TODO', text: due ? `${origin} · due ${SHORT_DAYS[dateOf(due).getDay()]}` : origin };
}

/** The row's right-hand column, big then small: ["3D", "Overdue"], ["Today", "Due"], ["ENG", "Cycle 41"]. */
export function rowMeta(row: FeedRow, now: number): [string, string] {
  const { item, band } = row;
  if (row.suggestion) return ['New', 'Suggested'];
  if (item.detail?.kind === 'event') {
    const { start, end } = item.detail;
    if (now < start.at) return [`${Math.ceil((start.at - now) / 60_000)}M`, 'Starts'];
    return ['Now', `Ends ${clockOf(end.at)}`];
  }
  if (item.detail?.kind === 'chat') {
    if (!row.focus) return ['—', 'Teams'];
    return [shortAgo(row.focus.at, now), CHAT_WHY[row.focus.why]];
  }
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
