import type { EventDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  agendaDays,
  type CalendarEvent,
  dayKey,
  dayStart,
  daysOf,
  editUrl,
  newEventUrl,
  newOutlookEventUrl,
  stillToCome,
  whenText,
} from './agenda';

// The Agenda's arithmetic in fixed time zones, with a fixed clock: nothing here reads the machine's.

const LONDON = 'Europe/London';
const AUCKLAND = 'Pacific/Auckland';
const LOS_ANGELES = 'America/Los_Angeles';
const HOUR = 60 * 60_000;

let next = 0;
function timed(title: string, start: string, end: string, extra: Partial<EventDetail> = {}): CalendarEvent {
  next += 1;
  return {
    id: `event-${next}`,
    kind: 'event',
    source: 'google-calendar',
    account: 'google:1',
    externalId: `alex@gmail.test/${next}`,
    title,
    people: [],
    filing: null,
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    detail: {
      kind: 'event',
      calendar: { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7' },
      accountEmail: 'alex@gmail.test',
      start: { at: Date.parse(start), timeZone: LONDON, date: null },
      end: { at: Date.parse(end), timeZone: LONDON, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: null,
      attendees: [],
      myResponse: null,
      meetingUrl: null,
      busy: true,
      private: false,
      seriesId: null,
      webUrl: `https://www.google.com/calendar/event?eid=e${next}`,
      createdByCommander: null,
      ...extra,
    },
  };
}

function allDay(title: string, from: string, until: string): CalendarEvent {
  const event = timed(title, `${from}T00:00:00Z`, `${until}T00:00:00Z`);
  return {
    ...event,
    detail: {
      ...event.detail,
      allDay: true,
      start: { at: Date.parse(`${from}T00:00:00Z`), timeZone: null, date: from },
      end: { at: Date.parse(`${until}T00:00:00Z`), timeZone: null, date: until },
    },
  };
}

const outline = (days: ReturnType<typeof agendaDays>) =>
  days.map((day) => [day.title, day.entries.map((entry) => `${entry.time} ${entry.event.title}`)]);

describe('days in a time zone', () => {
  it('names the local day of an instant, and when a day starts there', () => {
    const late = Date.UTC(2026, 9, 3, 23, 30);
    expect(dayKey(late, LONDON)).toBe('2026-10-04');
    expect(dayKey(late, LOS_ANGELES)).toBe('2026-10-03');
    expect(dayStart('2026-10-04', LONDON)).toBe(Date.UTC(2026, 9, 3, 23));
    expect(dayStart('2026-10-04', AUCKLAND)).toBe(Date.UTC(2026, 9, 3, 11));
    // The clocks go back in London on 25 October: that day still starts at local midnight.
    expect(dayStart('2026-10-26', LONDON)).toBe(Date.UTC(2026, 9, 26));
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('puts a timed event on each local day it covers, and an all-day one on its own days anywhere', () => {
    const lateCall = timed('Late call', '2026-10-05T22:30:00Z', '2026-10-05T23:30:00Z');
    expect(daysOf(lateCall, LONDON)).toEqual(['2026-10-05', '2026-10-06']);
    expect(daysOf(lateCall, LOS_ANGELES)).toEqual(['2026-10-05']);
    const conference = allDay('Conference', '2026-10-12', '2026-10-14');
    expect(daysOf(conference, AUCKLAND)).toEqual(['2026-10-12', '2026-10-13']);
    expect(daysOf(conference, LOS_ANGELES)).toEqual(['2026-10-12', '2026-10-13']);
    // Ending exactly at midnight doesn't reach the next day.
    expect(daysOf(timed('Evening', '2026-10-05T21:00:00Z', '2026-10-05T23:00:00Z'), LONDON)).toEqual([
      '2026-10-05',
    ]);
  });
});

describe('the Agenda', () => {
  const events = [
    timed('Design review', '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z'),
    timed('TL standup', '2026-10-05T08:00:00Z', '2026-10-05T08:15:00Z'),
    allDay('Bank holiday', '2026-10-05', '2026-10-06'),
    timed('Overnight deploy', '2026-10-06T22:00:00Z', '2026-10-07T02:00:00Z'),
    timed('Yesterday', '2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z'),
    timed('Next month', '2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z'),
  ];

  it('lists today first (even when empty), then each day with events, all-day events at the top', () => {
    const days = agendaDays(events, { today: '2026-10-03', days: 14, timeZone: LONDON });
    expect(outline(days)).toEqual([
      ['Today · Saturday 3 October', []],
      ['Monday 5 October', ['All day Bank holiday', '09:00 TL standup', '15:00 Design review']],
      ['Tuesday 6 October', ['23:00 Overnight deploy']],
      ['Wednesday 7 October', ['Continues Overnight deploy']],
    ]);
    expect(days[1]?.entries[1]?.until).toBe('09:15');
    expect(days[2]?.entries[0]?.until).toBeNull();
    expect(days[3]?.entries[0]?.until).toBe('03:00');
  });

  it('follows the time zone it is given', () => {
    const days = agendaDays(events, { today: '2026-10-04', days: 7, timeZone: LOS_ANGELES });
    expect(outline(days)).toEqual([
      ['Today · Sunday 4 October', []],
      ['Tomorrow · Monday 5 October', ['All day Bank holiday', '01:00 TL standup', '07:00 Design review']],
      ['Tuesday 6 October', ['15:00 Overnight deploy']],
    ]);
  });

  it('counts today’s timed events still to come, for the tab', () => {
    const now = Date.UTC(2026, 9, 5, 10);
    expect(stillToCome(events, now, LONDON)).toBe(1);
    expect(stillToCome(events, now - 3 * HOUR, LONDON)).toBe(2);
  });

  it('says when an event is', () => {
    expect(whenText(events[0] as CalendarEvent, LONDON)).toBe('Monday 5 October · 15:00–16:00');
    expect(whenText(allDay('Conference', '2026-10-12', '2026-10-14'), LONDON)).toBe(
      'Monday 12 October – Tuesday 13 October · All day',
    );
  });
});

describe('handing over to Google Calendar', () => {
  it('opens a new event, and an event, as the Account they belong to', () => {
    expect(newEventUrl('alex@gmail.test')).toBe(
      'https://calendar.google.com/calendar/r/eventedit?authuser=alex%40gmail.test',
    );
    expect(newEventUrl(null)).toBe('https://calendar.google.com/calendar/r/eventedit');
    const event = timed('Review', '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z');
    expect(editUrl(event)).toBe(`${event.detail.webUrl}&authuser=alex%40gmail.test`);
    expect(editUrl({ ...event, detail: { ...event.detail, webUrl: null } })).toBeNull();
  });
});

describe('handing over to Outlook on the web', () => {
  it('opens a new event for a work or school Account at outlook.office.com, and a personal one at outlook.live.com', () => {
    expect(newOutlookEventUrl('sam@contoso.test', false)).toBe(
      'https://outlook.office.com/calendar/deeplink/compose?login_hint=sam%40contoso.test',
    );
    expect(newOutlookEventUrl('sam@outlook.test', true)).toBe(
      'https://outlook.live.com/calendar/0/deeplink/compose?login_hint=sam%40outlook.test',
    );
    expect(newOutlookEventUrl(null, false)).toBe('https://outlook.office.com/calendar/deeplink/compose');
  });

  it('opens an Outlook event at its web link as is, hinting the Account to sign in as', () => {
    const webUrl =
      'https://outlook.office365.com/owa/?itemid=AAMkAGI2-evt-x%3D&exvsurl=1&path=/calendar/item';
    const event = timed('Review', '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z', {
      webUrl,
      accountEmail: 'sam@contoso.test',
    });
    expect(editUrl({ ...event, source: 'outlook-calendar' })).toBe(`${webUrl}&login_hint=sam%40contoso.test`);
  });
});
