import type { Item } from './items';
import type { LinearIssueDetail } from './linear';
import { isLinearTodo } from './linear-todos';

/*
  Ranking the Dashboard: which open Items need the User, in which band, why, and in what order.

  A `Ranker` is the one small interface behind "What needs you". Given the open Items, it returns,
  for each Item that belongs on the Dashboard, a band, a short plain reason and its rank in the band.
  Items it leaves out stay in their Sections. The ranked list is a view over Items, never a copy.

  `rankByBandRules` is the M2 ranker: plain, predictable band rules (not to be confused with the
  User's filing Rules). Ares's ranking job (M3) implements the same interface and falls back to it.
  It is pure and takes its clock from the context, so the window and the Core can both run it.
*/

export const dashboardBands = ['now', 'today', 'waiting', 'fyi'] as const;
export type DashboardBand = (typeof dashboardBands)[number];

export interface Ranking {
  itemId: string;
  band: DashboardBand;
  /** Why it is there, as a short plain phrase: "Overdue since Tuesday", "Urgent · ENG". */
  reason: string;
  /** Its place in its band, from 1 at the top. */
  rank: number;
}

export interface RankingContext {
  /** The time to rank at (ms since the epoch); "today" is its local calendar day. */
  now: number;
  /** Who the User is in each Account (their user id at the Source, e.g. their Linear user), by Account id. */
  users: Readonly<Record<string, string>>;
}

/** Ranks the open Items for the Dashboard: bands in order (Now first), each ranked from 1. */
export type Ranker = (items: readonly Item[], context: RankingContext) => Ranking[];

// ---------------------------------------------------------------------------------------------
// Local calendar days

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a time, as YYYY-MM-DD. */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function midnight(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

/** Whole calendar days from one day to another (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((midnight(to).getTime() - midnight(from).getTime()) / DAY);
}

// "yesterday", "Tuesday" within the past week, "12 Sep" before that.
function pastDay(day: string, today: string): string {
  const ago = daysBetween(day, today);
  if (ago === 1) return 'yesterday';
  const date = midnight(day);
  if (ago < 7) return WEEKDAYS[date.getDay()] ?? day;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// "today", "tomorrow", "Tuesday" within the coming week, "12 Oct" after that.
function comingDay(day: string, today: string): string {
  const ahead = daysBetween(today, day);
  if (ahead <= 0) return 'today';
  if (ahead === 1) return 'tomorrow';
  const date = midnight(day);
  if (ahead < 7) return WEEKDAYS[date.getDay()] ?? day;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// ---------------------------------------------------------------------------------------------
// The band rules

type Issue = Item & { detail: LinearIssueDetail };
type Placed = { item: Item; band: DashboardBand; reason: string };

const CLOSED_STATES = new Set(['completed', 'canceled']);
const isIssue = (item: Item): item is Issue =>
  item.kind === 'linear-issue' && item.detail?.kind === 'linear-issue';
const isOpen = (item: Item) =>
  item.status === 'open' &&
  item.deletedAt === null &&
  !(isIssue(item) && CLOSED_STATES.has(item.detail.state.type));

/** Whether a Linear issue's workflow state is a review state ("In Review"): the next move is a reviewer's. */
export const inReview = (state: LinearIssueDetail['state']) =>
  state.type === 'started' && /review/i.test(state.name);

const inCurrentCycle = ({ cycle }: LinearIssueDetail, now: number) =>
  !!cycle && cycle.startsAt <= now && now < cycle.endsAt;

// When a Todo is due, by its own date or its Linear issue's.
function dueOn(item: Item): string | null {
  if (item.detail?.kind === 'todo') return item.detail.dueOn;
  if (item.detail?.kind === 'linear-issue') return item.detail.dueDate;
  return null;
}

// Overdue or due today, for any Todo (a Commander Todo or a Linear Todo).
function byDueDate(item: Item, today: string): Placed | null {
  const due = dueOn(item);
  if (!due) return null;
  if (due < today) return { item, band: 'now', reason: `Overdue since ${pastDay(due, today)}` };
  if (due === today) return { item, band: 'today', reason: 'Due today' };
  return null;
}

// A Linear issue assigned to the User: a Linear Todo.
function placeLinearTodo(issue: Issue, today: string, now: number): Placed | null {
  const { detail } = issue;
  const due = byDueDate(issue, today);
  if (due?.band === 'now') return due;
  if (detail.priority === 1) return { item: issue, band: 'now', reason: `Urgent · ${detail.team.key}` };
  if (inReview(detail.state))
    return { item: issue, band: 'waiting', reason: 'In review, waiting on reviewers' };
  if (due) return due;
  if (detail.state.type === 'started')
    return { item: issue, band: 'today', reason: `${detail.state.name} · ${detail.team.key}` };
  if (detail.cycle && inCurrentCycle(detail, now)) {
    const ends = comingDay(localDay(detail.cycle.endsAt), today);
    return {
      item: issue,
      band: 'today',
      reason: `In ${detail.team.key} Cycle ${detail.cycle.number}, ends ${ends}`,
    };
  }
  return null;
}

function place(item: Item, context: RankingContext, today: string): Placed | null {
  if (!isIssue(item)) return item.kind === 'todo' ? byDueDate(item, today) : null;
  const me = item.account ? context.users[item.account] : undefined;
  if (!me) return null;
  const { assignee, creator, updatedAt } = item.detail;
  // The same Linear Todos the Item store keeps Todos for (linear-todos.ts).
  if (assignee?.id === me)
    return isLinearTodo(item.detail, me, context.now) ? placeLinearTodo(item, today, context.now) : null;
  // Created by the User, someone else has it, and it changed in the last day.
  if (creator?.id === me && assignee && context.now - updatedAt <= DAY)
    return { item, band: 'fyi', reason: `${assignee.name} has it · changed ${ago(updatedAt, context.now)}` };
  return null;
}

// Within a band: priority (Urgent first, none last), then due date (soonest first, none last), then
// the most recent change.
const priorityOf = (item: Item) => (isIssue(item) && item.detail.priority > 0 ? item.detail.priority : 5);
const changedAt = (item: Item) => (isIssue(item) ? item.detail.updatedAt : item.updatedAt);
function inBandOrder(a: Placed, b: Placed): number {
  const dueA = dueOn(a.item) ?? '9999-12-31';
  const dueB = dueOn(b.item) ?? '9999-12-31';
  return (
    priorityOf(a.item) - priorityOf(b.item) ||
    (dueA < dueB ? -1 : dueA > dueB ? 1 : 0) ||
    changedAt(b.item) - changedAt(a.item) ||
    (a.item.id < b.item.id ? -1 : 1)
  );
}

/**
 * The M2 band rules.
 *
 * - **Now:** overdue Todos, and Linear Todos with Urgent priority.
 * - **Waiting on others:** Linear Todos in a review state.
 * - **Today:** Todos due today, and Linear Todos in progress or in their team's current cycle.
 * - **FYI:** Linear issues the User created, assigned to someone else, that changed in the last day.
 *
 * A Linear Todo is an open Linear issue assigned to the User in a Todo state (unstarted or started, or
 * backlog or triage in its team's current cycle), as in linear-todos.ts. The first band that matches wins, in
 * the order above, so an urgent issue in review stays in Now. Open Todos with no due date and no
 * cycle are left off until Ares ranks them. A Todo backed by another Item is shown once, by that Item.
 */
export const rankByBandRules: Ranker = (items, context) => {
  const today = localDay(context.now);
  const open = items.filter(isOpen);
  const present = new Set(open.map((item) => item.id));
  const placed = open
    .filter(
      (item) => !(item.detail?.kind === 'todo' && item.detail.backedBy && present.has(item.detail.backedBy)),
    )
    .map((item) => place(item, context, today))
    .filter((found): found is Placed => found !== null);
  return dashboardBands.flatMap((band) =>
    placed
      .filter((found) => found.band === band)
      .sort(inBandOrder)
      .map(({ item, reason }, index) => ({ itemId: item.id, band, reason, rank: index + 1 })),
  );
};
