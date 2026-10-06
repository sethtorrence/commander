import { z } from 'zod';
import { githubIdentifier, type PullRequestDetail } from './github';
import {
  isBot,
  type OversightRangeSpan,
  type OversightSettings,
  oversightRange,
  oversightRangeSpan,
  REVIEW_WAIT_DAYS,
  type StuckReason,
  stuckReason,
  stuckReasons,
} from './github-oversight';
import { personParagraph, summaryWriterState } from './github-summary';
import type { Item } from './items';
import type { Person } from './people';

/*
  The People view (#122, decision #18): each Person's week in the watched repos, for spotting who is
  stuck or overloaded. Never for ranking: cards go by name, whatever their numbers, and nothing here
  scores, ranks or compares People.

  For a range (This week from Monday, or the last 7 days; a Person's page looks further back) and a
  scope (everything, one Project, or Unfiled, by the Items' filing), each Person active in the watched
  repos gets:

  - Merged and Reviewed: pull requests they merged, and reviewed (someone else's), in the range.
  - Opened: pull requests they opened in the range.
  - Open: their open pull requests, whenever opened, longest open first, each with how long and why
    it is Stuck by the summary's rules (#119).
  - Waiting: open, non-draft pull requests asking for their review and not reviewed by them since,
    oldest first, with how long each has waited.
  - Linear: open Linear issues assigned to them, through their Linear handle.
  - Marks in plain words for what is worth a look ("3 reviews waiting, oldest 4 days", "PR open 12
    days"); never a score.

  Active means anything but Linear issues: Linear isn't the watched repos. The User (they have Your
  work) and bots are left out. A Person's logins share one card; a login matched to no Person is a card
  of its own, by the login. Asked for one Person (their page), it gives their card even when empty.
*/

const DAY = 24 * 60 * 60 * 1000;
const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const days = z.number().int().nonnegative();

// One pull request on a card: its Item, identifier (acme/api#12) and title, and when it was merged,
// reviewed, opened or asked of them.
export const personWork = z.object({ itemId: id, identifier: z.string(), title: z.string(), at: timestamp });
export type PersonWork = z.infer<typeof personWork>;

export const personWeek = z.object({
  // The Person's id, or `github:<login>` for a login matched to no Person.
  key: z.string(),
  personId: id.nullable(),
  name: z.string(),
  isUser: z.boolean(),
  // Their GitHub logins, lower-cased.
  logins: z.array(z.string()),
  // Newest first.
  merged: z.array(personWork),
  reviewed: z.array(personWork),
  opened: z.array(personWork),
  // Longest open first; `at` is when it was opened.
  open: z.array(personWork.extend({ openDays: days, draft: z.boolean(), stuck: z.array(stuckReason) })),
  // Oldest first; `at` is when their review was asked; `author` as the Person goes by.
  waiting: z.array(personWork.extend({ author: z.string().nullable(), waitDays: days })),
  linear: z.array(
    z.object({
      itemId: id,
      identifier: z.string(),
      title: z.string(),
      state: z.string(),
      stateType: z.string(),
    }),
  ),
  marks: z.array(z.string()),
});
export type PersonWeek = z.infer<typeof personWeek>;

// A card as the window shows it: the week, and Ares's latest paragraph about them (or none yet).
export const personCard = personWeek.extend({ paragraph: personParagraph.nullable() });
export type PersonCard = z.infer<typeof personCard>;

export const githubPeopleView = z.object({
  range: oversightRangeSpan,
  cards: z.array(personCard),
  // How Ares's summary writing stands: whether Refresh can write a paragraph.
  writer: summaryWriterState,
});
export type GitHubPeopleView = z.infer<typeof githubPeopleView>;

// The range switch, and a Person's page's longer ones.
export const peopleRangeKinds = ['this-week', 'last-7-days', 'last-30-days', 'last-90-days'] as const;
export const peopleRangeKind = z.enum(peopleRangeKinds);
export type PeopleRangeKind = z.infer<typeof peopleRangeKind>;
export const PEOPLE_RANGE_LABELS: Record<PeopleRangeKind, string> = {
  'this-week': 'This week',
  'last-7-days': 'Last 7 days',
  'last-30-days': 'Last 30 days',
  'last-90-days': 'Last 90 days',
};

/** The span a range covers at `now`: This week from Monday's start (in the time zone), else days back. */
export function peopleRange(kind: PeopleRangeKind, now: number, timeZone: string): OversightRangeSpan {
  switch (kind) {
    case 'this-week':
      return oversightRange({ kind: 'this-week' }, now, timeZone);
    case 'last-7-days':
      return { from: Math.max(0, now - 7 * DAY), to: now };
    case 'last-30-days':
      return { from: Math.max(0, now - 30 * DAY), to: now };
    case 'last-90-days':
      return { from: Math.max(0, now - 90 * DAY), to: now };
  }
}

export type GitHubPeopleInput = {
  range: OversightRangeSpan;
  // Left out: everything; null: Unfiled; else one Project's id.
  projectId?: string | null;
  // The live pull requests and Linear issues (anything else is ignored).
  items: readonly Item[];
  people: readonly Person[];
  settings: OversightSettings;
  // Only this Person, whatever they did (their page).
  personId?: string;
};

type PullRequest = Item & { detail: PullRequestDetail };

const wholeDays = (ms: number) => Math.max(0, Math.floor(ms / DAY));
const inRange = (at: number | null, { from, to }: OversightRangeSpan) =>
  at !== null && at >= from && at <= to;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LINEAR_DONE = new Set(['completed', 'canceled', 'cancelled', 'duplicate']);

/** Each Person's week in the watched repos, by name: never ranked. */
export function githubPeople(input: GitHubPeopleInput): PersonWeek[] {
  const { range, settings } = input;
  const now = range.to;
  const byHandle = new Map<string, Person>();
  for (const each of input.people)
    for (const { handle } of each.handles) byHandle.set(handle.toLowerCase(), each);
  const personOfLogin = (login: string) => byHandle.get(`github:${login.toLowerCase()}`) ?? null;
  const nameOf = (login: string) => personOfLogin(login)?.name ?? login;
  const wanted = (item: Item) =>
    input.projectId === undefined || (item.filing?.projectId ?? null) === input.projectId;

  const weeks = new Map<string, PersonWeek>();
  const blank = (key: string, person: Person | null, name: string): PersonWeek => ({
    key,
    personId: person?.id ?? null,
    name,
    isUser: person?.isUser ?? false,
    logins: [],
    merged: [],
    reviewed: [],
    opened: [],
    open: [],
    waiting: [],
    linear: [],
    marks: [],
  });
  const weekOf = (login: string): PersonWeek => {
    const person = personOfLogin(login);
    const key = person?.id ?? `github:${login.toLowerCase()}`;
    let found = weeks.get(key);
    if (!found) {
      found = blank(key, person, person?.name ?? login);
      weeks.set(key, found);
    }
    if (!found.logins.includes(login.toLowerCase())) found.logins.push(login.toLowerCase());
    return found;
  };
  const counts = (login: string | null): login is string => !!login && !isBot(login, settings.bots);

  const pulls = input.items.filter(
    (item): item is PullRequest => item.detail?.kind === 'pull-request' && item.deletedAt === null,
  );
  for (const pull of pulls) {
    if (!wanted(pull)) continue;
    const { detail } = pull;
    const work = (at: number): PersonWork => ({
      itemId: pull.id,
      identifier: githubIdentifier(detail.repo, detail.number),
      title: pull.title,
      at,
    });
    if (counts(detail.author)) {
      const week = weekOf(detail.author);
      if (detail.state === 'merged' && inRange(detail.mergedAt, range))
        week.merged.push(work(detail.mergedAt ?? 0));
      if (inRange(detail.createdAt, range)) week.opened.push(work(detail.createdAt));
      if (detail.state === 'open')
        week.open.push({
          ...work(detail.createdAt),
          openDays: wholeDays(now - detail.createdAt),
          draft: detail.draft,
          stuck: stuckReasons(detail, now, settings, nameOf),
        });
    }
    const reviewedBy = new Set<string>();
    for (const review of detail.reviews) {
      if (!inRange(review.submittedAt, range) || !counts(review.login)) continue;
      if (detail.author && same(review.login, detail.author)) continue;
      const week = weekOf(review.login);
      if (reviewedBy.has(week.key)) continue;
      reviewedBy.add(week.key);
      week.reviewed.push(work(review.submittedAt ?? 0));
    }
    if (detail.state !== 'open' || detail.draft) continue;
    for (const asked of detail.requestedReviewers) {
      if (asked.kind !== 'user' || !counts(asked.login)) continue;
      const since = asked.requestedAt ?? detail.createdAt;
      const reviewedSince = detail.reviews.some(
        (review) =>
          review.submittedAt !== null && review.submittedAt >= since && same(review.login, asked.login),
      );
      if (reviewedSince) continue;
      weekOf(asked.login).waiting.push({
        ...work(since),
        author: detail.author ? nameOf(detail.author) : null,
        waitDays: wholeDays(now - since),
      });
    }
  }

  // Only the Person asked for (their page), even with nothing to show; else the active ones but the User.
  let shown: PersonWeek[];
  if (input.personId !== undefined) {
    const person = input.people.find((each) => each.id === input.personId);
    if (!person) return [];
    shown = [weeks.get(person.id) ?? blank(person.id, person, person.name)];
    for (const { handle } of person.handles)
      if (handle.toLowerCase().startsWith('github:')) {
        const login = handle.slice('github:'.length).toLowerCase();
        if (!shown[0]?.logins.includes(login)) shown[0]?.logins.push(login);
      }
  } else {
    shown = [...weeks.values()].filter(
      (week) =>
        !week.isUser &&
        (week.merged.length ||
          week.reviewed.length ||
          week.opened.length ||
          week.open.length ||
          week.waiting.length),
    );
  }

  // Their open Linear issues, through their Linear handles.
  const byKey = new Map(shown.map((week) => [week.key, week]));
  for (const item of input.items) {
    const detail = item.detail;
    if (detail?.kind !== 'linear-issue' || item.deletedAt !== null || !detail.assignee || !wanted(item))
      continue;
    if (LINEAR_DONE.has(detail.state.type) || item.status === 'done') continue;
    const person = byHandle.get(`linear:${detail.assignee.id}`.toLowerCase());
    const week = person ? byKey.get(person.id) : undefined;
    if (!week) continue;
    week.linear.push({
      itemId: item.id,
      identifier: detail.identifier,
      title: item.title,
      state: detail.state.name,
      stateType: detail.state.type,
    });
  }

  for (const week of shown) {
    week.merged.sort((a, b) => b.at - a.at);
    week.reviewed.sort((a, b) => b.at - a.at);
    week.opened.sort((a, b) => b.at - a.at);
    week.open.sort((a, b) => a.at - b.at || a.identifier.localeCompare(b.identifier));
    week.waiting.sort((a, b) => a.at - b.at || a.identifier.localeCompare(b.identifier));
    week.linear.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
    week.logins.sort();
    week.marks = marksOf(week, settings, now);
  }
  return shown.sort(byName);
}

/** By name, whatever the counts: the only order the People view has. */
export function byName(a: Pick<PersonWeek, 'name' | 'key'>, b: Pick<PersonWeek, 'name' | 'key'>): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key)
  );
}

// What is worth a look, in plain words: reviews piling up or waiting long, pull requests open long,
// and stuck ones. Never a score.
function marksOf(week: PersonWeek, settings: OversightSettings, now: number): string[] {
  const marks: string[] = [];
  const waiting = week.waiting.length;
  const oldestWait = week.waiting[0];
  if (oldestWait && (waiting >= 3 || now - oldestWait.at > REVIEW_WAIT_DAYS * DAY)) {
    marks.push(
      waiting === 1
        ? `1 review waiting ${counted(oldestWait.waitDays, 'day')}`
        : `${waiting} reviews waiting, oldest ${counted(oldestWait.waitDays, 'day')}`,
    );
  }
  const long = week.open.filter((pull) => !pull.draft && pull.openDays > settings.longRunningDays);
  const [oldest] = long;
  if (oldest)
    marks.push(
      long.length === 1
        ? `PR open ${counted(oldest.openDays, 'day')}`
        : `${long.length} PRs open over ${counted(settings.longRunningDays, 'day')}, oldest ${counted(oldest.openDays, 'day')}`,
    );
  const stuck = week.open.filter((pull) => pull.stuck.length).length;
  if (stuck) marks.push(`${counted(stuck, 'PR')} stuck`);
  return marks;
}

export type { StuckReason };
