import {
  type CommanderEventKind,
  commanderEventKinds,
  type EventAttendee,
  type EventCalendar,
  type EventDetail,
  type EventResponse,
  type EventTime,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import { teamsText } from '../teams/html';

// Google Calendar API v3 shapes, as far as Commander reads them, and their translation into `event`
// Items. Fields Google may leave out are optional here, so a sparse answer never breaks a sync.

const text = z.string().nullish();
const flag = z.boolean().nullish();

export const calendarListEntry = z.object({
  id: z.string().min(1),
  summary: text,
  // The name the User gave a calendar someone else owns.
  summaryOverride: text,
  backgroundColor: text,
  accessRole: z.string(),
  primary: flag,
  deleted: flag,
});
export type CalendarListEntry = z.infer<typeof calendarListEntry>;

export const calendarListPage = z.object({
  items: z.array(calendarListEntry).nullish(),
  nextPageToken: text,
});

const time = z
  .object({ dateTime: text, date: text, timeZone: text })
  .nullish()
  .transform((value) => value ?? {});

const person = z.object({ email: text, displayName: text, self: flag }).nullish();

export const googleEvent = z.object({
  id: z.string().min(1),
  status: text,
  htmlLink: text,
  summary: text,
  description: text,
  location: text,
  organizer: person,
  start: time,
  end: time,
  recurringEventId: text,
  transparency: text,
  visibility: text,
  attendees: z
    .array(
      z.object({
        email: text,
        displayName: text,
        self: flag,
        organizer: flag,
        optional: flag,
        resource: flag,
        responseStatus: text,
      }),
    )
    .nullish(),
  hangoutLink: text,
  conferenceData: z
    .object({ entryPoints: z.array(z.object({ entryPointType: text, uri: text })).nullish() })
    .nullish(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).nullish() }).nullish(),
});
export type GoogleEvent = z.infer<typeof googleEvent>;

export const eventsPage = z.object({
  items: z.array(googleEvent).nullish(),
  // The calendar's own time zone, for events that don't name one.
  timeZone: text,
  nextPageToken: text,
  nextSyncToken: text,
});
export type EventsPage = z.infer<typeof eventsPage>;

// A calendar as the Account lists it, for the Item store's list of calendars.
export type ListedCalendar = {
  id: string;
  name: string;
  colour: string;
  primary: boolean;
  accessRole: string;
};

// Google's default calendar colour, for a calendar listed without one.
const DEFAULT_COLOUR = '#4285f4';

export function toListedCalendar(entry: CalendarListEntry): ListedCalendar {
  const colour = entry.backgroundColor?.trim() ?? '';
  return {
    id: entry.id,
    name: entry.summaryOverride?.trim() || entry.summary?.trim() || entry.id,
    colour: /^#[0-9a-f]{3,8}$/i.test(colour) ? colour.toLowerCase() : DEFAULT_COLOUR,
    primary: entry.primary === true,
    accessRole: entry.accessRole,
  };
}

// An event's Item id at its Source: event ids are unique only within a calendar, and one event can
// sit on several of an Account's calendars (each shown, as Google Calendar does).
export const eventExternalId = (calendarId: string, eventId: string) => `${calendarId}/${eventId}`;

const isWebLink = (url: string | null | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url.trim());

const RESPONSES: Record<string, EventResponse> = {
  accepted: 'accepted',
  tentative: 'tentative',
  declined: 'declined',
  needsAction: 'needs-action',
};

function toTime(
  value: { dateTime?: string | null; date?: string | null; timeZone?: string | null },
  zone: string | null,
): EventTime {
  if (value.date && !value.dateTime) {
    return { at: Date.parse(`${value.date}T00:00:00Z`), timeZone: null, date: value.date };
  }
  const at = value.dateTime ? Date.parse(value.dateTime) : Number.NaN;
  return {
    at: Number.isFinite(at) ? Math.max(0, at) : 0,
    timeZone: value.timeZone?.trim() || zone,
    date: null,
  };
}

// Descriptions are HTML when written in Google Calendar, plain text when an app wrote them.
const looksLikeHtml = (value: string) => /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(value);

export function descriptionText(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const plain = looksLikeHtml(raw) ? teamsText(raw, 'html') : raw.replace(/\r\n?/g, '\n').trim();
  return plain || null;
}

function meetingUrl(event: GoogleEvent): string | null {
  if (isWebLink(event.hangoutLink)) return event.hangoutLink.trim();
  const video = event.conferenceData?.entryPoints?.find((each) => each.entryPointType === 'video');
  return isWebLink(video?.uri) ? video.uri.trim() : null;
}

function commanderKind(event: GoogleEvent): CommanderEventKind | null {
  const marked = event.extendedProperties?.private?.commander;
  return (commanderEventKinds as readonly string[]).includes(marked ?? '')
    ? (marked as CommanderEventKind)
    : null;
}

/**
 * An event (an instance, for a recurring one) as an Item. `zone`: the calendar's time zone, for
 * times that don't name one; `accountEmail`: the Account's address.
 */
export function toEventItem(
  event: GoogleEvent,
  calendar: EventCalendar,
  zone: string | null,
  accountEmail: string | null,
): SourceItem {
  const attendees: EventAttendee[] = (event.attendees ?? []).flatMap((each) =>
    each.email?.trim()
      ? [
          {
            email: each.email.trim(),
            name: each.displayName?.trim() || null,
            self: each.self === true,
            response: RESPONSES[each.responseStatus ?? ''] ?? 'needs-action',
            organiser: each.organizer === true,
            optional: each.optional === true,
            resource: each.resource === true,
          },
        ]
      : [],
  );
  const organizer = event.organizer?.email?.trim()
    ? {
        email: event.organizer.email.trim(),
        name: event.organizer.displayName?.trim() || null,
        self: event.organizer.self === true,
      }
    : null;
  const start = toTime(event.start, zone);
  const end = toTime(event.end, zone);
  const detail: EventDetail = {
    kind: 'event',
    calendar,
    accountEmail,
    start,
    // An event without an end (Google allows it for some imports) lasts no time.
    end: end.at >= start.at ? end : start,
    allDay: start.date !== null,
    location: event.location?.trim() || null,
    description: descriptionText(event.description),
    organiser: organizer,
    attendees,
    myResponse: attendees.find((each) => each.self)?.response ?? null,
    meetingUrl: meetingUrl(event),
    busy: event.transparency !== 'transparent',
    private: event.visibility === 'private' || event.visibility === 'confidential',
    seriesId: event.recurringEventId?.trim() || null,
    webUrl: isWebLink(event.htmlLink) ? event.htmlLink.trim() : null,
    createdByCommander: commanderKind(event),
  };
  const people = new Set<string>();
  if (organizer) people.add(organizer.email.toLowerCase());
  for (const each of attendees) if (!each.resource) people.add(each.email.toLowerCase());
  return {
    externalId: eventExternalId(calendar.id, event.id),
    kind: 'event',
    title: event.summary?.trim() || '(No title)',
    people: [...people],
    status: 'open',
    detail,
  };
}
