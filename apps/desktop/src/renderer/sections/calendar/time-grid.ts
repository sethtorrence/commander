import {
  type AgendaEntry,
  addDays,
  type CalendarEvent,
  dayKey,
  dayStart,
  daysOf,
  entryFor,
  inDayOrder,
  zoneOffset,
} from './agenda';

/*
  The layout of the Day and Week time grids and the Month grid (#127), kept free of React and of the
  machine's clock and time zone (both are passed in), so it can be tested in any zone.

  - The time grid runs on the wall clock: 24 hour rows every day, whatever the clocks do. An event
    sits from its local start to its local end, so on the day the clocks go forward a 09:00 meeting
    is still at 09:00. An event that crosses midnight is split between the two days.
  - Overlapping events sit side by side: each cluster of events that overlap (directly or through one
    another) is split into as many columns as it needs, and each event takes the first free one.
  - All-day events, and timed ones lasting a day or more, go in the strip above the grid as bars
    across their days, stacked in lanes where they overlap.
*/

export const MINUTES_IN_DAY = 24 * 60;
// The least height a block gets, in minutes, so a short event still has room for its title.
export const SHORTEST_BLOCK = 20;
const DAY_MS = 24 * 60 * 60_000;

const minuteFormats = new Map<string, Intl.DateTimeFormat>();

/** The minutes since midnight on the wall clock of a time zone, at an instant. */
export function wallMinutes(at: number, timeZone: string): number {
  let format = minuteFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    minuteFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  return part('hour') * 60 + part('minute');
}

/** The instant a local day and wall-clock time (minutes since midnight) fall on in a time zone. */
export function localInstant(day: string, minutes: number, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const asUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + minutes * 60_000;
  // The offset at the UTC reading, then again at the guess, which settles a daylight-saving change.
  const guess = asUtc - zoneOffset(asUtc, timeZone);
  return asUtc - zoneOffset(guess, timeZone);
}

/** Whether an event goes in the all-day strip: an all-day event, or a timed one of a day or more. */
export const inAllDayStrip = (event: CalendarEvent) =>
  event.detail.allDay || event.detail.end.at - event.detail.start.at >= DAY_MS;

export type GridBlock = {
  event: CalendarEvent;
  day: string;
  // Minutes from midnight, on the wall clock; `bottom` is at least SHORTEST_BLOCK below `top`.
  top: number;
  bottom: number;
  // Which of its cluster's columns it is in, of how many.
  column: number;
  columns: number;
  // It started before this day, or ends after it.
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/** The blocks of a day's timed events in the time grid, earliest first, laid out side by side. */
export function dayBlocks(
  events: readonly CalendarEvent[],
  day: string,
  timeZone: string,
  shortest = SHORTEST_BLOCK,
): GridBlock[] {
  const from = dayStart(day, timeZone);
  const to = dayStart(addDays(day, 1), timeZone);
  const blocks: GridBlock[] = [];
  for (const event of events) {
    if (inAllDayStrip(event)) continue;
    const start = event.detail.start.at;
    const end = Math.max(event.detail.end.at, start);
    // An event that takes no time still counts at its start.
    const touches = start < to && (end > from || (end === start && start >= from));
    if (!touches) continue;
    const continuesBefore = start < from;
    const continuesAfter = end > to;
    const top = continuesBefore ? 0 : wallMinutes(start, timeZone);
    let bottom = end >= to ? MINUTES_IN_DAY : wallMinutes(end, timeZone);
    // The clocks went back in between: go by the time it takes.
    if (bottom <= top) bottom = top + (Math.min(end, to) - Math.max(start, from)) / 60_000;
    bottom = Math.min(MINUTES_IN_DAY, Math.max(bottom, top + shortest));
    blocks.push({ event, day, top, bottom, column: 0, columns: 1, continuesBefore, continuesAfter });
  }
  blocks.sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.event.title.localeCompare(b.event.title));

  // Clusters of blocks that overlap, each split into the columns it needs.
  let cluster: GridBlock[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const block of cluster) block.columns = columnEnds.length;
    cluster = [];
    columnEnds = [];
  };
  for (const block of blocks) {
    if (block.top >= clusterEnd) close();
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= block.top);
    if (column < 0) column = columnEnds.length;
    columnEnds[column] = block.bottom;
    block.column = column;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.bottom);
  }
  close();
  return blocks;
}

export type StripBar = {
  event: CalendarEvent;
  // The first day's column among the days shown, and how many days it spans there.
  first: number;
  span: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

const daysApart = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** The all-day strip over these (consecutive) days: a bar for each event, stacked in lanes. */
export function stripBars(
  events: readonly CalendarEvent[],
  days: readonly string[],
  timeZone: string,
): StripBar[] {
  const firstDay = days[0];
  const lastDay = days.at(-1);
  if (!firstDay || !lastDay) return [];
  const bars: StripBar[] = [];
  for (const event of events) {
    if (!inAllDayStrip(event)) continue;
    const own = daysOf(event, timeZone);
    const start = own[0] ?? firstDay;
    const end = own.at(-1) ?? start;
    if (end < firstDay || start > lastDay) continue;
    const first = Math.max(0, daysApart(firstDay, start));
    const last = Math.min(days.length - 1, daysApart(firstDay, end));
    bars.push({
      event,
      first,
      span: last - first + 1,
      lane: 0,
      continuesBefore: start < firstDay,
      continuesAfter: end > lastDay,
    });
  }
  bars.sort((a, b) => a.first - b.first || b.span - a.span || a.event.title.localeCompare(b.event.title));
  const laneEnds: number[] = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex((end) => end < bar.first);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = bar.first + bar.span - 1;
    bar.lane = lane;
  }
  return bars;
}

/** Where the "now" line goes: today's column among the days shown and the wall-clock minute, or null. */
export function nowLine(
  now: number,
  days: readonly string[],
  timeZone: string,
): { column: number; minutes: number } | null {
  const column = days.indexOf(dayKey(now, timeZone));
  return column < 0 ? null : { column, minutes: wallMinutes(now, timeZone) };
}

export type MonthCell = { day: string; entries: AgendaEntry[]; shown: AgendaEntry[]; more: number };

/** Each day's events for the Month grid, in Agenda order: the first `most`, and how many more. */
export function monthCells(
  events: readonly CalendarEvent[],
  days: readonly string[],
  timeZone: string,
  most: number,
): MonthCell[] {
  const wanted = new Set(days);
  const byDay = new Map<string, AgendaEntry[]>();
  for (const event of events) {
    for (const day of daysOf(event, timeZone)) {
      if (!wanted.has(day)) continue;
      const list = byDay.get(day) ?? [];
      list.push(entryFor(event, day, timeZone));
      byDay.set(day, list);
    }
  }
  return days.map((day) => {
    const entries = (byDay.get(day) ?? []).sort(inDayOrder);
    return { day, entries, shown: entries.slice(0, most), more: Math.max(0, entries.length - most) };
  });
}
