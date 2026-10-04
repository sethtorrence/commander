import { describe, expect, it } from 'vitest';
import type { EventDetail } from './calendar';
import { type ClashingEvent, findClashes } from './clashes';

// The clash rule (#127): events from different Accounts that overlap while the User is busy in both.

const WORK = 'outlook:tenant:sam';
const HOME = 'google:alex';

let next = 0;
function event(
  account: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<EventDetail> = {},
): ClashingEvent {
  next += 1;
  return {
    id: `event-${next}`,
    account,
    title,
    deletedAt: null,
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Calendar', colour: '#0078d4' },
      accountEmail: account === WORK ? 'sam@contoso.test' : 'alex@gmail.test',
      start: { at: Date.parse(start), timeZone: 'Europe/London', date: null },
      end: { at: Date.parse(end), timeZone: 'Europe/London', date: null },
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
    },
  };
}

const clashesOf = (events: ClashingEvent[]) => {
  const found = findClashes(events);
  return Object.fromEntries(
    events
      .filter((each) => found.has(each.id))
      .map((each) => [each.title, (found.get(each.id) ?? []).map((other) => other.title)]),
  );
};

describe('findClashes', () => {
  it('marks both of two overlapping busy events from different Accounts', () => {
    const board = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const dentist = event(HOME, 'Dentist', '2026-10-05T09:30:00Z', '2026-10-05T10:15:00Z');
    expect(clashesOf([board, dentist])).toEqual({ 'Board prep': ['Dentist'], Dentist: ['Board prep'] });
  });

  it('leaves overlaps within one Account alone: Google and Outlook show those already', () => {
    const one = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const two = event(WORK, 'Standup', '2026-10-05T09:30:00Z', '2026-10-05T09:45:00Z');
    expect(clashesOf([one, two])).toEqual({});
  });

  it('never marks an event the User declined, or one marked free', () => {
    const board = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const declined = event(HOME, 'Declined call', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z', {
      myResponse: 'declined',
    });
    const free = event(HOME, 'Gym (free)', '2026-10-05T09:15:00Z', '2026-10-05T09:45:00Z', { busy: false });
    expect(clashesOf([board, declined, free])).toEqual({});
  });

  it('counts tentative and unanswered invitations as busy', () => {
    const board = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z', {
      myResponse: 'tentative',
    });
    const call = event(HOME, 'School call', '2026-10-05T09:50:00Z', '2026-10-05T10:20:00Z', {
      myResponse: 'needs-action',
    });
    expect(clashesOf([board, call])).toEqual({
      'Board prep': ['School call'],
      'School call': ['Board prep'],
    });
  });

  it('lets back-to-back events be', () => {
    const board = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const next_ = event(HOME, 'Dentist', '2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z');
    expect(clashesOf([board, next_])).toEqual({});
  });

  it('leaves all-day events out: they mark days, not hours', () => {
    const board = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const away = event(HOME, 'Away', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', {
      allDay: true,
      start: { at: Date.parse('2026-10-05T00:00:00Z'), timeZone: null, date: '2026-10-05' },
      end: { at: Date.parse('2026-10-06T00:00:00Z'), timeZone: null, date: '2026-10-06' },
    });
    expect(clashesOf([board, away])).toEqual({});
  });

  it('leaves cancelled events out', () => {
    const board = event(WORK, 'Board prep', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const gone = { ...event(HOME, 'Dentist', '2026-10-05T09:30:00Z', '2026-10-05T10:15:00Z'), deletedAt: 1 };
    expect(clashesOf([board, gone])).toEqual({});
  });

  it('leaves out Commander’s busy copies, which stand for an event in the other Account (#131)', () => {
    const dentist = event(HOME, 'Dentist', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const copy = event(WORK, 'Busy', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z', {
      createdByCommander: 'busy-block',
      private: true,
    });
    expect(clashesOf([dentist, copy])).toEqual({});
  });

  it('takes one meeting the User is invited to in both Accounts for itself, not a clash', () => {
    const atWork = event(WORK, 'Quarterly review', '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z');
    const atHome = event(HOME, 'Quarterly Review ', '2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z');
    expect(clashesOf([atWork, atHome])).toEqual({});
  });

  it('finds every clash of a long event, in start order, and none past it', () => {
    const offsite = event(WORK, 'Offsite', '2026-10-05T09:00:00Z', '2026-10-05T17:00:00Z');
    const a = event(HOME, 'Dentist', '2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z');
    const b = event(HOME, 'School run', '2026-10-05T16:30:00Z', '2026-10-05T17:30:00Z');
    const c = event(HOME, 'Dinner', '2026-10-05T19:00:00Z', '2026-10-05T21:00:00Z');
    expect(clashesOf([b, c, a, offsite])).toEqual({
      'School run': ['Offsite'],
      Dentist: ['Offsite'],
      Offsite: ['Dentist', 'School run'],
    });
  });
});
