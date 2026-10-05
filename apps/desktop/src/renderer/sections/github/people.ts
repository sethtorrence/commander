import {
  byName,
  type GitHubPeopleView,
  localDay,
  type OversightRangeSpan,
  type PeopleRangeKind,
  type PersonCard,
  type PersonParagraph,
  type PersonParagraphAnswer,
  peopleRange,
  type StuckReason,
} from '@commander/domain';
import type { ItemStoreClient } from '../../item-store/client';
import type { UpdatesClient } from '../../updates/updates';

/*
  The People view (#122) in the window: each Person's week in the watched repos from the Core, by
  name, never ranked, with Ares's latest paragraph about them, and Refresh asking him to write one
  Person's again (through the Updates channel, like his other Skills). A Person's page asks for one
  Person over a longer range.
*/

/** Everything, one Project (its id) or Unfiled: the Section's Project filter. */
export type PeopleScope = 'everything' | 'unfiled' | string;

export interface PeopleViewClient {
  /** Each active Person's week over a range and scope, with how Ares's writing stands. */
  week(range: OversightRangeSpan, scope: PeopleScope): Promise<GitHubPeopleView>;
  /** One Person's, whatever they did (their page). */
  person(personId: string, range: OversightRangeSpan): Promise<GitHubPeopleView>;
  /** Refresh: Ares writes their paragraph again; what he wrote, or why there is none. */
  refresh?(personId: string, range: OversightRangeSpan): Promise<PersonParagraphAnswer>;
}

export function peopleViewIn(itemStore: ItemStoreClient, updates?: UpdatesClient): PeopleViewClient {
  return {
    week: (range, scope) =>
      itemStore({
        op: 'github-people',
        range,
        ...(scope !== 'everything' && { projectId: scope === 'unfiled' ? null : scope }),
      }),
    person: (personId, range) => itemStore({ op: 'github-people', range, personId }),
    ...(updates && {
      refresh: (personId: string, range: OversightRangeSpan) =>
        updates({ op: 'refresh-person-paragraph', request: { personId, range } }),
    }),
  };
}

/** The machine's time zone, which This week is reckoned in. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The span a range covers now. */
export const spanOf = (kind: PeopleRangeKind, now: number): OversightRangeSpan =>
  peopleRange(kind, now, timeZone());

/** Cards in the only order the view has: by name, whatever their numbers. */
export const inNameOrder = (cards: readonly PersonCard[]): PersonCard[] => [...cards].sort(byName);

/** "today", "1 day", "12 days". */
export const daysText = (days: number) => (days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'}`);

/** Why a pull request is Stuck, in a few words. */
export function stuckText(reason: StuckReason): string {
  switch (reason.kind) {
    case 'review-waiting':
      return `waiting ${daysText(reason.days)} on ${reason.name}`;
    case 'checks-failing':
      return 'checks failing';
    case 'idle':
      return `no activity for ${daysText(reason.idleDays)}`;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const dayMonth = (at: number) => `${new Date(at).getDate()} ${MONTHS[new Date(at).getMonth()]}`;

/** "Written by Ares 07:02 · 28 Sep to now" (or "Mon 5 Oct 07:02" on another day). */
export function writtenBy(paragraph: Pick<PersonParagraph, 'writtenAt' | 'range'>, now: number): string {
  const at = paragraph.writtenAt;
  const when =
    localDay(at) === localDay(now)
      ? clock(at)
      : `${DAYS[new Date(at).getDay()]} ${dayMonth(at)} ${clock(at)}`;
  const { from, to } = paragraph.range;
  const span =
    localDay(to) === localDay(at) ? `${dayMonth(from)} to now` : `${dayMonth(from)} to ${dayMonth(to)}`;
  return `Written by Ares ${when} · ${span}`;
}
