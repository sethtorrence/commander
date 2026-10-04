import { addDays } from './agenda';

/*
  The Calendar Section's views (#127): Day, Week, Month and the Agenda. Which days each shows around
  the day it is anchored on, how `[` and `]` move it, how its range reads in the toolbar, and whether
  it reaches past the days calendar sync keeps. Plain calendar-day arithmetic (YYYY-MM-DD), with no
  clock and no time zone: the caller passes today.
*/

export const CALENDAR_VIEWS = ['day', 'week', 'month', 'agenda'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const VIEW_NAMES: Record<CalendarView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
};

/** A saved view, or the Agenda when there is none (or it isn't one). */
export const viewOf = (saved: string | null): CalendarView =>
  (CALENDAR_VIEWS as readonly (string | null)[]).includes(saved) ? (saved as CalendarView) : 'agenda';

// How far back and ahead calendar sync keeps events (Google Calendar's and Outlook Calendar's
// WINDOW_BACK_DAYS and WINDOW_AHEAD_DAYS in @commander/sources).
export const SYNCED_DAYS_BACK = 30;
export const SYNCED_DAYS_AHEAD = 365;

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
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const partsOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return { year: y ?? 1970, month: m ?? 1, date: d ?? 1 };
};
const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (year: number, month: number, date: number) => {
  const at = new Date(Date.UTC(year, month - 1, date));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
};
const weekday = (day: string) => {
  const { year, month, date } = partsOf(day);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
};
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The Monday of the week a day is in (weeks run Monday to Sunday). */
export const weekStart = (day: string) => addDays(day, -((weekday(day) + 6) % 7));

const run = (first: string, count: number) => Array.from({ length: count }, (_, i) => addDays(first, i));

/** The days a view shows, anchored on a day: in order, each once. */
export function viewDays(view: CalendarView, anchor: string, agendaDays: number): string[] {
  switch (view) {
    case 'day':
      return [anchor];
    case 'week':
      return run(weekStart(anchor), 7);
    case 'agenda':
      return run(anchor, agendaDays);
    case 'month': {
      const { year, month } = partsOf(anchor);
      const first = weekStart(dayOf(year, month, 1));
      const last = addDays(weekStart(dayOf(year, month, daysInMonth(year, month))), 6);
      return run(first, Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1);
    }
  }
}

/** Where `[` (back) and `]` (forward) move a view's anchor: by its span. */
export function stepAnchor(view: CalendarView, anchor: string, step: 1 | -1, agendaDays: number): string {
  switch (view) {
    case 'day':
      return addDays(anchor, step);
    case 'week':
      return addDays(anchor, 7 * step);
    case 'agenda':
      return addDays(anchor, agendaDays * step);
    case 'month': {
      const { year, month, date } = partsOf(anchor);
      const next = new Date(Date.UTC(year, month - 1 + step, 1));
      const y = next.getUTCFullYear();
      const m = next.getUTCMonth() + 1;
      return dayOf(y, m, Math.min(date, daysInMonth(y, m)));
    }
  }
}

const dayMonth = (day: string) => {
  const { month, date } = partsOf(day);
  return `${date} ${MONTHS[month - 1]}`;
};

/** "5 – 11 October 2026", "28 September – 4 October 2026", "28 December 2026 – 3 January 2027". */
function spanTitle(first: string, last: string): string {
  const a = partsOf(first);
  const b = partsOf(last);
  if (a.year !== b.year) return `${dayMonth(first)} ${a.year} – ${dayMonth(last)} ${b.year}`;
  if (a.month !== b.month) return `${dayMonth(first)} – ${dayMonth(last)} ${b.year}`;
  return `${a.date} – ${b.date} ${MONTHS[b.month - 1]} ${b.year}`;
}

/** How a view's range reads in the toolbar. */
export function rangeTitle(view: CalendarView, anchor: string, agendaDays: number): string {
  const { year, month } = partsOf(anchor);
  switch (view) {
    case 'day':
      return `${WEEKDAYS[weekday(anchor)]} ${dayMonth(anchor)} ${year}`;
    case 'month':
      return `${MONTHS[month - 1]} ${year}`;
    default: {
      const days = viewDays(view, anchor, agendaDays);
      return spanTitle(days[0] ?? anchor, days.at(-1) ?? anchor);
    }
  }
}

/**
 * Whether the days shown reach before or after what calendar sync keeps (30 days back, 12 months
 * ahead of today): those events live only in Google Calendar or Outlook.
 */
export function outsideSyncedWindow(
  days: readonly string[],
  today: string,
): { before: boolean; after: boolean } {
  const first = days[0] ?? today;
  const last = days.at(-1) ?? today;
  return {
    before: first < addDays(today, -SYNCED_DAYS_BACK),
    after: last >= addDays(today, SYNCED_DAYS_AHEAD),
  };
}
