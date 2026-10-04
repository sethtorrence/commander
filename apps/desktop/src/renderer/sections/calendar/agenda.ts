import type { EventDetail, EventResponse, Item } from '@commander/domain';

/*
  The Agenda's arithmetic, kept free of React and of the machine's clock and time zone (both are
  passed in), so it can be tested in any zone: which local days an event falls on, the order of a
  day's events, how their times read, how many of today's are still to come, and the addresses that
  hand an event (or a new one) to Google Calendar.
*/

export type CalendarEvent = Item & { detail: EventDetail };

export const isEvent = (item: Item): item is CalendarEvent => item.detail?.kind === 'event';

const pad = (n: number) => String(n).padStart(2, '0');

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const timeFormats = new Map<string, Intl.DateTimeFormat>();

function formatOf(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  let format = cache.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
    cache.set(timeZone, format);
  }
  return format;
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a time zone. */
export function dayKey(at: number, timeZone: string): string {
  const parts = formatOf(dayFormats, timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** "09:05", on the 24-hour clock, in a time zone. */
export function clock(at: number, timeZone: string): string {
  const parts = formatOf(timeFormats, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '00';
  return `${part('hour')}:${part('minute')}`;
}

/** The day `count` days after `day` (YYYY-MM-DD). */
export function addDays(day: string, count: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + count));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

// How far a time zone's clocks are ahead of UTC at an instant, in ms.
function zoneOffset(at: number, timeZone: string): number {
  const parts = formatOf(offsetFormats, timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const shown = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return shown - (at - (at % 1000));
}

/** The instant a day starts (its local midnight) in a time zone. */
export function dayStart(day: string, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const utcMidnight = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  // The offset at UTC midnight, then again at the guess, which settles a daylight-saving change.
  const guess = utcMidnight - zoneOffset(utcMidnight, timeZone);
  return utcMidnight - zoneOffset(guess, timeZone);
}

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

const weekdayOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
};

/** "Monday 5 October" */
export function longDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${WEEKDAYS[weekdayOf(day)]} ${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** How a day's heading reads in the Agenda: "Today", "Tomorrow", or its weekday and date. */
export function dayTitle(day: string, today: string): string {
  if (day === today) return `Today · ${longDay(day)}`;
  if (day === addDays(today, 1)) return `Tomorrow · ${longDay(day)}`;
  return longDay(day);
}

/** The local days an event falls on: an all-day event's own days, a timed one's from start to end. */
export function daysOf(event: CalendarEvent, timeZone: string): string[] {
  const { detail } = event;
  let first: string;
  let last: string;
  if (detail.allDay && detail.start.date) {
    first = detail.start.date;
    // The end day is exclusive, as calendars write it.
    last = detail.end.date && detail.end.date > first ? addDays(detail.end.date, -1) : first;
  } else {
    first = dayKey(detail.start.at, timeZone);
    last = detail.end.at > detail.start.at ? dayKey(detail.end.at - 1, timeZone) : first;
  }
  const days = [first];
  for (let day = first; day < last && days.length < 400; ) {
    day = addDays(day, 1);
    days.push(day);
  }
  return days;
}

export type AgendaEntry = {
  event: CalendarEvent;
  day: string;
  // "09:00", "All day", "Continues", "Until 10:30"; and the end, "09:45", for a timed event that
  // starts and ends that day.
  time: string;
  until: string | null;
};

export type AgendaDay = { day: string; title: string; entries: AgendaEntry[] };

function entryFor(event: CalendarEvent, day: string, timeZone: string): AgendaEntry {
  const { detail } = event;
  if (detail.allDay) return { event, day, time: 'All day', until: null };
  const startDay = dayKey(detail.start.at, timeZone);
  const endDay = detail.end.at > detail.start.at ? dayKey(detail.end.at - 1, timeZone) : startDay;
  const start = clock(detail.start.at, timeZone);
  const end = clock(detail.end.at, timeZone);
  if (day === startDay) return { event, day, time: start, until: endDay === day ? end : null };
  if (day === endDay) return { event, day, time: 'Continues', until: end };
  return { event, day, time: 'Continues', until: null };
}

// All-day events first, then by start, then by title.
function inDayOrder(a: AgendaEntry, b: AgendaEntry): number {
  const allDay = Number(b.event.detail.allDay) - Number(a.event.detail.allDay);
  if (allDay) return allDay;
  const continuing = Number(b.time === 'Continues') - Number(a.time === 'Continues');
  if (continuing) return continuing;
  return a.event.detail.start.at - b.event.detail.start.at || a.event.title.localeCompare(b.event.title);
}

/**
 * The Agenda: from `today` for `days` days, each day with events and its events in order. Today is
 * always there, even with nothing on it.
 */
export function agendaDays(
  events: readonly CalendarEvent[],
  { today, days, timeZone }: { today: string; days: number; timeZone: string },
): AgendaDay[] {
  const last = addDays(today, days - 1);
  const byDay = new Map<string, AgendaEntry[]>([[today, []]]);
  for (const event of events) {
    for (const day of daysOf(event, timeZone)) {
      if (day < today || day > last) continue;
      byDay.set(day, [...(byDay.get(day) ?? []), entryFor(event, day, timeZone)]);
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, entries]) => ({ day, title: dayTitle(day, today), entries: entries.sort(inDayOrder) }));
}

/** How many of today's timed events haven't started yet: the Calendar tab's count. */
export function stillToCome(events: readonly CalendarEvent[], now: number, timeZone: string): number {
  const today = dayKey(now, timeZone);
  return events.filter(
    (event) =>
      !event.detail.allDay &&
      event.detail.start.at > now &&
      dayKey(event.detail.start.at, timeZone) === today,
  ).length;
}

/** "Monday 5 October · 10:00–10:45", "Monday 12 – Tuesday 13 October · All day". */
export function whenText(event: CalendarEvent, timeZone: string): string {
  const days = daysOf(event, timeZone);
  const first = days[0] ?? '';
  const last = days.at(-1) ?? first;
  const span = first === last ? longDay(first) : `${longDay(first)} – ${longDay(last)}`;
  if (event.detail.allDay) return `${span} · All day`;
  return `${span} · ${clock(event.detail.start.at, timeZone)}–${clock(event.detail.end.at, timeZone)}`;
}

export const RESPONSE_NAMES: Record<EventResponse, string> = {
  accepted: 'Going',
  tentative: 'Maybe',
  declined: 'Not going',
  'needs-action': 'Not answered',
};

const withAccount = (url: string, email: string | null) => {
  if (!email) return url;
  const address = new URL(url);
  address.searchParams.set('authuser', email);
  return address.toString();
};

/** Google Calendar's new-event page, for the Account with this address. */
export function newEventUrl(email: string | null): string {
  return withAccount('https://calendar.google.com/calendar/r/eventedit', email);
}

/** The event at Google Calendar, opened as the Account it came through. Null when it has no link. */
export function editUrl(event: CalendarEvent): string | null {
  const { webUrl, accountEmail } = event.detail;
  if (!webUrl) return null;
  try {
    return withAccount(webUrl, accountEmail);
  } catch {
    return null;
  }
}
