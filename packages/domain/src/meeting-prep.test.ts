import { describe, expect, it } from 'vitest';
import type { EventAttendee, EventDetail } from './calendar';
import type { Item } from './items';
import {
  eventRevision,
  isPrepWorthy,
  type MeetingPrepDetail,
  otherAttendees,
  prepReadyText,
  prepSources,
} from './meeting-prep';

const at = (hour: number, minute = 0) => new Date(2026, 9, 5, hour, minute).getTime();

const person = (email: string, extra: Partial<EventAttendee> = {}): EventAttendee => ({
  email,
  name: null,
  self: false,
  response: 'accepted',
  organiser: false,
  optional: false,
  resource: false,
  ...extra,
});

function event(extra: Partial<EventDetail> = {}, item: Partial<Item> = {}): Item & { detail: EventDetail } {
  return {
    id: 'event-1',
    kind: 'event',
    source: 'google-calendar',
    account: 'google:1',
    externalId: 'e1',
    title: '1:1 with Priya',
    people: [],
    filing: null,
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...item,
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Primary', colour: '#9fe1e7' },
      accountEmail: 'alex@acme.test',
      start: { at: at(15), timeZone: null, date: null },
      end: { at: at(15, 30), timeZone: null, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: { email: 'alex@acme.test', name: 'Alex', self: true },
      attendees: [person('alex@acme.test', { self: true, organiser: true }), person('priya@acme.test')],
      myResponse: 'accepted',
      meetingUrl: null,
      busy: true,
      private: false,
      seriesId: null,
      webUrl: null,
      createdByCommander: null,
      ...extra,
    },
  };
}

describe('which meetings Ares prepares', () => {
  it('prepares a meeting with someone else in it', () => {
    expect(isPrepWorthy(event())).toBe(true);
  });

  it('leaves out one with nobody else, or only rooms', () => {
    expect(isPrepWorthy(event({ attendees: [] }))).toBe(false);
    expect(
      isPrepWorthy(
        event({
          attendees: [person('alex@acme.test', { self: true }), person('room@acme.test', { resource: true })],
        }),
      ),
    ).toBe(false);
  });

  it('counts an organiser who isn’t the User as someone else', () => {
    expect(
      isPrepWorthy(
        event({
          organiser: { email: 'dana@acme.test', name: 'Dana', self: false },
          attendees: [person('alex@acme.test', { self: true })],
        }),
      ),
    ).toBe(true);
  });

  it('leaves out declined, cancelled, all-day, free and Commander’s own events', () => {
    expect(isPrepWorthy(event({ myResponse: 'declined' }))).toBe(false);
    expect(isPrepWorthy(event({}, { deletedAt: 1 }))).toBe(false);
    expect(isPrepWorthy(event({ allDay: true }))).toBe(false);
    expect(isPrepWorthy(event({ busy: false }))).toBe(false);
    expect(isPrepWorthy(event({ createdByCommander: 'focus-block' }))).toBe(false);
  });
});

describe('the other people in a meeting', () => {
  it('are the guests and organiser who aren’t the User, each once, without rooms', () => {
    const detail = event({
      organiser: { email: 'Dana@acme.test', name: 'Dana', self: false },
      attendees: [
        person('alex@acme.test', { self: true }),
        person('priya@acme.test'),
        person('PRIYA@acme.test'),
        person('dana@acme.test', { organiser: true }),
        person('room@acme.test', { resource: true }),
      ],
    }).detail;
    expect(otherAttendees(detail).map((each) => each.email)).toEqual(['priya@acme.test', 'dana@acme.test']);
  });
});

describe('an event’s revision', () => {
  it('stays the same while nothing a prep reads changes', () => {
    expect(eventRevision(event())).toBe(eventRevision(event({ location: 'Room 4', meetingUrl: 'x' })));
  });

  it('changes when the meeting moves, is retitled, or its description or guests change', () => {
    const base = eventRevision(event());
    expect(eventRevision(event({ start: { at: at(16), timeZone: null, date: null } }))).not.toBe(base);
    expect(eventRevision(event({}, { title: 'Sync with Priya' }))).not.toBe(base);
    expect(eventRevision(event({ description: 'Bring the deck' }))).not.toBe(base);
    expect(
      eventRevision(event({ attendees: [person('priya@acme.test', { response: 'declined' })] })),
    ).not.toBe(base);
  });
});

describe('a prep', () => {
  it('lists the Items its lines rest on, each once', () => {
    const detail: MeetingPrepDetail = {
      kind: 'meeting-prep',
      eventId: 'event-1',
      revision: 'r',
      preparedAt: 0,
      about: { text: 'Launch review', sources: ['event-1'] },
      lastTime: [{ text: 'Priya owns the checklist', sources: ['block-1'] }],
      open: [{ text: 'ENG-4 is in review', sources: ['issue-4', 'event-1'] }],
      raise: [],
    };
    expect(prepSources(detail)).toEqual(['event-1', 'block-1', 'issue-4']);
  });

  it('is announced as ready with the meeting’s title and time', () => {
    expect(prepReadyText({ title: '1:1  with Priya', startsAt: at(15) })).toBe(
      'Prep for “1:1 with Priya” at 15:00 is ready.',
    );
    expect(prepReadyText({ title: '1:1 with Priya', startsAt: at(15) }, { quote: false })).toBe(
      'Prep for your meeting at 15:00 is ready.',
    );
  });
});
