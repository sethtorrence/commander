import { z } from 'zod';
import type { EventAttendee, EventDetail } from './calendar';
import type { Item } from './items';
import { clockOf, isChipWorthy } from './meetings';

/*
  Meeting prep (#130): half an hour before a meeting, Ares has done the homework. The prep is an Item
  made by Ares (kind `meeting-prep`) with an about Link to its event and refers-to Links to the Items
  each line rests on; re-running replaces it. Its words are a model's: shown only with AresText, and
  each line names the Items it came from (anything naming none was dropped before it was kept).

  - A meeting is prepared for when it gets a meeting chip (timed, busy, not declined, not cancelled,
    not Commander's own) and has at least one other person in it.
  - Prepared once per revision of the event: a prep made for the event as it is now stands until the
    event changes (moved, retitled, its description or guests changed) or the User asks again.
*/

export const PREPARE_MEETINGS = 'prepare-meetings';
export const PREPARE_MEETINGS_NAME = 'Prepare for meetings';
/** How long before a meeting Ares prepares it. */
export const PREP_LEAD_MS = 30 * 60_000;

const id = z.string().min(1);

// One line of a prep: Ares's words, and the Items they rest on (never empty).
export const prepLine = z.object({ text: z.string().min(1), sources: z.array(id).min(1) });
export type PrepLine = z.infer<typeof prepLine>;

export const meetingPrepDetail = z.object({
  kind: z.literal('meeting-prep'),
  // The event it prepares for (also its about Link).
  eventId: id,
  // The event as it was when prepared (eventRevision).
  revision: z.string().min(1),
  preparedAt: z.number().int().nonnegative(),
  // What the meeting is about.
  about: prepLine.nullable(),
  // What was said last time.
  lastTime: z.array(prepLine),
  // What's open with the people in it.
  open: z.array(prepLine),
  // Anything worth raising.
  raise: z.array(prepLine),
});
export type MeetingPrepDetail = z.infer<typeof meetingPrepDetail>;

type Event = Item & { detail: EventDetail };
export type MeetingPrep = Item & { detail: MeetingPrepDetail };

/** Whether an Item is a meeting prep with its detail. */
export const isMeetingPrep = (item: Item | null | undefined): item is MeetingPrep =>
  item?.kind === 'meeting-prep' && item.detail?.kind === 'meeting-prep';

/** The other people in a meeting: its guests and organiser who aren't the User, rooms left out. */
export function otherAttendees(detail: Pick<EventDetail, 'attendees' | 'organiser'>): EventAttendee[] {
  const seen = new Set<string>();
  const people: EventAttendee[] = [];
  for (const each of detail.attendees) {
    const email = each.email.toLowerCase();
    if (each.self || each.resource || seen.has(email)) continue;
    seen.add(email);
    people.push(each);
  }
  const organiser = detail.organiser;
  if (organiser && !organiser.self && !seen.has(organiser.email.toLowerCase())) {
    people.push({ ...organiser, response: 'accepted', organiser: true, optional: false, resource: false });
  }
  return people;
}

/** Whether Ares prepares for an event: it gets a meeting chip and someone else is in it. */
export function isPrepWorthy(item: Item | null | undefined): item is Event {
  return isChipWorthy(item) && otherAttendees(item.detail).length > 0;
}

// FNV-1a, as hex: short and stable, enough to tell two revisions of an event apart.
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The event as a prep sees it: changes when its title, times, description or guests do. */
export function eventRevision(event: Pick<Item, 'title'> & { detail: EventDetail }): string {
  const { start, end, description, attendees, organiser, seriesId } = event.detail;
  return hash(
    JSON.stringify([
      event.title,
      start.at,
      end.at,
      description ?? '',
      organiser?.email.toLowerCase() ?? '',
      seriesId ?? '',
      attendees.map((each) => [each.email.toLowerCase(), each.response]).sort(),
    ]),
  );
}

/** Every line of a prep, in the order it reads. */
export const prepLines = (detail: MeetingPrepDetail): PrepLine[] => [
  ...(detail.about ? [detail.about] : []),
  ...detail.lastTime,
  ...detail.open,
  ...detail.raise,
];

/** The Items a prep's lines rest on, each once. */
export const prepSources = (detail: MeetingPrepDetail): string[] => [
  ...new Set(prepLines(detail).flatMap((line) => line.sources)),
];

/** A prep's title: "Prep: 1:1 with Priya". */
export const prepTitle = (eventTitle: string) => `Prep: ${eventTitle.replace(/\s+/g, ' ').trim()}`;

/** The Update line's words: "Prep for “1:1 with Priya” at 15:00 is ready." */
export function prepReadyText(about: { title: string; startsAt: number }, { quote = true } = {}): string {
  const at = clockOf(about.startsAt);
  return quote
    ? `Prep for “${about.title.replace(/\s+/g, ' ').trim()}” at ${at} is ready.`
    : `Prep for your meeting at ${at} is ready.`;
}
