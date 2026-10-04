import { z } from 'zod';
import type { EventDetail } from './calendar';

/*
  Focus time (#131): when the User is free, worked out in code across every Account and calendar
  (Microsoft's free-time API doesn't take personal accounts, decision #3), and the settings behind it
  (Settings → Calendar). Pure: the time zone and the clock are always given.

  Busy: every live event the User hasn't declined and that holds the time (busy, not free), focus blocks
  included; Commander's busy copies are left out, as the events they copy are already counted. Free: the
  rest of the working hours (09:00–18:00 Monday to Friday unless the User changes them), in the
  machine's time zone.
*/

const id = z.string().min(1);
const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

// ---------------------------------------------------------------------------------------------
// Settings

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 09:00');

// The days (0 Sunday … 6 Saturday) and the hours the User works, in the machine's time zone.
export const workingHours = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).max(7),
    start: clock,
    end: clock,
  })
  .refine((hours) => hours.start < hours.end, { message: 'Working hours end after they start' })
  .transform((hours) => ({ ...hours, days: [...new Set(hours.days)].sort((a, b) => a - b) }));
export type WorkingHours = z.infer<typeof workingHours>;

export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

// One pair of Block time across Accounts: busy events in `from` put a Busy copy on `to`'s main calendar.
export const blockPair = z
  .object({ from: id, to: id, on: z.boolean() })
  .refine((pair) => pair.from !== pair.to, { message: 'An Account can’t block time on itself' });
export type BlockPair = z.infer<typeof blockPair>;

export const focusSettings = z.object({
  workingHours: workingHours.default(DEFAULT_WORKING_HOURS),
  // The Account whose Commander calendar focus blocks go in; null until the User chooses.
  focusAccount: id.nullable().default(null),
  // Block time across Accounts: off (no pairs) by default.
  blockPairs: z
    .array(blockPair)
    .max(20)
    .default([])
    .refine((pairs) => new Set(pairs.map((pair) => `${pair.from}\u0000${pair.to}`)).size === pairs.length, {
      message: 'Each pair once',
    }),
});
export type FocusSettings = z.infer<typeof focusSettings>;
export type FocusSettingsInput = z.input<typeof focusSettings>;
export const defaultFocusSettings = (): FocusSettings => focusSettings.parse({});

// ---------------------------------------------------------------------------------------------
// Time zones, without a library: Intl knows every zone's offsets.

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

// The wall clock in a zone at an instant.
function wallClock(at: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// How far ahead of UTC a zone's clocks are at an instant, in ms.
function offsetAt(at: number, timeZone: string): number {
  const wall = wallClock(at, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time (HH:MM) on a day (YYYY-MM-DD) happens in an IANA zone. */
export function zonedTime(day: string, time: string, timeZone: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(year, month - 1, date, hour, minute);
  // Guess with the offset at that reading taken as UTC, then once more with the offset at the guess,
  // which settles it either side of a change of the clocks.
  const guess = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(guess, timeZone);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The day (YYYY-MM-DD) an instant falls on in a zone. */
export function dayInZone(at: number, timeZone: string): string {
  const wall = wallClock(at, timeZone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** The wall-clock time (HH:MM) of an instant in a zone. */
export function timeInZone(at: number, timeZone: string): string {
  const wall = wallClock(at, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** The day after `day`, or `count` days on. */
export function addDays(day: string, count = 1): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date) + count * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday of a day: 0 Sunday … 6 Saturday. */
export const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

// ---------------------------------------------------------------------------------------------
// Free time

export type TimeSlot = { start: number; end: number };

// What free time reads of an event: its Item id and Account, and its detail.
export type FreeTimeEvent = { id: string; account: string | null; detail: EventDetail };

/** Whether an event holds the User's time: busy, not declined, and not one of Commander's busy copies. */
export function holdsTime(detail: EventDetail): boolean {
  return detail.busy && detail.myResponse !== 'declined' && detail.createdByCommander !== 'busy-block';
}

// When an event holds the time: an all-day one from midnight to midnight of its days in the zone.
function spanOf(detail: EventDetail, timeZone: string): TimeSlot {
  if (detail.allDay && detail.start.date && detail.end.date) {
    return {
      start: zonedTime(detail.start.date, '00:00', timeZone),
      end: zonedTime(detail.end.date, '00:00', timeZone),
    };
  }
  return { start: detail.start.at, end: detail.end.at };
}

// The slots in order, those touching or overlapping joined.
function merged(slots: TimeSlot[]): TimeSlot[] {
  const sorted = slots.filter((each) => each.end > each.start).sort((a, b) => a.start - b.start);
  const out: TimeSlot[] = [];
  for (const each of sorted) {
    const last = out.at(-1);
    if (last && each.start <= last.end) last.end = Math.max(last.end, each.end);
    else out.push({ ...each });
  }
  return out;
}

/** Each working day's working hours between two instants, in order. */
export function workingWindows({
  from,
  to,
  workingHours: hours,
  timeZone,
}: {
  from: number;
  to: number;
  workingHours: WorkingHours;
  timeZone: string;
}): TimeSlot[] {
  const windows: TimeSlot[] = [];
  const last = dayInZone(to, timeZone);
  for (
    let day = dayInZone(from, timeZone), guard = 0;
    day <= last && guard < 400;
    day = addDays(day), guard++
  ) {
    if (!hours.days.includes(weekdayOf(day))) continue;
    const start = Math.max(from, zonedTime(day, hours.start, timeZone));
    const end = Math.min(to, zonedTime(day, hours.end, timeZone));
    if (end > start) windows.push({ start, end });
  }
  return windows;
}

export type FreeSlotsRequest = {
  events: readonly FreeTimeEvent[];
  // More busy times, treated like events (suggestions waiting, say).
  busy?: readonly TimeSlot[];
  from: number;
  to: number;
  workingHours: WorkingHours;
  timeZone: string;
  // The shortest slot worth offering.
  minMinutes: number;
  // Slots start on these boundaries (a quarter hour by default), so "now" doesn't start one at 10:07.
  alignMinutes?: number;
};

/** The User's free time between two instants: working hours less what holds the time, in order. */
export function freeSlots(request: FreeSlotsRequest): TimeSlot[] {
  const align = (request.alignMinutes ?? 15) * MINUTE;
  const from = Math.ceil(request.from / align) * align;
  const busy = merged([
    ...request.events
      .filter((event) => holdsTime(event.detail))
      .map((e) => spanOf(e.detail, request.timeZone)),
    ...(request.busy ?? []),
  ]);
  const free: TimeSlot[] = [];
  for (const window of workingWindows({ ...request, from })) {
    let cursor = window.start;
    for (const each of busy) {
      if (each.end <= cursor || each.start >= window.end) continue;
      if (each.start > cursor) free.push({ start: cursor, end: each.start });
      cursor = Math.max(cursor, each.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) free.push({ start: cursor, end: window.end });
  }
  return free.filter((each) => each.end - each.start >= request.minMinutes * MINUTE);
}

/**
 * The next `count` working days from `now` (today too, while its working hours aren't over), and the
 * range from now to the end of the last of them.
 */
export function nextWorkingDays(
  now: number,
  count: number,
  hours: WorkingHours,
  timeZone: string,
): { from: number; to: number; days: string[] } {
  const days: string[] = [];
  let day = dayInZone(now, timeZone);
  for (let guard = 0; days.length < count && guard < 400 && hours.days.length; guard++, day = addDays(day)) {
    if (!hours.days.includes(weekdayOf(day))) continue;
    if (zonedTime(day, hours.end, timeZone) <= now) continue;
    days.push(day);
  }
  const last = days.at(-1);
  return { from: now, to: last ? zonedTime(addDays(last), '00:00', timeZone) : now, days };
}

/** Whether `day` (in the zone) is a working day. */
export const isWorkingDay = (at: number, hours: WorkingHours, timeZone: string) =>
  hours.days.includes(weekdayOf(dayInZone(at, timeZone)));

// ---------------------------------------------------------------------------------------------
// Checking Ares's focus blocks

export type FocusBlockCheck<T extends TimeSlot> = { kept: T[]; dropped: { block: T; why: string }[] };

/**
 * Keeps the focus blocks that sit wholly inside one free slot, last at least `minMinutes`, and overlap
 * none kept before them; the rest are dropped, each with why.
 */
export function checkFocusBlocks<T extends TimeSlot>(
  blocks: readonly T[],
  free: readonly TimeSlot[],
  { minMinutes = 15 }: { minMinutes?: number } = {},
): FocusBlockCheck<T> {
  const kept: T[] = [];
  const dropped: { block: T; why: string }[] = [];
  for (const block of blocks) {
    let why: string | null = null;
    if (!(block.end > block.start)) why = 'ends before it starts';
    else if (block.end - block.start < minMinutes * MINUTE) why = `shorter than ${minMinutes} minutes`;
    else if (!free.some((each) => block.start >= each.start && block.end <= each.end))
      why = 'outside your free time';
    else if (kept.some((each) => block.start < each.end && each.start < block.end))
      why = 'overlaps another focus block';
    if (why) dropped.push({ block, why });
    else kept.push(block);
  }
  return { kept, dropped };
}
