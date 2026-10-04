import { z } from 'zod';
import type { Item, Source } from './items';
import type { RuleField, RuleFieldValue } from './rules';

// The `event` kind detail: what calendar sync keeps of each event, shared by Google Calendar and
// Outlook Calendar. Recurring events arrive as their instances, each its own Item, naming the
// series it belongs to. The description is plain text converted from the Source's HTML: untrusted
// Source content, kept as data only and shown through the window's safe text rendering. People are
// the organiser's and attendees' addresses. A cancelled event becomes a tombstone.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// The Sources whose Items are events: each Account's calendars come from one of them.
export const calendarSources = ['google-calendar', 'outlook-calendar'] as const;
export type CalendarSource = (typeof calendarSources)[number];

// How someone answered an invitation (Google's `needsAction` is `needs-action`).
export const eventResponses = ['accepted', 'tentative', 'declined', 'needs-action'] as const;
export const eventResponse = z.enum(eventResponses);
export type EventResponse = z.infer<typeof eventResponse>;

// One end of an event: the instant (epoch ms) and the time zone the Source gave it, or, for an
// all-day event, its calendar day (the end day is exclusive, as calendars write it) and `at` that
// day's midnight in UTC.
export const eventTime = z.object({
  at: timestamp,
  timeZone: z.string().nullable(),
  date: z.iso.date().nullable(),
});
export type EventTime = z.infer<typeof eventTime>;

export const eventPerson = z.object({
  email: z.string().min(1),
  name: z.string().nullable(),
  // The User themself.
  self: z.boolean(),
});
export type EventPerson = z.infer<typeof eventPerson>;

export const eventAttendee = eventPerson.extend({
  response: eventResponse,
  organiser: z.boolean(),
  optional: z.boolean(),
  // A room or other resource rather than a person.
  resource: z.boolean(),
});
export type EventAttendee = z.infer<typeof eventAttendee>;

// Events Commander itself put in a calendar (later tickets): focus blocks and mirrored busy blocks.
export const commanderEventKinds = ['focus-block', 'busy-block'] as const;
export const commanderEventKind = z.enum(commanderEventKinds);
export type CommanderEventKind = z.infer<typeof commanderEventKind>;

// The calendar an event is on, as its Account lists it.
export const eventCalendar = z.object({
  id,
  name: z.string(),
  // A CSS hex colour, like #33b679.
  colour: z.string(),
});
export type EventCalendar = z.infer<typeof eventCalendar>;

export const eventDetail = z.object({
  kind: z.literal('event'),
  calendar: eventCalendar,
  // The address of the Account the event came through (its primary calendar), when known: who the
  // User is in it, and which account Google Calendar or Outlook on the web opens for "Edit".
  accountEmail: z.string().nullable(),
  start: eventTime,
  end: eventTime,
  allDay: z.boolean(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  organiser: eventPerson.nullable(),
  attendees: z.array(eventAttendee),
  // The User's own answer, when they are invited; null for events they aren't an attendee of.
  myResponse: eventResponse.nullable(),
  // For an instance of a series: the User's answer to the whole series, as far as Commander knows it.
  // Absent means the same as the instance's own (as calendar sync saves it); set when the User answers
  // in Commander, so answering one instance and answering the series are separate synced fields (#129).
  seriesResponse: eventResponse.optional(),
  // The online meeting's join link (Google Meet, Zoom…), when it has one.
  meetingUrl: z.string().nullable(),
  // Busy (opaque) or free (transparent).
  busy: z.boolean(),
  private: z.boolean(),
  // The recurring series it is an instance of; null for a one-off event.
  seriesId: z.string().nullable(),
  // Opens the event at its Source (Google Calendar on the web).
  webUrl: z.string().nullable(),
  createdByCommander: commanderEventKind.nullable(),
});
export type EventDetail = z.infer<typeof eventDetail>;

// ---------------------------------------------------------------------------------------------
// Calendars: each Account's calendars, and whether the User has them on

// A calendar an Account lists. `on`: synced and shown; primary and owned calendars are on until the
// User switches them off, subscribed ones (holidays, a colleague's) off until switched on.
export const calendarSummary = z.object({
  account: id,
  source: z.enum(calendarSources),
  id,
  name: z.string(),
  colour: z.string(),
  primary: z.boolean(),
  // The User's access as the Source reports it (Google: owner, writer, reader, freeBusyReader).
  accessRole: z.string(),
  on: z.boolean(),
});
export type CalendarSummary = z.infer<typeof calendarSummary>;

// Whether a calendar the User hasn't switched yet starts on: the primary one, and those they own.
export const calendarOnByDefault = (calendar: Pick<CalendarSummary, 'primary' | 'accessRole'>) =>
  calendar.primary || calendar.accessRole === 'owner';

// The live events overlapping a time range (epoch ms, `from` inclusive, `to` exclusive), earliest
// first. All-day events are matched loosely (their day anywhere on Earth); the window narrows them
// to the User's own days.
export const eventQuery = z.object({
  from: timestamp,
  to: timestamp,
  accounts: z.array(id).optional(),
  limit: z.number().int().positive().max(5000).optional(),
});
export type EventQuery = z.input<typeof eventQuery>;

// ---------------------------------------------------------------------------------------------
// Settings → Calendar

// Whether a name is a time zone this machine knows (an IANA name, like America/New_York).
const knownTimeZone = (name: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

// `headsUp`: a system notification 2 minutes before each meeting (#128). The one interruption
// Commander makes (decision #23), so it is off until the User turns it on.
// `secondTimeZone` (#127): a second zone shown beside the Day and Week grids and in the event detail;
// null clears it, and leaving it out keeps the one saved.
export const calendarSettings = z.object({
  headsUp: z.boolean(),
  secondTimeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(knownTimeZone, 'That isn’t a time zone this machine knows')
    .nullish(),
});
export type CalendarSettings = z.infer<typeof calendarSettings>;
export const defaultCalendarSettings: CalendarSettings = { headsUp: false };

// ---------------------------------------------------------------------------------------------
// Rule fields: one set of readers, registered under each calendar Source's name. Each reads the events
// of every calendar Source alike, so a calendar Rule written once files Google and Microsoft events
// both: people and titles are the same wherever an event comes from, and calendar and Account ids are
// each Source's own, so "calendar is Standups" still matches only that calendar's events.

type Readable = Pick<Item, 'kind' | 'source' | 'account' | 'title' | 'detail'>;

const isCalendarSource = (source: Source | null): source is CalendarSource =>
  (calendarSources as readonly (Source | null)[]).includes(source);

const choices = ['is', 'is-not'] as const;

const personValue = (person: EventPerson): RuleFieldValue => ({
  value: person.email.toLowerCase(),
  label: person.name?.trim() || person.email,
});

/** The Rule fields of a calendar Source (`google-calendar.calendar`, …), reading every calendar event. */
export function eventRuleFields(source: CalendarSource): RuleField[] {
  const event = (item: Readable) =>
    isCalendarSource(item.source) && item.detail?.kind === 'event' ? item.detail : null;
  return [
    {
      id: `${source}.calendar`,
      name: 'calendar',
      label: 'Calendar',
      ops: choices,
      read: (item) => {
        const detail = event(item);
        return detail ? [{ value: detail.calendar.id, label: detail.calendar.name }] : [];
      },
    },
    {
      id: `${source}.organiser`,
      name: 'organiser',
      label: 'Organiser',
      ops: choices,
      read: (item) => {
        const organiser = event(item)?.organiser;
        return organiser ? [personValue(organiser)] : [];
      },
    },
    {
      id: `${source}.attendee`,
      name: 'attendee',
      label: 'Attendee',
      ops: choices,
      read: (item) =>
        event(item)
          ?.attendees.filter((each) => !each.resource)
          .map(personValue) ?? [],
    },
    {
      id: `${source}.title`,
      name: 'title',
      label: 'Title',
      ops: ['contains'],
      read: (item) => (event(item) ? [{ value: item.title, label: item.title }] : []),
    },
    {
      id: `${source}.account`,
      name: 'account',
      label: 'Account',
      ops: choices,
      read: (item) => {
        const detail = event(item);
        return detail && item.account
          ? [{ value: item.account, label: detail.accountEmail ?? item.account }]
          : [];
      },
    },
  ];
}
