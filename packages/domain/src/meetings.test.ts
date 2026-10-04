import { describe, expect, it } from 'vitest';
import type { EventDetail } from './calendar';
import type { Item } from './items';
import {
  chipWorthyOn,
  isChipWorthy,
  isMeetingsBlockText,
  meetingLine,
  meetingStatus,
  meetingTimes,
} from './meetings';

// Today's meetings (#128): which events get a meeting chip, and how a meeting reads. Times are local,
// as the User sees them: Saturday 3 October 2026.

const at = (hour: number, minute = 0, date = 3) => new Date(2026, 9, date, hour, minute).getTime();

function event(title: string, start: number, end: number, detail: Partial<EventDetail> = {}): Item {
  return {
    id: `event-${title}`,
    kind: 'event',
    source: 'google-calendar',
    account: 'google:1',
    externalId: title,
    title,
    people: [],
    filing: null,
    status: 'open',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Primary', colour: '#9fe1e7' },
      accountEmail: 'sam@example.test',
      start: { at: start, timeZone: 'Europe/London', date: null },
      end: { at: end, timeZone: 'Europe/London', date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: null,
      attendees: [],
      myResponse: 'accepted',
      meetingUrl: null,
      busy: true,
      private: false,
      seriesId: null,
      webUrl: null,
      createdByCommander: null,
      ...detail,
    },
  };
}

describe('the Meetings Block', () => {
  it('is a top-level Block whose text is Meetings, as a heading or not, in any case', () => {
    expect(isMeetingsBlockText('Meetings')).toBe(true);
    expect(isMeetingsBlockText('  meetings ')).toBe(true);
    expect(isMeetingsBlockText('## Meetings')).toBe(true);
    expect(isMeetingsBlockText('Meetings #LT')).toBe(true);
    expect(isMeetingsBlockText('Meetings today')).toBe(false);
    expect(isMeetingsBlockText('Meeting')).toBe(false);
  });
});

describe('which events get a meeting chip', () => {
  const sync = event('Weekly sync', at(10), at(10, 30));

  it('a timed, busy event the User hasn’t declined', () => {
    expect(isChipWorthy(sync)).toBe(true);
    expect(isChipWorthy(event('Invite', at(9), at(10), { myResponse: 'needs-action' }))).toBe(true);
    expect(isChipWorthy(event('Mine', at(9), at(10), { myResponse: null }))).toBe(true);
  });

  it('not a declined, all-day, free, cancelled or Commander-made one', () => {
    expect(isChipWorthy(event('No', at(9), at(10), { myResponse: 'declined' }))).toBe(false);
    expect(isChipWorthy(event('Holiday', at(0), at(0, 0, 4), { allDay: true }))).toBe(false);
    expect(isChipWorthy(event('Free', at(9), at(10), { busy: false }))).toBe(false);
    expect(isChipWorthy({ ...sync, deletedAt: at(8) })).toBe(false);
    expect(isChipWorthy(event('Focus', at(9), at(10), { createdByCommander: 'focus-block' }))).toBe(false);
  });

  it('on a day: one that starts that day, by the User’s clock', () => {
    expect(chipWorthyOn(sync, '2026-10-03')).toBe(true);
    expect(chipWorthyOn(sync, '2026-10-04')).toBe(false);
    expect(chipWorthyOn(event('Late', at(23, 30, 2), at(0, 30)), '2026-10-03')).toBe(false);
  });
});

describe('how a meeting reads', () => {
  it('its times and title: 10:00–10:30 Weekly sync with Priya', () => {
    const sync = event('Weekly sync with Priya', at(10), at(10, 30));
    expect(meetingTimes(sync.detail as EventDetail)).toBe('10:00–10:30');
    expect(meetingLine(sync, '2026-10-03')).toBe('10:00–10:30 Weekly sync with Priya');
  });

  it('cancelled, declined, or moved to another day, from the note’s day', () => {
    const sync = event('Weekly sync', at(10), at(10, 30));
    expect(meetingStatus(sync, '2026-10-03')).toEqual({ kind: 'on' });
    expect(meetingStatus({ ...sync, deletedAt: at(9) }, '2026-10-03')).toEqual({ kind: 'cancelled' });
    expect(meetingStatus(undefined, '2026-10-03')).toEqual({ kind: 'cancelled' });
    const declined = event('Weekly sync', at(10), at(10, 30), { myResponse: 'declined' });
    expect(meetingStatus(declined, '2026-10-03')).toEqual({ kind: 'declined' });
    const moved = event('Weekly sync', at(10, 0, 8), at(10, 30, 8));
    expect(meetingStatus(moved, '2026-10-03')).toEqual({ kind: 'moved', to: 'Thu 10:00' });
    expect(meetingLine({ ...sync, deletedAt: at(9) }, '2026-10-03')).toBe(
      '~~10:00–10:30 Weekly sync~~ (Cancelled)',
    );
    expect(meetingLine(moved, '2026-10-03')).toBe('10:00–10:30 Weekly sync (Moved to Thu 10:00)');
  });
});
