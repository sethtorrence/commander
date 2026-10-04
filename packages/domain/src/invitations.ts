import type { EventDetail, EventResponse } from './calendar';
import type { Item } from './items';
import { clockOf } from './meetings';
import { daysBetween, localDay } from './ranking';

/*
  Invitations (#129): events someone else organised that the User is a guest of, which they answer
  with Accept, Maybe or Decline from the Calendar Section. Shared by the Core (two-way sync, Ares's
  "Suggest invitation replies" job) and the window (the buttons, the Dashboard's Today band). Pure,
  with times read in the User's own time zone, like the rest of the Dashboard's days.

  - An answer is the synced field `response` (the event's `myResponse`), written back by each calendar
    Source; an instance of a series also has `seriesResponse`, its answer for the whole series.
  - Awaiting an answer: an invitation still to come (not over yet) the User hasn't answered.
  - Double-booked: another event keeps the User busy at the same time, from any Account or calendar
    (clashes.ts: `overlapping`, beside the Calendar views' clash marks).
*/

type Event = Item & { detail: EventDetail };

// Ares's job that spots double-bookings, and the Act for you action it proposes under ("Reply to
// invitations"): replying is seen by the organiser, so it is only ever a suggestion.
export const SUGGEST_INVITATION_REPLIES = 'suggest-invitation-replies';
export const REPLY_TO_INVITATIONS = 'reply-to-invitations';

/** The answers the User can give, as the buttons name them. */
export const INVITATION_ANSWERS = ['accepted', 'tentative', 'declined'] as const;
export type InvitationAnswer = (typeof INVITATION_ANSWERS)[number];
export const ANSWER_NAMES: Record<InvitationAnswer, string> = {
  accepted: 'Accept',
  tentative: 'Maybe',
  declined: 'Decline',
};

/** Whether an event's detail is an invitation the User can answer: they are a guest, not its organiser. */
export function canAnswer(detail: EventDetail): boolean {
  return detail.myResponse !== null && detail.organiser?.self !== true && detail.createdByCommander === null;
}

/** Whether an Item is a live invitation the User can answer. */
export function isInvitation(item: Item | null | undefined): item is Event {
  return (
    item?.kind === 'event' &&
    item.detail?.kind === 'event' &&
    item.deletedAt === null &&
    canAnswer(item.detail)
  );
}

/** Whether an invitation still to come (or still going on) at `now` is waiting for the User's answer. */
export function awaitingAnswer(item: Item | null | undefined, now: number): item is Event {
  return isInvitation(item) && item.detail.myResponse === 'needs-action' && item.detail.end.at > now;
}

/** The answer to the whole series an instance carries: its own, unless answered apart in Commander. */
export const seriesAnswerOf = (detail: EventDetail): EventResponse | null =>
  detail.seriesResponse ?? detail.myResponse;

/**
 * The synced fields an answer changes (for `edit-fields`): this event's answer, or, with `series`, the
 * whole series' too (an instance of a series only).
 */
export function answerFields(
  detail: EventDetail,
  answer: EventResponse,
  series = false,
): Record<string, EventResponse> {
  return series && detail.seriesId ? { response: answer, seriesResponse: answer } : { response: answer };
}

// ---------------------------------------------------------------------------------------------
// The Dashboard

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When an invitation is, seen from `now`: "today 15:00", "tomorrow 15:00", "Thu 15:00", "15 Oct 15:00". */
export function invitationWhen(detail: Pick<EventDetail, 'start' | 'allDay'>, now: number): string {
  const ahead = daysBetween(localDay(now), localDay(detail.start.at));
  const date = new Date(detail.start.at);
  const day =
    ahead <= 0
      ? 'today'
      : ahead === 1
        ? 'tomorrow'
        : ahead < 7
          ? WEEKDAYS[date.getDay()]
          : `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return detail.allDay ? `${day}, all day` : `${day} ${clockOf(detail.start.at)}`;
}

/** Who invited the User, by first name: "Dana", or their address. */
export function inviterOf(detail: EventDetail): string {
  const organiser = detail.organiser ?? detail.attendees.find((each) => each.organiser) ?? null;
  if (!organiser) return 'Someone';
  return organiser.name?.trim().split(/\s+/)[0] || organiser.email;
}

/** The Dashboard's reason for an invitation awaiting an answer: "Dana invited you to Pricing review, Thu 15:00". */
export function invitationReason(item: Event, now: number): string {
  return `${inviterOf(item.detail)} invited you to ${item.title}, ${invitationWhen(item.detail, now)}`;
}
