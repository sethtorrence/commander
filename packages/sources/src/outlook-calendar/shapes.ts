import {
  type CommanderEventKind,
  commanderEventKind,
  type EventAttendee,
  type EventCalendar,
  type EventDetail,
  type EventResponse,
  type EventTime,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import type { ListedCalendar } from '../google-calendar/shapes';
import { teamsText } from '../teams/html';
import { ianaZone, zonedInstant } from './time-zones';

// Microsoft Graph v1.0 calendar shapes, as far as Commander reads them, and their translation into
// `event` Items (the detail Google Calendar's events share). Fields Graph may leave out are optional
// here, so a sparse answer never breaks a sync.

const text = z.string().nullish();
const flag = z.boolean().nullish();
const emailAddress = z.object({ name: text, address: text }).nullish();

export const graphCalendar = z.object({
  id: z.string().min(1),
  name: text,
  // A preset ("lightBlue", or "auto" for Outlook's default) unless the User picked a colour (hexColor).
  color: text,
  hexColor: text,
  isDefaultCalendar: flag,
  canEdit: flag,
  owner: emailAddress,
});
export type GraphCalendar = z.infer<typeof graphCalendar>;

export const calendarsPage = z.object({
  value: z
    .array(graphCalendar)
    .nullish()
    .transform((value) => value ?? []),
  '@odata.nextLink': text,
});

const time = z
  .object({ dateTime: text, timeZone: text })
  .nullish()
  .transform((value) => value ?? {});

export const graphEvent = z.object({
  id: z.string().min(1),
  // A delta's mark for an event gone from the calendar view (deleted, moved away, out of the window).
  '@removed': z.object({ reason: text }).nullish(),
  type: text,
  subject: text,
  body: z.object({ contentType: text, content: text }).nullish(),
  start: time,
  end: time,
  originalStartTimeZone: text,
  originalEndTimeZone: text,
  isAllDay: flag,
  isCancelled: flag,
  isOrganizer: flag,
  showAs: text,
  sensitivity: text,
  seriesMasterId: text,
  // The event's iCalendar UID (each occurrence its own): what invitation emails name it by (#144).
  iCalUId: text,
  webLink: text,
  location: z.object({ displayName: text }).nullish(),
  organizer: z.object({ emailAddress }).nullish(),
  attendees: z
    .array(
      z.object({
        type: text,
        status: z.object({ response: text }).nullish(),
        emailAddress,
      }),
    )
    .nullish(),
  // The User's answer, and when they gave it (0001-01-01 when they haven't).
  responseStatus: z.object({ response: text, time: text }).nullish(),
  lastModifiedDateTime: text,
  onlineMeeting: z.object({ joinUrl: text }).nullish(),
  onlineMeetingUrl: text,
  // The id a client gave the event when it made it, so Graph ignores a retried POST. Commander's are
  // `<kind>:<Commander's id>`; Outlook's own apps set theirs too.
  transactionId: text,
  // Only when asked for with $expand, which calendarView and delta don't allow: writes' answers.
  singleValueExtendedProperties: z.array(z.object({ id: text, value: text })).nullish(),
});
export type GraphEvent = z.infer<typeof graphEvent>;

export const eventsPage = z.object({
  value: z
    .array(graphEvent)
    .nullish()
    .transform((value) => value ?? []),
  '@odata.nextLink': text,
  '@odata.deltaLink': text,
});

// Outlook's preset calendar colours, as Outlook on the web shows them; "auto" is Outlook's blue.
const PRESET_COLOURS: Record<string, string> = {
  auto: '#0078d4',
  lightBlue: '#4f9ee8',
  lightGreen: '#5fbe7d',
  lightOrange: '#f7a35c',
  lightGray: '#a0aeb2',
  lightYellow: '#e3d34f',
  lightTeal: '#4bcfc1',
  lightPink: '#ee7cb3',
  lightBrown: '#c39a6b',
  lightRed: '#ef6950',
  maxColor: '#0078d4',
};

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A calendar as the Account lists it. `me`: the User's address (the default calendar's owner). Calendars
 * the User owns and can edit count as owned (on by default); shared, holiday and birthday calendars,
 * which they can't edit or someone else owns, as subscribed (off by default).
 */
export function toListedCalendar(calendar: GraphCalendar, me: string | null): ListedCalendar {
  const hex = calendar.hexColor?.trim() ?? '';
  const colour = /^#[0-9a-f]{3,8}$/i.test(hex)
    ? hex.toLowerCase()
    : (PRESET_COLOURS[calendar.color?.trim() ?? ''] ?? PRESET_COLOURS.auto ?? '#0078d4');
  const primary = calendar.isDefaultCalendar === true;
  const canEdit = calendar.canEdit === true;
  const owned = canEdit && (primary || same(calendar.owner?.address, me));
  return {
    id: calendar.id,
    name: calendar.name?.trim() || 'Calendar',
    colour,
    primary,
    accessRole: owned ? 'owner' : canEdit ? 'writer' : 'reader',
  };
}

const isWebLink = (url: string | null | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url.trim());
const isAddress = (address: string | null | undefined): address is string => !!address?.trim().includes('@');

const RESPONSES: Record<string, EventResponse> = {
  accepted: 'accepted',
  organizer: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
  none: 'needs-action',
  notResponded: 'needs-action',
};
export const responseOf = (value: string | null | undefined): EventResponse =>
  RESPONSES[value ?? ''] ?? 'needs-action';

function toTime(
  value: { dateTime?: string | null; timeZone?: string | null },
  allDay: boolean,
  zone: string | null,
): EventTime {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value.dateTime?.trim() ?? '')?.[0];
  // All-day events float: Graph writes their days at midnight, whatever zone it names.
  if (allDay && day) return { at: Date.parse(`${day}T00:00:00Z`), timeZone: null, date: day };
  const at = zonedInstant(value.dateTime, value.timeZone);
  return {
    at: Number.isFinite(at) ? Math.max(0, at) : 0,
    timeZone: ianaZone(zone) ?? (ianaZone(value.timeZone) === 'UTC' ? null : ianaZone(value.timeZone)),
    date: null,
  };
}

function descriptionText(body: GraphEvent['body']): string | null {
  const content = body?.content ?? '';
  if (!content.trim()) return null;
  const plain =
    body?.contentType?.toLowerCase() === 'html'
      ? teamsText(content, 'html')
      : content.replace(/\r\n?/g, '\n').trim();
  return plain || null;
}

function meetingUrl(event: GraphEvent): string | null {
  if (isWebLink(event.onlineMeeting?.joinUrl)) return event.onlineMeeting.joinUrl.trim();
  return isWebLink(event.onlineMeetingUrl) ? event.onlineMeetingUrl.trim() : null;
}

// Commander's marker on the events it makes: a named string property in the PS_PUBLIC_STRINGS set,
// valued `<kind>:<Commander's id>`. Graph can find events by it, though sync can't read it.
export const COMMANDER_EVENT_PROPERTY = 'String {00020329-0000-0000-C000-000000000046} Name CommanderEvent';

// `<kind>:<Commander's id>`, the transactionId and marker of an event Commander made.
export const commanderEventTag = (kind: CommanderEventKind, commanderId: string) => `${kind}:${commanderId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readTag(tag: string | null | undefined): { kind: CommanderEventKind; commanderId: string } | null {
  const [kind, commanderId, ...rest] = (tag ?? '').trim().split(':');
  const known = commanderEventKind.safeParse(kind);
  if (!known.success || !commanderId || rest.length || !UUID.test(commanderId)) return null;
  return { kind: known.data, commanderId };
}

/**
 * Which of Commander's events this is, if it made it: by its transactionId (which every answer
 * carries), or by Commander's marker when an answer includes extended properties.
 */
export function commanderEventOf(
  event: GraphEvent,
): { kind: CommanderEventKind; commanderId: string } | null {
  const marker = (event.singleValueExtendedProperties ?? []).find(
    (each) => each.id?.trim().toLowerCase() === COMMANDER_EVENT_PROPERTY.toLowerCase(),
  );
  return readTag(event.transactionId) ?? readTag(marker?.value);
}

const wallClocks = new Map<string, Intl.DateTimeFormat>();

// An instant as a wall clock in a zone, written as Graph writes times: 2026-10-06T09:00:00.0000000.
function wallClock(at: number, zone: string): string {
  let format = wallClocks.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallClocks.set(zone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.0000000`;
}

/**
 * One end of an event as Graph takes it: the wall clock in the event's own zone (UTC when it has none,
 * or one Graph mightn't know); an all-day event's day at midnight, in UTC, as Outlook writes them.
 */
export function graphTime(time: EventTime, allDay: boolean): { dateTime: string; timeZone: string } {
  if (allDay) {
    const day = time.date ?? new Date(time.at).toISOString().slice(0, 10);
    return { dateTime: `${day}T00:00:00.0000000`, timeZone: 'UTC' };
  }
  const zone = ianaZone(time.timeZone) ?? 'UTC';
  return { dateTime: wallClock(time.at, zone), timeZone: zone };
}

// Whether an answer from Graph says the event no longer happens for the User.
export const isGone = (event: GraphEvent) => !!event['@removed'] || event.isCancelled === true;

/**
 * An event (an instance, for a recurring one: calendarView expands series) as an Item. Its Item id at
 * the Source is Graph's immutable id, which stays the same when the event moves to another calendar.
 * `accountEmail`: the User's address in the Account.
 */
export function toEventItem(
  event: GraphEvent,
  calendar: EventCalendar,
  accountEmail: string | null,
): SourceItem {
  const organiserAddress = event.organizer?.emailAddress?.address?.trim() || null;
  const attendees: EventAttendee[] = (event.attendees ?? []).flatMap((each) => {
    const email = each.emailAddress?.address?.trim();
    if (!email) return [];
    return [
      {
        email,
        name: each.emailAddress?.name?.trim() || null,
        self: same(email, accountEmail),
        response: responseOf(each.status?.response),
        organiser: same(email, organiserAddress),
        optional: each.type === 'optional',
        resource: each.type === 'resource',
      },
    ];
  });
  const organiser = organiserAddress
    ? {
        email: organiserAddress,
        name: event.organizer?.emailAddress?.name?.trim() || null,
        self: event.isOrganizer === true,
      }
    : null;
  // The User's own answer: going to what they organise with guests; otherwise theirs as invited
  // (named among the guests, or through a group, when Graph has an answer other than none).
  const status = event.responseStatus?.response?.trim() || 'none';
  const invited = attendees.some((each) => each.self) || status !== 'none';
  let myResponse: EventResponse | null = null;
  if (event.isOrganizer === true) myResponse = attendees.some((each) => !each.self) ? 'accepted' : null;
  else if (invited) myResponse = responseOf(status);
  const allDay = event.isAllDay === true;
  const commander = commanderEventOf(event);
  const start = toTime(event.start, allDay, event.originalStartTimeZone ?? null);
  const end = toTime(event.end, allDay, event.originalEndTimeZone ?? event.originalStartTimeZone ?? null);
  const detail: EventDetail = {
    kind: 'event',
    calendar,
    accountEmail,
    start,
    end: end.at >= start.at ? end : start,
    allDay,
    location: event.location?.displayName?.trim() || null,
    description: descriptionText(event.body),
    organiser,
    attendees,
    myResponse,
    meetingUrl: meetingUrl(event),
    // Free and working elsewhere leave the time open; busy, tentative and away block it.
    busy: event.showAs !== 'free' && event.showAs !== 'workingElsewhere',
    private: event.sensitivity === 'private' || event.sensitivity === 'confidential',
    seriesId: event.seriesMasterId?.trim() || null,
    webUrl: isWebLink(event.webLink) ? event.webLink.trim() : null,
    // Commander's own events (focus blocks and busy copies), known by their transactionId.
    createdByCommander: commander?.kind ?? null,
    ...(event.iCalUId?.trim() ? { icalUid: event.iCalUId.trim() } : {}),
  };
  const people = new Set<string>();
  if (isAddress(organiserAddress)) people.add(organiserAddress.toLowerCase());
  for (const each of attendees)
    if (!each.resource && isAddress(each.email)) people.add(each.email.toLowerCase());
  return {
    externalId: event.id,
    kind: 'event',
    title: event.subject?.trim() || '(No title)',
    people: [...people],
    status: 'open',
    detail,
    // Names the Item Commander made for it, which may still hold a placeholder external id.
    ...(commander && { commanderItemId: commander.commanderId }),
  };
}
