import type { EmailInvitation } from '@commander/domain';
import { zonedInstant } from '../outlook-calendar/time-zones';

// The calendar invitation in a Gmail message's text/calendar part (#144, RFC 5545), as far as finding
// its event needs: the calendar's METHOD and the first event's UID, SUMMARY and times. Lines are
// unfolded and text values unescaped; a time in a named zone (IANA, or a Windows name as Outlook writes
// it) is read in that zone, one ending in Z as UTC, a date alone as an all-day event. What it can't
// read is left null, never guessed. Source content, untrusted: kept as data only (ADR 0004).

const MAX_LINES = 5_000;

type Property = { name: string; params: Record<string, string>; value: string };

// Joins folded lines (a line starting with a space or tab continues the one before).
function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .slice(0, MAX_LINES);
}

// `NAME;PARAM=value;PARAM="quoted":value`
function propertyOf(line: string): Property | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const [name = '', ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const equals = param.indexOf('=');
    if (equals > 0)
      params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/^"(.*)"$/, '$1');
  }
  return { name: name.trim().toUpperCase(), params, value: line.slice(colon + 1) };
}

// A TEXT value's escapes undone (\n, \, \; \\).
const unescapeText = (value: string) =>
  value.replace(/\\([nN,;\\])/g, (_whole, char: string) => (char === 'n' || char === 'N' ? '\n' : char));

const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i;

// A DTSTART or DTEND as an instant, with whether it is a date alone; null when it can't be read.
function timeOf(property: Property | undefined): { at: number; date: boolean } | null {
  if (!property) return null;
  const value = property.value.trim();
  const day = DATE.exec(value);
  if (day || property.params.VALUE?.toUpperCase() === 'DATE') {
    if (!day) return null;
    const at = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isNaN(at) ? null : { at, date: true };
  }
  const time = DATE_TIME.exec(value);
  if (!time) return null;
  const [, y, mo, d, h, mi, s = '00', utc] = time;
  const wall = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const at = utc ? Date.parse(`${wall}Z`) : zonedInstant(wall, property.params.TZID ?? null);
  return Number.isFinite(at) && at >= 0 ? { at, date: false } : null;
}

// "PT30M", "P1D", "PT1H30M": a DURATION in ms, or null.
function durationOf(value: string | undefined): number | null {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value?.trim() ?? '');
  if (!match) return null;
  const [, weeks, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
  return (
    ((((weeks ?? 0) * 7 + (days ?? 0)) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60_000 +
    (seconds ?? 0) * 1000
  );
}

/** The invitation an iCalendar text describes; null when it holds no event. */
export function parseInvitation(text: string): EmailInvitation | null {
  let method: string | null = null;
  let depth = 0;
  let event: Property[] | null = null;
  for (const line of unfold(text)) {
    const property = propertyOf(line);
    if (!property) continue;
    if (property.name === 'BEGIN') {
      depth += 1;
      if (property.value.trim().toUpperCase() === 'VEVENT' && event === null) event = [];
      continue;
    }
    if (property.name === 'END') {
      depth -= 1;
      if (property.value.trim().toUpperCase() === 'VEVENT' && event) break;
      continue;
    }
    if (event) event.push(property);
    else if (depth === 1 && property.name === 'METHOD') method = property.value.trim().toLowerCase();
  }
  if (!event) return null;
  const find = (name: string) => event?.find((each) => each.name === name);
  const start = timeOf(find('DTSTART'));
  const endTime = timeOf(find('DTEND'));
  const duration = durationOf(find('DURATION')?.value);
  const end =
    endTime?.at ??
    (start && duration !== null ? start.at + duration : start?.date ? start.at + 86_400_000 : null);
  const title = find('SUMMARY')?.value;
  const uid = find('UID')?.value.trim();
  return {
    method: method || 'request',
    uid: uid || null,
    eventId: null,
    title: title ? unescapeText(title).trim() || null : null,
    start: start?.at ?? null,
    end: end ?? null,
    allDay: start?.date ?? false,
  };
}
