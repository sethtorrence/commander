import type { EventDetail } from './calendar';
import type { Item } from './items';
import { daysBetween, localDay } from './ranking';

/*
  Today's meetings (#128), shared by the Core (which keeps the meeting chips in today's Daily Note,
  writes the Markdown copy and sends the heads-up) and the window (which draws the chips' live cards,
  the Dashboard's schedule and ranks the next meeting into Now). Pure, with times read in the User's
  own time zone, like the rest of the Dashboard's days.

  - A meeting gets a chip when it is chip-worthy: a timed event (not all-day) the User is busy for,
    hasn't declined, that isn't cancelled and that Commander didn't put in the calendar itself (a focus
    block). Read from the event detail, so Google Calendar and Outlook Calendar alike.
  - It reads as its times and title, "10:00–10:30 Weekly sync with Priya", and, seen from the day of
    the note it is in, as cancelled, declined or moved to another day.
*/

type Event = Item & { detail: EventDetail };

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whether an Item is a calendar event with its detail. */
export const isEvent = (item: Item | null | undefined): item is Event =>
  item?.kind === 'event' && item.detail?.kind === 'event';

/**
 * Whether a top-level Block is the one meeting chips go under: its text is "Meetings", in any case,
 * as a heading or not, with or without a Project's `#CODE`.
 */
export function isMeetingsBlockText(text: string): boolean {
  const words = text
    .replace(/^\s*#{1,3}\s+/, '')
    .replace(/(^|\s)#[A-Za-z]+(?![A-Za-z0-9_])/g, ' ')
    .trim();
  return words.toLowerCase() === 'meetings';
}

/** A time of day on the User's clock: "09:30". */
export function clockOf(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Whether an event gets a meeting chip: timed, busy, not declined, not cancelled, not Commander's own. */
export function isChipWorthy(item: Item | null | undefined): item is Event {
  if (!isEvent(item) || item.deletedAt !== null) return false;
  const { detail } = item;
  return !detail.allDay && detail.busy && detail.myResponse !== 'declined' && !detail.createdByCommander;
}

/** The local day a timed event starts on. */
export const meetingDay = (detail: Pick<EventDetail, 'start'>) => localDay(detail.start.at);

/** Whether an event gets a meeting chip in the Daily Note of `day`: chip-worthy, and starting that day. */
export function chipWorthyOn(item: Item | null | undefined, day: string): item is Event {
  return isChipWorthy(item) && meetingDay(item.detail) === day;
}

/** "10:00–10:30" */
export function meetingTimes(detail: Pick<EventDetail, 'start' | 'end'>): string {
  return `${clockOf(detail.start.at)}–${clockOf(detail.end.at)}`;
}

/** Where a meeting stands, seen from the note of `day`: on, cancelled, declined, or moved to another day. */
export type MeetingStatus =
  | { kind: 'on' }
  | { kind: 'cancelled' }
  | { kind: 'declined' }
  | { kind: 'moved'; to: string };

// "Thu 10:00" within the coming week, "Thu 15 Oct 10:00" otherwise.
function movedTo(at: number, from: string): string {
  const day = localDay(at);
  const date = new Date(at);
  const ahead = daysBetween(from, day);
  const name =
    ahead > 0 && ahead < 7
      ? (WEEKDAYS[date.getDay()] ?? '')
      : `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return `${name} ${clockOf(at)}`;
}

/** Where the meeting stands for the note of `day`. An event Commander no longer holds counts as cancelled. */
export function meetingStatus(item: Item | null | undefined, day: string): MeetingStatus {
  if (!isEvent(item) || item.deletedAt !== null) return { kind: 'cancelled' };
  if (item.detail.myResponse === 'declined') return { kind: 'declined' };
  if (!item.detail.allDay && meetingDay(item.detail) !== day)
    return { kind: 'moved', to: movedTo(item.detail.start.at, day) };
  return { kind: 'on' };
}

/** The words for a status other than on: "Cancelled", "Declined", "Moved to Thu 10:00". */
export function meetingStatusText(status: MeetingStatus): string | null {
  switch (status.kind) {
    case 'on':
      return null;
    case 'cancelled':
      return 'Cancelled';
    case 'declined':
      return 'Declined';
    case 'moved':
      return `Moved to ${status.to}`;
  }
}

/**
 * A meeting as one line of plain Markdown (the Markdown copy): "10:00–10:30 Weekly sync with Priya",
 * struck through when cancelled or declined, with where it moved to when it did.
 */
export function meetingLine(item: Item | null | undefined, day: string): string {
  if (!isEvent(item)) return 'A meeting Commander no longer has (Cancelled)';
  const status = meetingStatus(item, day);
  const times = item.detail.allDay ? 'All day' : meetingTimes(item.detail);
  const line = `${times} ${item.title}`.trim();
  const note = meetingStatusText(status);
  if (status.kind === 'cancelled' || status.kind === 'declined') return `~~${line}~~ (${note})`;
  return note ? `${line} (${note})` : line;
}
