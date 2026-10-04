// Ares ranks the Dashboard (#72): after each sync and, a few seconds after they stop changing, when
// Todos change, he decides which open Items need the User, in which band, in what order, and says
// why in a few words of his own. A Quick job at low thinking: one call per batch of 40 Items, no
// tools, a reply that must fit OUTPUT.
//
// - Looks at the open Todos (a Todo backed by a Linear issue is that issue), the Linear issues
//   involving the User (their Linear Todos, and issues they created or have that changed in the last
//   two days), the User's open work on GitHub (reviews asked of them while their Todos are open, and
//   their own open pull requests; #116), the Teams Chats that may need them (flagged as waiting on the User, a mention, an
//   unanswered one-to-one Chat, or unread messages from the last two days; never a muted Chat), and
//   the pending "Suggest Todos" suggestions; at most 200 Items, the most pressing by the rules
//   first. Cleared rows are left out until their Item changes; how he last ranked them stands.
//   Nothing changed since his last ranking today: no call.
// - Every Item goes in a data block of its own through the prompt builder (ADR 0004), labelled with
//   a short reference (I1, I2…) that the reply names it by; Linear issues, Chats and suggestions are
//   outside material. A Chat goes with its name and type, the people in it, why it may need the User
//   and its last few messages, each cut short. Today's date goes with the instructions. The meetings
//   of the next three hours and Ares's preps for them (#130) go along as context, in blocks of their
//   own with no reference, so a Todo a meeting needs can rise before it.
// - The reply's entries are checked one by one: an entry that names an Item it wasn't given (or one
//   twice), a band that isn't one, a rank that isn't a number or a missing reason is dropped, and so
//   is any Item he left out: the band rules place those (aresRanker, in the window).
// - The result is a view, not a change to Items: the runner `apply`s it (no gate) at any level above
//   Off. Ask works as Auto here, as approving each row's position would make no sense. The ranking
//   is kept in the Item store (dashboard.ts) and read by the window, which falls back to the rules
//   whenever it can't be used.
import {
  type AresBand,
  type AresRankingEntry,
  aresBands,
  type ChatDetail,
  changesRequestedBy,
  chatAttention,
  chatFlags,
  dashboardCandidates,
  type EventDetail,
  githubIdentifier,
  type Item,
  isChipWorthy,
  isLinearTodo,
  isMeetingPrep,
  isPullRequestItem,
  isReviewRequestItem,
  isTheirs,
  type LinearIssueDetail,
  localDay,
  meetingTimes,
  mutedChatIds,
  type PullRequestDetail,
  type PullRequestItem,
  prepLines,
  RANK_DASHBOARD,
  type ReviewRequestItem,
  rankByBandRules,
  rankingFingerprint,
  reviewAskedBy,
  suggestionItemId,
  waitedFor,
  waitingOn,
  waitingSince,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';
import { SUGGEST_TODOS } from './suggest-todos';

export const BATCH_SIZE = 40;
// At most this many Items a run (five calls); the rest, the least pressing by the rules and the
// longest unchanged, are left to the rules.
const MAX_ITEMS = 200;
// How long after the Todos last changed he ranks again.
export const TODOS_PAUSE_MS = 5_000;
const HOUR = 3_600_000;
// A Linear issue involving the User that changed this recently is worth a look.
const RECENT_MS = 48 * HOUR;
const MAX_REASON_WORDS = 14;
const CUT_REASON_WORDS = 12;
const MAX_REASON_CHARS = 140;
const MAX_DESCRIPTION = 300;
const MAX_COMMENT = 200;
// A Chat goes with its last few messages, each cut short, and at most this many people named.
const CHAT_MESSAGES = 5;
const MAX_MESSAGE = 200;
const MAX_PEOPLE = 8;
// The meetings read as context (#130): those in the next few hours, at most a handful.
const MEETINGS_AHEAD_MS = 3 * HOUR;
const MAX_MEETINGS = 5;

// Each entry is checked on its own (so one bad entry costs only that Item), hence the loose shape.
const entry = z
  .object({
    ref: z.string().max(20),
    band: z.string().max(20),
    rank: z.number(),
    reason: z.string().max(600).optional().default(''),
  })
  .nullable()
  .catch(null);
export const OUTPUT = z.object({ ranking: z.array(entry).max(200) });
type Output = z.infer<typeof OUTPUT>;

type Candidate = {
  ref: string;
  // The Item's id, or a suggestion's (`suggestion:12`).
  itemId: string;
  fingerprint: string;
  data: PromptData;
};
type Input = JobInput & { candidates: Candidate[]; kept: AresRankingEntry[] };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const pad = (n: number) => String(n).padStart(2, '0');
const longDay = (at: number) => {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};
const clockTime = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
// "2026-10-05 (Monday)": a calendar day as the model reads it best.
const withWeekday = (day: string) => {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return `${day} (${WEEKDAYS[new Date(year, month - 1, date).getDay()]})`;
};
const stamp = (at: number) => `${localDay(at)} ${clockTime(at)}`;
const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

const PRIORITIES = ['None', 'Urgent', 'High', 'Medium', 'Low'];

const instructions = (
  now: number,
) => `You are Ares. You rank the User's Dashboard, "What needs you": which of their open Items need them, in which band, in what order, and why.

Today is ${longDay(now)} (${localDay(now)}); the time is ${clockTime(now)}.

Each data block is one Item, labelled with its reference (I1, I2…) and what it is, then its facts. The bands:
- now: needs the User now: overdue, urgent, blocking someone, or due within hours.
- today: should be done before the day ends: due today, in progress, in the current cycle, or a commitment for today.
- waiting: someone else has the next move (in review, waiting on a reply); the User only keeps an eye on it.
- fyi: worth knowing, nothing to do: something the User handed off changed.
- none: doesn't need the User today: later, someday, or not theirs.

Reply with only this JSON object: {"ranking":[{"ref":"I1","band":"now","rank":1,"reason":"…"}]}
- One entry for every Item, by its reference exactly as labelled.
- band: one of now, today, waiting, fyi, none.
- rank: the Item's place in its band, from 1 at the top, the most pressing first. Number each band on its own.
- reason: why it is there, in a few plain words of your own (fewer than 12), as you would say it to the User: "Dana's waiting on this before Friday's review", "Overdue since Tuesday", "Priya has it now". No full stop. For band none it may be empty.
- A Suggested Todo is one you suggested from the User's Daily Note that they haven't added yet: rank it like any other Todo.
- A Teams chat is a conversation in Microsoft Teams, with its last few messages. Place it when someone is waiting on the User (a question or mention aimed at them, a one-to-one message they haven't answered); chatter that asks nothing of them is none. When it says you judged that someone is waiting on the User, place it (usually today), and let your reason say who is waiting and on what.
- A GitHub review request is a review asked of the User (directly, or of one of their teams, which matters less); a GitHub pull request is the User's own, with its checks and reviews. Failing checks or changes requested need the User; a pull request waiting on reviewers is waiting.
- Blocks labelled "Meeting at …" or "Prep for the meeting at …" are not Items to rank: they are the User's meetings in the next few hours and your preparation for them. A Todo a meeting needs done first (something to read, send or decide before it) should rise before the meeting.`;

// A reason as the Dashboard shows it: one line, no closing full stop, a few words.
function cleanReason(reason: string): string {
  const words = reason
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .split(' ')
    .filter(Boolean);
  const text =
    words.length > MAX_REASON_WORDS ? `${words.slice(0, CUT_REASON_WORDS).join(' ')}…` : words.join(' ');
  return cut(text, MAX_REASON_CHARS);
}

const isBand = (band: string): band is AresBand => (aresBands as readonly string[]).includes(band);

export function rankDashboardJob(
  itemStore: ItemStore,
  { now = Date.now, batchSize = BATCH_SIZE }: { now?: () => number; batchSize?: number } = {},
): AgentJob<Input, Output> {
  const projectName = (item: Item) => {
    const id = item.filing?.projectId;
    if (!id) return 'Unfiled';
    return itemStore.projectRef(id)?.title ?? 'Unfiled';
  };

  function todoText(item: Item, at: number): string {
    if (item.detail?.kind !== 'todo') return `Title: ${item.title}`;
    const { origin, dueOn } = item.detail;
    const added = {
      manual: 'Added by the User in Todos',
      'daily-note': 'Made from a line the User wrote in a Daily Note',
      ares: 'Suggested by Ares and added by the User',
      linear: 'From Linear',
      github: 'From GitHub: a review asked of the User, or an issue assigned to them',
    }[origin];
    return [
      `Title: ${item.title}`,
      `Due: ${dueOn ? withWeekday(dueOn) : 'no due date'}`,
      added,
      `Project: ${projectName(item)}`,
      `Added: ${localDay(item.createdAt)}`,
      ...(dueOn && dueOn < localDay(at) ? ['It is overdue'] : []),
    ].join('\n');
  }

  function issueText(item: Item, me: string | null, linearTodo: boolean, at: number): string {
    const detail = item.detail as LinearIssueDetail;
    const { state, assignee, creator, cycle } = detail;
    const whose = linearTodo
      ? 'One of the User’s Linear Todos (assigned to them)'
      : assignee?.id === me
        ? 'Assigned to the User'
        : `${assignee ? `Assigned to ${assignee.name}` : 'Unassigned'}${creator?.id === me ? '; the User created it' : ''}`;
    const inCycle = cycle && cycle.startsAt <= at && at < cycle.endsAt;
    const latest = detail.comments.at(-1);
    return [
      `Title: ${item.title}`,
      whose,
      `State: ${state.name} (${state.type})`,
      `Priority: ${PRIORITIES[detail.priority] ?? 'None'}`,
      ...(cycle
        ? [
            `Cycle: ${detail.team.key} Cycle ${cycle.number}, ends ${withWeekday(localDay(cycle.endsAt))}${inCycle ? ' (current)' : ''}`,
          ]
        : []),
      `Due: ${detail.dueDate ? withWeekday(detail.dueDate) : 'no due date'}`,
      `Project: ${projectName(item)}`,
      ...(detail.linearProject ? [`Linear project: ${detail.linearProject.name}`] : []),
      `Last changed in Linear: ${stamp(detail.updatedAt)}`,
      ...(detail.description ? [`Description: ${cut(detail.description, MAX_DESCRIPTION)}`] : []),
      ...(latest
        ? [
            `Latest comment (${latest.author?.name ?? 'someone'}, ${localDay(latest.createdAt)}): ${cut(latest.body, MAX_COMMENT)}`,
          ]
        : []),
    ].join('\n');
  }

  const CHAT_TYPES: Record<ChatDetail['chatType'], string> = {
    'one-on-one': 'one-to-one',
    group: 'group',
    meeting: 'meeting',
  };

  // A Chat as Ares reads it: its name and type, the people in it, why it may need the User, and its
  // last few messages, each cut short. Message text is untrusted: the builder marks the block outside.
  function chatText(item: Item, me: string | null, at: number): string {
    const detail = item.detail as ChatDetail;
    const flags = me ? chatFlags(detail, me) : detail;
    const attention = chatAttention(item, me, at);
    const others = detail.members.filter((member) => me === null || member.userId !== me);
    const named = others.slice(0, MAX_PEOPLE).map((member) => member.name);
    if (others.length > MAX_PEOPLE) named.push(`${others.length - MAX_PEOPLE} more`);
    const people = me === null ? named : [...named, 'the User'];
    const withWhom =
      people.length > 1 ? `${people.slice(0, -1).join(', ')} and ${people.at(-1)}` : (people[0] ?? 'no one');
    const who = (from: { userId: string | null; name: string } | null) =>
      from && me !== null && from.userId === me ? 'the User' : (from?.name ?? 'someone');
    const recent = detail.messages
      .filter((message) => message.from !== null && !message.deleted)
      .slice(-CHAT_MESSAGES)
      .map(
        (message) => `- ${stamp(message.createdAt)} ${who(message.from)}: ${cut(message.text, MAX_MESSAGE)}`,
      );
    return [
      `Title: ${item.title}`,
      `A Teams ${CHAT_TYPES[detail.chatType]} chat with ${withWhom}`,
      ...(attention?.why === 'waiting' && item.waiting
        ? [`Ares judged that someone is waiting on the User: ${item.waiting.reason}`]
        : []),
      ...(attention?.why === 'mention' ? ['An unread message mentions the User'] : []),
      ...(attention?.why === 'unanswered'
        ? [`The latest message is ${who(attention.message.from)}’s, and the User hasn’t replied`]
        : []),
      `Unread messages: ${flags.unreadCount}`,
      `Project: ${projectName(item)}`,
      ...(recent.length ? ['Last messages, oldest first:', ...recent] : ['No messages yet']),
    ].join('\n');
  }

  // Who the User is in each Teams Account: the sender of the latest message in a Chat where it is theirs.
  function usersFromChats(chats: Item[]): Record<string, string> {
    const users: Record<string, string> = {};
    for (const chat of chats) {
      if (!chat.account || chat.detail?.kind !== 'chat' || !chat.detail.latestFromMe) continue;
      const spoken = chat.detail.messages.filter((message) => message.from !== null && !message.deleted);
      const latest = spoken.reduce<(typeof spoken)[number] | null>(
        (newest, message) => (newest === null || message.createdAt >= newest.createdAt ? message : newest),
        null,
      );
      if (latest?.from?.userId) users[chat.account] = latest.from.userId;
    }
    return users;
  }

  // Who the User is in each Linear Account: the assignee of the issues behind their Linear Todos.
  function usersFrom(todos: Item[], byId: Map<string, Item>): Record<string, string> {
    const users: Record<string, string> = {};
    for (const todo of todos) {
      const backedBy = todo.detail?.kind === 'todo' ? todo.detail.backedBy : null;
      const issue = backedBy ? byId.get(backedBy) : undefined;
      if (issue?.account && issue.detail?.kind === 'linear-issue' && issue.detail.assignee)
        users[issue.account] = issue.detail.assignee.id;
    }
    return users;
  }

  // Who the User is in each GitHub Account: the login Settings → GitHub last read for it.
  function githubUsers(work: Item[]): Record<string, string> {
    const users: Record<string, string> = {};
    for (const account of new Set(work.flatMap((item) => (item.account ? [item.account] : [])))) {
      const login = itemStore.githubWatch.read(account).access?.login;
      if (login) users[account] = login;
    }
    return users;
  }

  // A pull request's state as Ares reads it: open or draft, its checks, its reviews and who it waits on.
  function pullFacts(detail: PullRequestDetail): string[] {
    const changes = changesRequestedBy(detail);
    const waiting = waitingOn(detail);
    return [
      `State: ${detail.draft ? 'draft' : detail.state}`,
      `Checks: ${detail.checks ?? 'none'}`,
      `Review decision: ${detail.reviewDecision ?? 'none'}`,
      ...(changes.length ? [`Changes requested by: ${changes.join(', ')}`] : []),
      ...(waiting.length ? [`Waiting on: ${waiting.join(', ')}`] : []),
    ];
  }

  // A review asked of the User, with its pull request's state and the start of its body. The body is
  // someone else's words: the builder marks the block outside.
  function reviewText(item: ReviewRequestItem, pull: PullRequestItem | null, at: number): string {
    const { direct, teams, requestedAt } = item.detail;
    const by = reviewAskedBy(item);
    const whose = direct
      ? `Review asked of the User directly${by ? `; ${by} opened the pull request` : ''}`
      : `Review asked of the User’s team ${teams.map((team) => `@${team}`).join(', ')}`;
    return [
      `Title: ${item.title}`,
      whose,
      ...(requestedAt !== null ? [`Asked: ${stamp(requestedAt)} (${waitedFor(requestedAt, at)} ago)`] : []),
      ...(pull ? pullFacts(pull.detail) : []),
      `Project: ${projectName(item)}`,
      ...(pull?.detail.body ? [`Body: ${cut(pull.detail.body, MAX_DESCRIPTION)}`] : []),
    ].join('\n');
  }

  // The User's own pull request: its state, checks, reviews, who it waits on and how long.
  function pullText(item: PullRequestItem, at: number): string {
    const { detail } = item;
    return [
      `Title: ${item.title}`,
      'The User’s own pull request',
      ...pullFacts(detail),
      `Opened: ${stamp(detail.createdAt)}`,
      `Waiting since: ${stamp(waitingSince(detail))} (${waitedFor(waitingSince(detail), at)})`,
      `Last changed on GitHub: ${stamp(detail.updatedAt)}`,
      `Project: ${projectName(item)}`,
      ...(detail.body ? [`Body: ${cut(detail.body, MAX_DESCRIPTION)}`] : []),
    ].join('\n');
  }

  // The pending suggestions of Suggest Todos, as the Todos they would add.
  function suggestions(): { item: Item; block: Item | undefined }[] {
    return itemStore.autonomy
      .proposals({ statuses: ['pending'], limit: 500 })
      .filter((proposal) => proposal.action === SUGGEST_TODOS)
      .flatMap((proposal) => {
        const create = proposal.itemActions.find(
          (step) => step.type === 'create' && step.item.kind === 'todo',
        );
        if (create?.type !== 'create') return [];
        const item: Item = {
          id: suggestionItemId(proposal.id),
          kind: 'todo',
          source: null,
          account: null,
          externalId: null,
          title: create.item.title,
          people: [],
          filing: create.item.filing ?? null,
          status: 'open',
          createdAt: proposal.at,
          updatedAt: proposal.at,
          deletedAt: null,
          detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
        };
        return [{ item, block: itemStore.get(proposal.itemId)?.item }];
      });
  }

  // The meetings in the next few hours and Ares's preps for them (#130), as context: each in a data
  // block of its own (the event and the prep are outside words), labelled without a reference, so
  // nothing in them can be ranked.
  function meetingContext(at: number): PromptData[] {
    const meetings = itemStore
      .events({ from: at, to: at + MEETINGS_AHEAD_MS })
      .filter(
        (item): item is Item & { detail: EventDetail } => isChipWorthy(item) && item.detail.start.at >= at,
      )
      .sort((a, b) => a.detail.start.at - b.detail.start.at)
      .slice(0, MAX_MEETINGS);
    const preps = new Map(
      itemStore
        .meetingPreps(meetings.map((meeting) => meeting.id))
        .flatMap((prep) => (isMeetingPrep(prep) ? [[prep.detail.eventId, prep] as const] : [])),
    );
    return meetings.flatMap((meeting) => {
      const time = clockTime(meeting.detail.start.at);
      const blocks: PromptData[] = [
        {
          label: `Meeting at ${time} · ${meeting.title}`,
          from: meeting,
          text: `Title: ${meeting.title}\nWhen: ${meetingTimes(meeting.detail)}`,
        },
      ];
      const prep = preps.get(meeting.id);
      if (prep) {
        blocks.push({
          label: `Prep for the meeting at ${time}`,
          from: prep,
          text: prepLines(prep.detail)
            .map((line) => `- ${cut(line.text, 200)}`)
            .join('\n'),
        });
      }
      return blocks;
    });
  }

  return {
    job: RANK_DASHBOARD,
    name: 'Rank the Dashboard',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: RANK_DASHBOARD,
      actionKind: 'organise',
      section: null,
      hint: 'Orders your Dashboard, with a reason per row. Ask works as Auto here: there are no rows to approve',
    },
    triggers: { 'source-sync': true, 'todos-changed': { pauseMs: TODOS_PAUSE_MS } },

    gather({ seen }) {
      const at = now();
      const today = localDay(at);
      const todos = itemStore.query({ kinds: ['todo'], statuses: ['open'], limit: 1000 });
      const issues = itemStore.query({ kinds: ['linear-issue'], statuses: ['open'], limit: 1000 });
      const chats = itemStore.query({ kinds: ['chat'], statuses: ['open'], limit: 1000 });
      // GitHub's open work (#116): reviews asked of the User, and pull requests (theirs among them).
      const work = itemStore.query({
        kinds: ['review-request', 'pull-request'],
        statuses: ['open'],
        limit: 1000,
      });
      // Muted Chats are never sent; excluded ones are deleted, so not among them.
      const muted = mutedChatIds(chats, itemStore.chatSettings.list());
      const byId = new Map([...todos, ...issues, ...work].map((item) => [item.id, item]));
      const users = { ...usersFrom(todos, byId), ...usersFromChats(chats), ...githubUsers(work) };
      const meIn = (item: Item) => (item.account ? (users[item.account] ?? null) : null);
      const backing = new Set(
        todos.flatMap((todo) =>
          todo.detail?.kind === 'todo' && todo.detail.backedBy ? [todo.detail.backedBy] : [],
        ),
      );

      // A Chat may need the User when the band rules place it (a mention, an unanswered one-to-one
      // Chat), or it has unread messages from the last two days, which Ares judges.
      const mayNeedUser = (chat: Item) => {
        if (chat.detail?.kind !== 'chat') return false;
        const me = meIn(chat);
        if (chatAttention(chat, me, at)) return true;
        const { unreadCount, lastMessageAt } = me ? chatFlags(chat.detail, me) : chat.detail;
        return unreadCount > 0 && lastMessageAt !== null && at - lastMessageAt <= RECENT_MS;
      };

      const involving = (issue: Item) => {
        if (issue.detail?.kind !== 'linear-issue') return null;
        const me = meIn(issue);
        const linearTodo = backing.has(issue.id) || isLinearTodo(issue.detail, me, at);
        const { assignee, creator, updatedAt } = issue.detail;
        const mine = !!me && (assignee?.id === me || creator?.id === me);
        return linearTodo || (mine && at - updatedAt <= RECENT_MS) ? { me, linearTodo } : null;
      };

      // Open work involving the User: every review asked of them (while its Todo is open), and their
      // own open pull requests.
      const theirWork = (item: Item) =>
        isReviewRequestItem(item) || (isPullRequestItem(item) && isTheirs(item.detail, meIn(item)));

      // The Items any ranker may place, the most pressing by the rules first, so each batch is a
      // fair slice and the merge interleaves like with like.
      const all = [...todos, ...issues, ...chats, ...work];
      const open = dashboardCandidates(all, muted).filter((item) =>
        item.kind === 'todo'
          ? true
          : item.kind === 'chat'
            ? mayNeedUser(item)
            : item.source === 'github'
              ? theirWork(item)
              : involving(item),
      );
      // The rules see every Item, as they pick their own candidates (a review request needs its Todo).
      const ruled = new Map(
        rankByBandRules(all, { now: at, users, muted }).map((r, index) => [r.itemId, index]),
      );
      const ordered = [...open]
        .sort(
          (a, b) =>
            (ruled.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ruled.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
            b.updatedAt - a.updatedAt ||
            (a.id < b.id ? -1 : 1),
        )
        .slice(0, MAX_ITEMS);

      // Cleared rows stay out (keeping how he last ranked them) until their Item changes.
      const previous = new Map(itemStore.dashboard.aresRanking().entries.map((e) => [e.itemId, e]));
      const cleared = new Map(itemStore.dashboard.clears().map((clear) => [clear.itemId, clear]));
      const kept: AresRankingEntry[] = [];
      const leftOut = (itemId: string, fingerprint: string) => {
        const clear = cleared.get(itemId);
        if (!clear || (clear.fingerprint !== null && clear.fingerprint !== fingerprint)) return false;
        const before = previous.get(itemId);
        if (before) kept.push(before);
        return true;
      };

      const candidates: Candidate[] = [];
      const items: Input['items'] = [];
      const add = (
        itemId: string,
        seenAs: { itemId: string; fingerprint: string },
        data: Omit<PromptData, 'label'> & { what: string },
        fingerprint: string,
      ) => {
        const ref = `I${candidates.length + 1}`;
        candidates.push({
          ref,
          itemId,
          fingerprint,
          data: { label: `${ref} · ${data.what}`, from: data.from, text: data.text },
        });
        items.push(seenAs);
      };
      for (const item of ordered) {
        const fingerprint = rankingFingerprint(item);
        if (leftOut(item.id, fingerprint)) continue;
        if (item.kind === 'todo') {
          add(
            item.id,
            { itemId: item.id, fingerprint },
            { what: 'Todo', from: item, text: todoText(item, at) },
            fingerprint,
          );
          continue;
        }
        if (item.kind === 'chat') {
          add(
            item.id,
            { itemId: item.id, fingerprint },
            { what: 'Teams chat', from: item, text: chatText(item, meIn(item), at) },
            fingerprint,
          );
          continue;
        }
        if (isReviewRequestItem(item) || isPullRequestItem(item)) {
          const pull = isReviewRequestItem(item) ? byId.get(item.detail.pullRequestId ?? '') : item;
          const identifier = githubIdentifier(item.detail.repo, item.detail.number);
          add(
            item.id,
            { itemId: item.id, fingerprint },
            isReviewRequestItem(item)
              ? {
                  what: `GitHub review request ${identifier}`,
                  from: item,
                  text: reviewText(item, pull && isPullRequestItem(pull) ? pull : null, at),
                }
              : {
                  what: `GitHub pull request ${identifier}`,
                  from: item,
                  text: pullText(item as PullRequestItem, at),
                },
            fingerprint,
          );
          continue;
        }
        const involved = involving(item);
        const identifier = item.detail?.kind === 'linear-issue' ? item.detail.identifier : '';
        add(
          item.id,
          { itemId: item.id, fingerprint },
          {
            what: `Linear issue ${identifier}`,
            from: item,
            text: issueText(item, involved?.me ?? null, involved?.linearTodo ?? false, at),
          },
          fingerprint,
        );
      }
      for (const { item, block } of suggestions()) {
        const fingerprint = rankingFingerprint(item);
        if (leftOut(item.id, fingerprint) || !block) continue;
        const line = block.detail?.kind === 'block' ? block.detail.text : block.title;
        add(
          item.id,
          // Remembered by its Block (a suggestion isn't an Item), one fingerprint per suggestion.
          { itemId: block.id, fingerprint: `${item.id}:${fingerprint}` },
          {
            what: 'Suggested Todo',
            from: item,
            text: [
              `Title: ${item.title}`,
              `Suggested by Ares from this line in the User's Daily Note: “${cut(line, 300)}”`,
              `Project: ${projectName(item)}`,
            ].join('\n'),
          },
          fingerprint,
        );
      }

      // Nothing he hasn't seen as it is, and his ranking is today's: nothing to do.
      const rankedAt = itemStore.dashboard.aresRanking().at;
      const fresh = rankedAt !== null && localDay(rankedAt) === today;
      if (fresh && items.every((item) => seen(item.itemId, item.fingerprint)))
        return { items: [], candidates: [], kept };
      return { items, candidates, kept };
    },

    batch(input) {
      const parts: Input[] = [];
      for (let start = 0; start < input.candidates.length; start += batchSize) {
        parts.push({
          items: input.items.slice(start, start + batchSize),
          candidates: input.candidates.slice(start, start + batchSize),
          kept: input.kept,
        });
      }
      return parts;
    },

    prompt: (input) => ({
      instructions: instructions(now()),
      data: [...meetingContext(now()), ...input.candidates.map((candidate) => candidate.data)],
    }),

    output: OUTPUT,

    apply(answers, input) {
      const dropped: string[] = [];
      type Placed = {
        itemId: string;
        band: AresBand;
        reason: string;
        fingerprint: string;
        position: number;
        batch: number;
        rank: number;
      };
      const placed: Placed[] = [];
      const ranked = new Set<string>();
      answers.forEach(({ output, input: part }, batch) => {
        const byRef = new Map(part.candidates.map((candidate) => [candidate.ref, candidate]));
        const valid: Omit<Placed, 'position' | 'batch'>[] = [];
        for (const raw of output.ranking) {
          if (!raw) {
            dropped.push('an entry that wasn’t one');
            continue;
          }
          const candidate = byRef.get(raw.ref);
          if (!candidate) {
            dropped.push(`it named ${raw.ref}, which it wasn’t given`);
            continue;
          }
          if (ranked.has(candidate.itemId)) {
            dropped.push(`it named ${raw.ref} twice`);
            continue;
          }
          const band = raw.band.trim().toLowerCase();
          if (!isBand(band)) {
            dropped.push(`${raw.ref}: “${raw.band}” isn’t a band`);
            continue;
          }
          if (!Number.isFinite(raw.rank) || raw.rank < 1) {
            dropped.push(`${raw.ref}: its rank isn’t one`);
            continue;
          }
          const reason = cleanReason(raw.reason);
          if (band !== 'none' && !reason) {
            dropped.push(`${raw.ref}: no reason`);
            continue;
          }
          ranked.add(candidate.itemId);
          valid.push({
            itemId: candidate.itemId,
            band,
            reason,
            fingerprint: candidate.fingerprint,
            rank: raw.rank,
          });
        }
        for (const band of aresBands) {
          const inBand = valid.filter((each) => each.band === band).sort((a, b) => a.rank - b.rank);
          for (const [index, each] of inBand.entries())
            placed.push({ ...each, position: index / inBand.length, batch });
        }
        const left = part.candidates.filter((candidate) => !ranked.has(candidate.itemId)).length;
        if (left) dropped.push(`${left} Item(s) left to the rules`);
      });

      // Each band across the batches: by place in its batch's band, so their tops come first.
      const entries: AresRankingEntry[] = aresBands.flatMap((band) =>
        [
          ...placed
            .filter((each) => each.band === band)
            .sort((a, b) => a.position - b.position || a.batch - b.batch)
            .map(({ itemId, reason, fingerprint }) => ({ itemId, reason, fingerprint })),
          ...input.kept.filter((each) => each.band === band && !ranked.has(each.itemId)),
        ].map(({ itemId, reason, fingerprint }, index) => ({
          itemId,
          band,
          rank: index + 1,
          reason,
          fingerprint,
        })),
      );
      itemStore.dashboard.saveAresRanking(now(), entries);
      return { dropped };
    },
  };
}
