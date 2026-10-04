import { clock, dayKey, zoneOffset } from './agenda';
import { localInstant } from './time-grid';

/*
  The second time zone (#127). Times show in the machine's zone; Settings → Calendar can add a second
  one, shown as a second column of hours beside the Day and Week grids and in the detail pane
  ("15:00 here · 10:00 New York"). An event set in a zone whose clocks differ from the User's says so
  in its detail.
*/

/** A zone's name as the User reads it: its city ("America/New_York" → "New York"). */
export function zoneName(timeZone: string): string {
  return (timeZone.split('/').at(-1) ?? timeZone).replaceAll('_', ' ');
}

/** Whether a name is a time zone this machine knows. */
export function isTimeZone(name: string): boolean {
  if (!name.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Every time zone this machine knows, for Settings → Calendar. */
export function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

// "(+1 day)" when the second zone is already on the next day, "(−1 day)" when still on the one before.
function dayShift(at: number, here: string, there: string): string {
  const a = dayKey(at, here);
  const b = dayKey(at, there);
  if (a === b) return '';
  return b > a ? ' (+1 day)' : ' (−1 day)';
}

/** "15:00 here · 10:00 New York": an instant in the User's zone and the second one. */
export function hereAndThere(at: number, timeZone: string, second: string): string {
  return `${clock(at, timeZone)} here · ${clock(at, second)} ${zoneName(second)}${dayShift(at, timeZone, second)}`;
}

/** The second zone's time at each of a local day's 24 wall-clock hours, for the grid's second column. */
export function secondZoneHours(day: string, timeZone: string, second: string): string[] {
  return Array.from({ length: 24 }, (_, hour) => clock(localInstant(day, hour * 60, timeZone), second));
}

/**
 * The note on an event set in another time zone, when that zone's clocks differ from the User's at
 * the time: "Set in New York time: 10:00–11:00 there". Null otherwise.
 */
export function eventZoneNote(
  event: { start: number; end: number; timeZone: string | null },
  timeZone: string,
): string | null {
  const own = event.timeZone;
  if (!own || own === timeZone || !isTimeZone(own)) return null;
  if (zoneOffset(event.start, own) === zoneOffset(event.start, timeZone)) return null;
  return `Set in ${zoneName(own)} time: ${clock(event.start, own)}–${clock(event.end, own)} there`;
}
