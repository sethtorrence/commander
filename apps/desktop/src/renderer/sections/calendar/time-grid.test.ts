import type { EventDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from './agenda';
import { dayBlocks, inAllDayStrip, localInstant, monthCells, nowLine, stripBars } from './time-grid';

// The Day and Week time grids and the Month grid, laid out in fixed time zones: where each event's
// block goes, side by side when they overlap; the all-day strip's bars; the "now" line; and the days
// the clocks change.

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

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
      webUrl: null,
      createdByCommander: null,
      ...extra,
    },
  };
}

function allDay(title: string, first: string, endExclusive: string): CalendarEvent {
  const base = timed(title, `${first}T00:00:00Z`, `${endExclusive}T00:00:00Z`);
  return {
    ...base,
    detail: {
      ...base.detail,
      allDay: true,
      start: { at: Date.parse(`${first}T00:00:00Z`), timeZone: null, date: first },
      end: { at: Date.parse(`${endExclusive}T00:00:00Z`), timeZone: null, date: endExclusive },
    },
  };
}

const layout = (events: CalendarEvent[], day: string, timeZone = LONDON) =>
  dayBlocks(events, day, timeZone).map((block) => ({
    title: block.event.title,
    top: block.top,
    bottom: block.bottom,
    column: block.column,
    columns: block.columns,
  }));

describe('dayBlocks', () => {
  it('places each event by its local start and end, in minutes from midnight', () => {
    // 5 October 2026: London is on BST (UTC+1).
    const review = timed('Design review', '2026-10-05T13:00:00Z', '2026-10-05T14:30:00Z');
    expect(layout([review], '2026-10-05')).toEqual([
      { title: 'Design review', top: 14 * 60, bottom: 15.5 * 60, column: 0, columns: 1 },
    ]);
  });

  it('sets overlapping events side by side, and only as many columns as a cluster needs', () => {
    const a = timed('A', '2026-10-05T08:00:00Z', '2026-10-05T11:00:00Z');
    const b = timed('B', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z');
    const c = timed('C', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    const lunch = timed('Lunch', '2026-10-05T11:30:00Z', '2026-10-05T12:30:00Z');
    expect(layout([lunch, c, b, a], '2026-10-05')).toEqual([
      { title: 'A', top: 540, bottom: 720, column: 0, columns: 2 },
      { title: 'B', top: 540, bottom: 600, column: 1, columns: 2 },
      { title: 'C', top: 600, bottom: 660, column: 1, columns: 2 },
      { title: 'Lunch', top: 750, bottom: 810, column: 0, columns: 1 },
    ]);
  });

  it('lets back-to-back events have the full width', () => {
    const a = timed('A', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z');
    const b = timed('B', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');
    expect(layout([a, b], '2026-10-05').map((block) => block.columns)).toEqual([1, 1]);
  });

  it('gives a very short event room to read, and lays the others out around it', () => {
    const quick = timed('Quick', '2026-10-05T08:00:00Z', '2026-10-05T08:05:00Z');
    const after = timed('After', '2026-10-05T08:10:00Z', '2026-10-05T09:00:00Z');
    expect(layout([quick, after], '2026-10-05')).toEqual([
      { title: 'Quick', top: 540, bottom: 560, column: 0, columns: 2 },
      { title: 'After', top: 550, bottom: 600, column: 1, columns: 2 },
    ]);
  });

  it('splits an event across midnight between the two days', () => {
    const late = timed('Late deploy', '2026-10-05T21:00:00Z', '2026-10-06T00:30:00Z');
    expect(layout([late], '2026-10-05')).toEqual([
      { title: 'Late deploy', top: 22 * 60, bottom: 24 * 60, column: 0, columns: 1 },
    ]);
    expect(layout([late], '2026-10-06')).toEqual([
      { title: 'Late deploy', top: 0, bottom: 90, column: 0, columns: 1 },
    ]);
    const [first] = dayBlocks([late], '2026-10-05', LONDON);
    const [second] = dayBlocks([late], '2026-10-06', LONDON);
    expect([first?.continuesBefore, first?.continuesAfter]).toEqual([false, true]);
    expect([second?.continuesBefore, second?.continuesAfter]).toEqual([true, false]);
  });

  it('reads the day in the User’s time zone, not the event’s', () => {
    const review = timed('Design review', '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z');
    expect(layout([review], '2026-10-05', NEW_YORK)).toEqual([
      { title: 'Design review', top: 9 * 60, bottom: 10 * 60, column: 0, columns: 1 },
    ]);
  });

  it('keeps wall-clock hours on the day the clocks go forward', () => {
    // 29 March 2026: London goes from 01:00 GMT to 02:00 BST, so the day is 23 hours long.
    const night = timed('Night shift', '2026-03-29T00:30:00Z', '2026-03-29T02:30:00Z');
    const morning = timed('Standup', '2026-03-29T08:00:00Z', '2026-03-29T08:15:00Z');
    expect(layout([night, morning], '2026-03-29')).toEqual([
      { title: 'Night shift', top: 30, bottom: 210, column: 0, columns: 1 },
      { title: 'Standup', top: 540, bottom: 560, column: 0, columns: 1 },
    ]);
  });

  it('keeps wall-clock hours on the day the clocks go back, even across the repeated hour', () => {
    // 25 October 2026: London goes from 02:00 BST back to 01:00 GMT, so the day is 25 hours long.
    const morning = timed('Standup', '2026-10-25T09:00:00Z', '2026-10-25T09:30:00Z');
    // 01:30 BST to 01:15 GMT: 45 minutes that end "before" they start on the wall clock.
    const repeated = timed('Repeated hour', '2026-10-25T00:30:00Z', '2026-10-25T01:15:00Z');
    expect(layout([morning, repeated], '2026-10-25')).toEqual([
      { title: 'Repeated hour', top: 90, bottom: 135, column: 0, columns: 1 },
      { title: 'Standup', top: 540, bottom: 570, column: 0, columns: 1 },
    ]);
  });

  it('leaves all-day events, and timed ones a day or longer, to the all-day strip', () => {
    const conference = allDay('Conference', '2026-10-05', '2026-10-06');
    const trip = timed('Trip', '2026-10-04T17:00:00Z', '2026-10-06T08:00:00Z');
    expect(layout([conference, trip], '2026-10-05')).toEqual([]);
    expect(inAllDayStrip(conference)).toBe(true);
    expect(inAllDayStrip(trip)).toBe(true);
    expect(inAllDayStrip(timed('Late', '2026-10-05T21:00:00Z', '2026-10-06T00:30:00Z'))).toBe(false);
  });
});

describe('stripBars', () => {
  const week = [
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
    '2026-10-11',
  ];
  const bars = (events: CalendarEvent[]) =>
    stripBars(events, week, LONDON).map((bar) => ({
      title: bar.event.title,
      first: bar.first,
      span: bar.span,
      lane: bar.lane,
      before: bar.continuesBefore,
      after: bar.continuesAfter,
    }));

  it('spans each all-day event across its days, stacking overlapping ones in lanes', () => {
    expect(
      bars([
        allDay('Conference', '2026-10-07', '2026-10-10'),
        allDay('Holiday', '2026-10-08', '2026-10-09'),
        allDay('Sunday lunch', '2026-10-11', '2026-10-12'),
      ]),
    ).toEqual([
      { title: 'Conference', first: 2, span: 3, lane: 0, before: false, after: false },
      { title: 'Holiday', first: 3, span: 1, lane: 1, before: false, after: false },
      { title: 'Sunday lunch', first: 6, span: 1, lane: 0, before: false, after: false },
    ]);
  });

  it('clips an event that runs on before or after the days shown, and says so', () => {
    expect(
      bars([allDay('Leave', '2026-10-01', '2026-10-07'), allDay('Trip', '2026-10-10', '2026-10-20')]),
    ).toEqual([
      { title: 'Leave', first: 0, span: 2, lane: 0, before: true, after: false },
      { title: 'Trip', first: 5, span: 2, lane: 0, before: false, after: true },
    ]);
  });

  it('puts a timed event of a day or more in the strip on the local days it touches', () => {
    expect(bars([timed('Trip', '2026-10-04T17:00:00Z', '2026-10-06T08:00:00Z')])).toEqual([
      { title: 'Trip', first: 0, span: 2, lane: 0, before: true, after: false },
    ]);
  });
});

describe('nowLine', () => {
  it('marks now on today’s column, by the wall clock', () => {
    const days = ['2026-10-05', '2026-10-06'];
    expect(nowLine(Date.parse('2026-10-06T09:45:00Z'), days, LONDON)).toEqual({ column: 1, minutes: 645 });
    expect(nowLine(Date.parse('2026-10-08T09:45:00Z'), days, LONDON)).toBeNull();
  });
});

describe('localInstant', () => {
  it('turns a local day and time into the instant, across a change of clocks', () => {
    expect(localInstant('2026-10-05', 9 * 60, LONDON)).toBe(Date.parse('2026-10-05T08:00:00Z'));
    expect(localInstant('2026-03-29', 9 * 60, LONDON)).toBe(Date.parse('2026-03-29T08:00:00Z'));
    expect(localInstant('2026-03-29', 30, LONDON)).toBe(Date.parse('2026-03-29T00:30:00Z'));
    expect(localInstant('2026-11-01', 9 * 60, NEW_YORK)).toBe(Date.parse('2026-11-01T14:00:00Z'));
  });
});

describe('monthCells', () => {
  it('lists each day’s events in Agenda order, up to a few, and counts the rest', () => {
    const days = ['2026-10-05', '2026-10-06'];
    const events = [
      timed('Standup', '2026-10-05T08:00:00Z', '2026-10-05T08:15:00Z'),
      timed('Review', '2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z'),
      timed('Lunch', '2026-10-05T11:30:00Z', '2026-10-05T12:30:00Z'),
      allDay('Conference', '2026-10-05', '2026-10-07'),
      timed('Planning', '2026-10-05T15:00:00Z', '2026-10-05T16:00:00Z'),
    ];
    const cells = monthCells(events, days, LONDON, 3);
    expect(cells.map((cell) => [cell.day, cell.shown.map((entry) => entry.event.title), cell.more])).toEqual([
      ['2026-10-05', ['Conference', 'Standup', 'Lunch'], 2],
      ['2026-10-06', ['Conference'], 0],
    ]);
  });
});
