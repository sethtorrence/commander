import type { Item } from './items';
import type { LinearIssueDetail } from './linear';
import { isLinearTodo } from './linear-todos';
import { clockOf, isChipWorthy } from './meetings';
import { type ChatDetail, type ChatMessage, chatFlags } from './teams';

/*
  Ranking the Dashboard: which open Items need the User, in which band, why, and in what order.

  A `Ranker` is the one small interface behind "What needs you". Given the open Items, it returns,
  for each Item that belongs on the Dashboard, a band, a short plain reason and its rank in the band.
  Items it leaves out stay in their Sections. The ranked list is a view over Items, never a copy.

  `rankByBandRules` is the M2 ranker: plain, predictable band rules (not to be confused with the
  User's filing Rules). Ares's ranking (ares-ranking.ts) implements the same interface and falls
  back to it.
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
  /**
   * Who the User is in each Account (their user id at the Source: their Linear user, their Teams
   * user), by Account id.
   */
  users: Readonly<Record<string, string>>;
  /** The Chats the User muted, by Item id: never on the Dashboard. */
  muted?: ReadonlySet<string>;
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

// When a message was sent, as a Chat's reason says it: "40 min ago", "3h ago", "yesterday", "on Monday".
function sentAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const day = localDay(at);
  const today = localDay(now);
  if (day !== today && minutes >= 60) {
    const when = pastDay(day, today);
    return when === 'yesterday' ? when : `on ${when}`;
  }
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// When a message was sent, after a Chat's name: "10:42" today, else "yesterday", "Monday", "12 Sep".
function sentAt(at: number, now: number): string {
  const day = localDay(at);
  const today = localDay(now);
  if (day !== today) return pastDay(day, today);
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
type Chat = Item & { detail: ChatDetail };
// `at`: when it last changed, for the order within a band (a Chat: when its triggering message was sent).
type Placed = { item: Item; band: DashboardBand; reason: string; at: number };

const CLOSED_STATES = new Set(['completed', 'canceled']);
const isIssue = (item: Item): item is Issue =>
  item.kind === 'linear-issue' && item.detail?.kind === 'linear-issue';
const isChat = (item: Item): item is Chat => item.kind === 'chat' && item.detail?.kind === 'chat';
const changedAt = (item: Item) => (isIssue(item) ? item.detail.updatedAt : item.updatedAt);
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
  const at = changedAt(item);
  if (due < today) return { item, band: 'now', reason: `Overdue since ${pastDay(due, today)}`, at };
  if (due === today) return { item, band: 'today', reason: 'Due today', at };
  return null;
}

// A Linear issue assigned to the User: a Linear Todo.
function placeLinearTodo(issue: Issue, today: string, now: number): Placed | null {
  const { detail } = issue;
  const at = detail.updatedAt;
  const due = byDueDate(issue, today);
  if (due?.band === 'now') return due;
  if (detail.priority === 1) return { item: issue, band: 'now', reason: `Urgent · ${detail.team.key}`, at };
  if (inReview(detail.state))
    return { item: issue, band: 'waiting', reason: 'In review, waiting on reviewers', at };
  if (due) return due;
  if (detail.state.type === 'started')
    return { item: issue, band: 'today', reason: `${detail.state.name} · ${detail.team.key}`, at };
  if (detail.cycle && inCurrentCycle(detail, now)) {
    const ends = comingDay(localDay(detail.cycle.endsAt), today);
    return {
      item: issue,
      band: 'today',
      reason: `In ${detail.team.key} Cycle ${detail.cycle.number}, ends ${ends}`,
      at,
    };
  }
  return null;
}

/** How long before a meeting starts it enters Now. */
export const MEETING_LEAD_MS = 15 * 60_000;

// "12 minutes", "1 minute"
const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

// The User's next meeting (one that gets a meeting chip): in Now from 15 minutes before it starts until
// it ends. Other meetings stay in the schedule.
function placeMeeting(item: Item, now: number): Placed | null {
  if (!isChipWorthy(item)) return null;
  const { start, end } = item.detail;
  if (now < start.at - MEETING_LEAD_MS || now >= end.at) return null;
  const at = start.at;
  if (now < start.at)
    return { item, band: 'now', reason: `Starts in ${minutes(Math.ceil((start.at - now) / 60_000))}`, at };
  const since = Math.floor((now - start.at) / 60_000);
  const started =
    since < 1 ? 'just now' : since < 60 ? `${minutes(since)} ago` : `${Math.floor(since / 60)}h ago`;
  return { item, band: 'now', reason: `Started ${started} · ends ${clockOf(end.at)}`, at };
}

// ---------------------------------------------------------------------------------------------
// Chats

/** How long an unanswered one-to-one Chat stays on the Dashboard by the band rules. */
export const UNANSWERED_FOR_MS = 7 * DAY;

/** Why a Chat needs the User, and the message that says so (the one Enter opens the Chat at). */
export type ChatAttention = { why: 'mention' | 'unanswered'; message: ChatMessage };

const spoken = (message: ChatMessage) => message.from !== null && !message.deleted;
const latestOf = (messages: readonly ChatMessage[]) =>
  messages.reduce<ChatMessage | null>(
    (newest, message) => (newest === null || message.createdAt >= newest.createdAt ? message : newest),
    null,
  );

/**
 * What puts a Chat on the Dashboard by the band rules, if anything:
 *
 * - **mention:** an unread message from someone else mentions the User (the latest such message);
 * - **unanswered:** a one-to-one Chat whose latest message is the other person's, sent in the last
 *   week, read or not, with no reply from the User after it (that message).
 *
 * `me` is the User's Teams user id in the Chat's Account. With it, the Chat's flags are worked out
 * afresh from its messages, so a reply or a read counts at once; without it, the flags Teams sync
 * derived decide, and any unread message with a mention stands for the User's.
 */
export function chatAttention(
  chat: Pick<Item, 'kind' | 'detail'>,
  me: string | null,
  now: number,
): ChatAttention | null {
  if (chat.kind !== 'chat' || chat.detail?.kind !== 'chat') return null;
  const { detail } = chat;
  const flags = me ? chatFlags(detail, me) : detail;
  if (flags.mentionsMe) {
    const mention = latestOf(
      detail.messages.filter(
        (message) =>
          spoken(message) &&
          (me === null || message.from?.userId !== me) &&
          (detail.lastReadAt === null || message.createdAt > detail.lastReadAt) &&
          message.mentions.some((person) => me === null || person.userId === me),
      ),
    );
    if (mention) return { why: 'mention', message: mention };
  }
  if (detail.chatType !== 'one-on-one' || flags.latestFromMe) return null;
  const latest = latestOf(detail.messages.filter(spoken));
  if (!latest || now - latest.createdAt > UNANSWERED_FOR_MS) return null;
  return { why: 'unanswered', message: latest };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'Someone';

function placeChat(chat: Chat, context: RankingContext): Placed | null {
  const me = chat.account ? (context.users[chat.account] ?? null) : null;
  const attention = chatAttention(chat, me, context.now);
  if (!attention) return null;
  const { message } = attention;
  const who = firstName(message.from?.name ?? '');
  const at = message.createdAt;
  const where = chat.detail.chatType === 'one-on-one' ? '' : ` in ${chat.title}`;
  const reason =
    attention.why === 'mention'
      ? `${who} mentioned you${where} · ${sentAt(at, context.now)}`
      : `${who} messaged you ${sentAgo(at, context.now)}`;
  return { item: chat, band: 'today', reason, at };
}

function place(item: Item, context: RankingContext, today: string): Placed | null {
  if (item.kind === 'event') return placeMeeting(item, context.now);
  if (isChat(item)) return placeChat(item, context);
  if (!isIssue(item)) return item.kind === 'todo' ? byDueDate(item, today) : null;
  const me = item.account ? context.users[item.account] : undefined;
  if (!me) return null;
  const { assignee, creator, updatedAt } = item.detail;
  // The same Linear Todos the Item store keeps Todos for (linear-todos.ts).
  if (assignee?.id === me)
    return isLinearTodo(item.detail, me, context.now) ? placeLinearTodo(item, today, context.now) : null;
  // Created by the User, someone else has it, and it changed in the last day.
  if (creator?.id === me && assignee && context.now - updatedAt <= DAY)
    return {
      item,
      band: 'fyi',
      reason: `${assignee.name} has it · changed ${ago(updatedAt, context.now)}`,
      at: updatedAt,
    };
  return null;
}

// Within a band: meetings first, soonest first (one is about to start); then priority (Urgent first,
// none last), then due date (soonest first, none last), then the most recent change (a Chat's: its
// triggering message).
const startOf = (item: Item) =>
  item.detail?.kind === 'event' ? item.detail.start.at : Number.POSITIVE_INFINITY;
const priorityOf = (item: Item) => (isIssue(item) && item.detail.priority > 0 ? item.detail.priority : 5);
function inBandOrder(a: Placed, b: Placed): number {
  const dueA = dueOn(a.item) ?? '9999-12-31';
  const dueB = dueOn(b.item) ?? '9999-12-31';
  const startA = startOf(a.item);
  const startB = startOf(b.item);
  if (startA !== startB) return startA < startB ? -1 : 1;
  return (
    priorityOf(a.item) - priorityOf(b.item) ||
    (dueA < dueB ? -1 : dueA > dueB ? 1 : 0) ||
    b.at - a.at ||
    (a.item.id < b.item.id ? -1 : 1)
  );
}

/**
 * The Items any ranker may place: the open ones (not deleted, not a closed issue), less the Todos
 * backed by another of them, which are shown once, by that Item, and the muted Chats.
 */
export function dashboardCandidates(items: readonly Item[], muted?: ReadonlySet<string>): Item[] {
  const open = items.filter((item) => isOpen(item) && !muted?.has(item.id));
  const present = new Set(open.map((item) => item.id));
  return open.filter(
    (item) => !(item.detail?.kind === 'todo' && item.detail.backedBy && present.has(item.detail.backedBy)),
  );
}

/**
 * The M2 band rules.
 *
 * - **Now:** the User's next meeting, from 15 minutes before it starts until it ends (first, as it can't
 *   wait), overdue Todos, and Linear Todos with Urgent priority.
 * - **Waiting on others:** Linear Todos in a review state.
 * - **Today:** Todos due today, and Linear Todos in progress or in their team's current cycle.
 * - **FYI:** Linear issues the User created, assigned to someone else, that changed in the last day.
 * - **Today**, too: Chats with an unread message mentioning the User, and one-to-one Chats the User
 *   hasn't answered (chatAttention), one row per Chat. Muted Chats never; busy group Chats only
 *   when they mention the User.
 *
 * A Linear Todo is an open Linear issue assigned to the User in a Todo state (unstarted or started, or
 * backlog or triage in its team's current cycle), as in linear-todos.ts. The first band that matches wins, in
 * the order above, so an urgent issue in review stays in Now. Open Todos with no due date and no
 * cycle are left off until Ares ranks them. A Todo backed by another Item is shown once, by that Item.
 */
export const rankByBandRules: Ranker = (items, context) => {
  const today = localDay(context.now);
  const placed = dashboardCandidates(items, context.muted)
    .map((item) => place(item, context, today))
    .filter((found): found is Placed => found !== null);
  return dashboardBands.flatMap((band) =>
    placed
      .filter((found) => found.band === band)
      .sort(inBandOrder)
      .map(({ item, reason }, index) => ({ itemId: item.id, band, reason, rank: index + 1 })),
  );
};
