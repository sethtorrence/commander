import { describe, expect, it } from 'vitest';
import type { EventDetail } from './calendar';
import { zonedTime } from './focus-time';
import {
  bestSlots,
  bookingLinkText,
  clashesAt,
  freeBusyRoute,
  googleEventEditUrl,
  isOutsideGuest,
  isWorkMicrosoftAccount,
  mightBeAboutMeeting,
  outlookComposeUrl,
  resolveAttendee,
  type SchedulingAccount,
  schedulingSettings,
  withoutBusy,
} from './scheduling';

// The WHATWG URL parser, there in every runtime; this package's ES-only lib settings leave it out.
type Parsed = { origin: string; pathname: string; searchParams: { get(key: string): string | null } };
const URL = (globalThis as unknown as { URL: new (url: string) => Parsed }).URL;

const LONDON = 'Europe/London';
const at = (day: string, time: string) => zonedTime(day, time, LONDON);
const slot = (day: string, from: string, to: string) => ({ start: at(day, from), end: at(day, to) });

function detail(start: number, end: number, extra: Partial<EventDetail> = {}): EventDetail {
  return {
    kind: 'event',
    calendar: { id: 'primary', name: 'Alex', colour: '#33b679' },
    accountEmail: null,
    start: { at: start, timeZone: LONDON, date: null },
    end: { at: end, timeZone: LONDON, date: null },
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
    webUrl: null,
    createdByCommander: null,
    ...extra,
  };
}

describe('the cheap pre-filter on Blocks', () => {
  it('passes Blocks with a weekday, a date, a time or a meeting word', () => {
    for (const text of [
      'call with Leo Tuesday at 2',
      'set up a call with Leo next week about the Acme renewal',
      'Meet Dana about pricing',
      'catch up with Priya',
      'catch-up with the team',
      'sync with design on Thu',
      'lunch with Sam',
      'review the deck at 3pm',
      'demo for Acme on 12/10',
      'Friday: offsite planning',
      'tomorrow 10:30 dentist',
      'coffee with Omar',
      '1:1 with Priya',
    ]) {
      expect(mightBeAboutMeeting(text), text).toBe(true);
    }
  });

  it('leaves out Blocks with nothing that sounds like a meeting', () => {
    for (const text of [
      'need to send Dana the Q3 numbers',
      'Priya leads the reliability push',
      'Morning',
      'fix the login bug',
      'recall the deploy steps',
      'symmetry matters',
      '[[event:6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b]]',
      '',
    ]) {
      expect(mightBeAboutMeeting(text), text).toBe(false);
    }
  });
});

describe('resolving attendees to addresses', () => {
  const directory = {
    seen: [
      { email: 'leo.park@acme.test', name: 'Leo Park' },
      { email: 'dana@contoso.test', name: 'Dana Whitfield' },
      { email: 'sam@contoso.test', name: 'Sam Ito' },
      { email: 'sam.lee@fabrikam.test', name: 'Sam Lee' },
    ],
    people: [
      { email: 'priya@titanlink.test', name: 'Priya Natarajan' },
      { email: 'leo@other.test', name: 'Leo Castro' },
    ],
  };

  it('takes an address as it is, exactly', () => {
    expect(resolveAttendee('Leo@Acme.test', directory)).toEqual({
      name: 'leo@acme.test',
      email: 'leo@acme.test',
      how: 'address',
    });
  });

  it('then names seen on the User’s events and emails, by full or first name', () => {
    expect(resolveAttendee('Leo', directory)).toEqual({
      name: 'Leo Park',
      email: 'leo.park@acme.test',
      how: 'seen',
    });
    expect(resolveAttendee('dana whitfield', directory)).toMatchObject({ email: 'dana@contoso.test' });
  });

  it('then People', () => {
    expect(resolveAttendee('Priya', directory)).toEqual({
      name: 'Priya Natarajan',
      email: 'priya@titanlink.test',
      how: 'person',
    });
  });

  it('leaves the guest blank when the name is unknown or could be more than one person', () => {
    expect(resolveAttendee('Omar', directory)).toEqual({ name: 'Omar', email: null, how: null });
    // Two Sams on the User's events: neither is chosen.
    expect(resolveAttendee('Sam', directory)).toEqual({ name: 'Sam', email: null, how: null });
    expect(resolveAttendee('Sam Lee', directory)).toMatchObject({ email: 'sam.lee@fabrikam.test' });
  });

  it('ignores the User themself and empty names', () => {
    expect(resolveAttendee('   ', directory)).toEqual({ name: '', email: null, how: null });
  });
});

describe('free time for a meeting', () => {
  const MONDAY = '2026-10-05';
  const TUESDAY = '2026-10-06';

  it('takes the guests’ busy times out of the User’s free time', () => {
    expect(
      withoutBusy(
        [slot(MONDAY, '09:00', '12:00')],
        [slot(MONDAY, '10:00', '10:30'), slot(MONDAY, '11:30', '13:00')],
      ),
    ).toEqual([slot(MONDAY, '09:00', '10:00'), slot(MONDAY, '10:30', '11:30')]);
  });

  it('offers the earliest fitting time of each day first, then more on the same days, never overlapping', () => {
    const free = [
      slot(MONDAY, '09:10', '10:00'),
      slot(MONDAY, '14:00', '16:00'),
      slot(TUESDAY, '09:00', '18:00'),
    ];
    expect(bestSlots({ free, durationMinutes: 30, count: 4, timeZone: LONDON })).toEqual([
      slot(MONDAY, '09:30', '10:00'),
      slot(TUESDAY, '09:00', '09:30'),
      slot(MONDAY, '14:00', '14:30'),
      slot(TUESDAY, '09:30', '10:00'),
    ]);
  });

  it('skips free time too short for the meeting', () => {
    const free = [slot(MONDAY, '09:00', '09:45'), slot(TUESDAY, '13:00', '14:00')];
    expect(bestSlots({ free, durationMinutes: 60, count: 5, timeZone: LONDON })).toEqual([
      slot(TUESDAY, '13:00', '14:00'),
    ]);
  });

  it('names what an exact time clashes with: busy, not declined, not a busy copy', () => {
    const events = [
      { title: 'Board prep', detail: detail(at(TUESDAY, '13:30'), at(TUESDAY, '14:15')) },
      { title: 'Lunch (free)', detail: detail(at(TUESDAY, '14:00'), at(TUESDAY, '15:00'), { busy: false }) },
      {
        title: 'Declined',
        detail: detail(at(TUESDAY, '14:00'), at(TUESDAY, '15:00'), { myResponse: 'declined' }),
      },
      {
        title: 'Busy',
        detail: detail(at(TUESDAY, '14:00'), at(TUESDAY, '15:00'), { createdByCommander: 'busy-block' }),
      },
      { title: 'Back to back', detail: detail(at(TUESDAY, '14:30'), at(TUESDAY, '15:00')) },
    ];
    expect(clashesAt(slot(TUESDAY, '14:00', '14:30'), events).map((event) => event.title)).toEqual([
      'Board prep',
    ]);
    expect(clashesAt(slot(TUESDAY, '15:00', '15:30'), events)).toEqual([]);
  });
});

describe('whose calendars can be checked', () => {
  const accounts: SchedulingAccount[] = [
    { account: 'google:alex', source: 'google-calendar', address: 'alex@gmail.com', work: false },
    { account: 'google:work', source: 'google-calendar', address: 'alex@titanlink.test', work: true },
    { account: 'outlook:t1:u1', source: 'outlook-calendar', address: 'alex@contoso.test', work: true },
  ];

  it('asks Google for guests in a Workspace domain the User has an Account in', () => {
    expect(freeBusyRoute('priya@titanlink.test', accounts)).toEqual({
      account: 'google:work',
      source: 'google-calendar',
    });
  });

  it('asks Graph for guests in a Microsoft work organisation the User has an Account in', () => {
    expect(freeBusyRoute('Dana@Contoso.test', accounts)).toEqual({
      account: 'outlook:t1:u1',
      source: 'outlook-calendar',
    });
  });

  it('can’t check outsiders, nor anyone through a personal account', () => {
    expect(freeBusyRoute('leo@acme.test', accounts)).toBeNull();
    expect(freeBusyRoute('bob@gmail.com', accounts)).toBeNull();
    expect(
      freeBusyRoute('sam@contoso.test', [
        {
          account: 'outlook:9188040d-6c67-4c5b-b112-36a304b66dad:u2',
          source: 'outlook-calendar',
          address: 'alex@contoso.test',
          work: false,
        },
      ]),
    ).toBeNull();
  });

  it('tells a work Microsoft account from a personal one', () => {
    expect(
      isWorkMicrosoftAccount('outlook:72f988bf-0000-0000-0000-000000000000:u1', 'alex@contoso.test'),
    ).toBe(true);
    expect(
      isWorkMicrosoftAccount('outlook:9188040d-6c67-4c5b-b112-36a304b66dad:u1', 'alex@contoso.test'),
    ).toBe(false);
    expect(
      isWorkMicrosoftAccount('outlook:72f988bf-0000-0000-0000-000000000000:u1', 'alex@outlook.com'),
    ).toBe(false);
  });

  it('calls a guest outside when their domain matches none of the User’s Accounts (personal mail always is)', () => {
    expect(isOutsideGuest('leo@acme.test', accounts)).toBe(true);
    expect(isOutsideGuest('dana@contoso.test', accounts)).toBe(false);
    expect(isOutsideGuest('priya@TITANLINK.test', accounts)).toBe(false);
    expect(isOutsideGuest('bob@gmail.com', accounts)).toBe(true);
  });
});

describe('handing off to the provider’s own event editor', () => {
  const event = {
    title: 'Call with Leo',
    start: Date.UTC(2026, 9, 6, 13),
    end: Date.UTC(2026, 9, 6, 13, 30),
    guests: ['leo.park@acme.test', 'dana@contoso.test'],
    details: 'From my Daily Note',
  };

  it('opens Google Calendar’s eventedit pre-filled, in the right Google account', () => {
    const url = new URL(googleEventEditUrl({ ...event, accountEmail: 'alex@gmail.com' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/r/eventedit');
    expect(url.searchParams.get('text')).toBe('Call with Leo');
    expect(url.searchParams.get('dates')).toBe('20261006T130000Z/20261006T133000Z');
    expect(url.searchParams.get('add')).toBe('leo.park@acme.test,dana@contoso.test');
    expect(url.searchParams.get('details')).toBe('From my Daily Note');
    expect(url.searchParams.get('authuser')).toBe('alex@gmail.com');
  });

  it('opens Outlook’s compose deep link pre-filled, on the web app the account uses', () => {
    const work = new URL(outlookComposeUrl({ ...event, personal: false, address: 'sam@contoso.test' }));
    expect(`${work.origin}${work.pathname}`).toBe('https://outlook.office.com/calendar/deeplink/compose');
    expect(work.searchParams.get('login_hint')).toBe('sam@contoso.test');
    expect(work.searchParams.get('subject')).toBe('Call with Leo');
    expect(work.searchParams.get('startdt')).toBe('2026-10-06T13:00:00.000Z');
    expect(work.searchParams.get('enddt')).toBe('2026-10-06T13:30:00.000Z');
    expect(work.searchParams.get('to')).toBe('leo.park@acme.test,dana@contoso.test');
    expect(work.searchParams.get('body')).toBe('From my Daily Note');
    const personal = new URL(outlookComposeUrl({ ...event, personal: true }));
    expect(`${personal.origin}${personal.pathname}`).toBe(
      'https://outlook.live.com/calendar/0/deeplink/compose',
    );
  });
});

describe('the booking link', () => {
  it('is an https link, saved in Settings → Calendar', () => {
    expect(schedulingSettings.parse({})).toEqual({
      newEventsAccount: null,
      newEventsCalendar: null,
      bookingLink: null,
    });
    expect(
      schedulingSettings.parse({ bookingLink: ' https://calendar.app.google/abc123 ' }).bookingLink,
    ).toBe('https://calendar.app.google/abc123');
    expect(schedulingSettings.safeParse({ bookingLink: 'javascript:alert(1)' }).success).toBe(false);
    expect(schedulingSettings.safeParse({ bookingLink: 'http://calendar.app.google/abc' }).success).toBe(
      false,
    );
  });

  it('goes to the clipboard as one line', () => {
    expect(bookingLinkText('https://calendar.app.google/abc123')).toBe(
      'Book a time here: https://calendar.app.google/abc123',
    );
  });
});
