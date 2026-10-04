import { describe, expect, it } from 'vitest';
import type { EventDetail } from './calendar';
import {
  checkFocusBlocks,
  DEFAULT_WORKING_HOURS,
  dayInZone,
  type FreeTimeEvent,
  focusSettings,
  freeSlots,
  nextWorkingDays,
  zonedTime,
} from './focus-time';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

// Monday 5 October 2026 (London is on summer time, UTC+1, until 25 October).
const MONDAY = '2026-10-05';
const at = (day: string, time: string, zone = LONDON) => zonedTime(day, time, zone);

let counter = 0;
function event(start: number, end: number, extra: Partial<EventDetail> = {}, account = 'google:alex') {
  counter += 1;
  const detail: EventDetail = {
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
  return { id: `event-${counter}`, account, detail } satisfies FreeTimeEvent;
}

const slot = (start: number, end: number) => ({ start, end });
const workingDay = (day: string, zone = LONDON) => ({
  from: at(day, '00:00', zone),
  to: at(day, '23:59', zone),
});

describe('zoned times', () => {
  it('reads a wall-clock time in a zone, across a change of the clocks', () => {
    expect(zonedTime('2026-10-05', '09:00', LONDON)).toBe(Date.UTC(2026, 9, 5, 8));
    expect(zonedTime('2026-10-26', '09:00', LONDON)).toBe(Date.UTC(2026, 9, 26, 9));
    expect(zonedTime('2026-10-05', '09:00', NEW_YORK)).toBe(Date.UTC(2026, 9, 5, 13));
    expect(zonedTime('2026-10-05', '09:00', 'UTC')).toBe(Date.UTC(2026, 9, 5, 9));
  });

  it('names the day an instant falls on in a zone', () => {
    const lateMonday = Date.UTC(2026, 9, 5, 23, 30);
    expect(dayInZone(lateMonday, LONDON)).toBe('2026-10-06');
    expect(dayInZone(lateMonday, NEW_YORK)).toBe('2026-10-05');
  });
});

describe('free time', () => {
  it('is the working hours, by default 09:00–18:00 Monday to Friday, when nothing is booked', () => {
    expect(DEFAULT_WORKING_HOURS).toEqual({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
    const free = freeSlots({
      events: [],
      ...workingDay(MONDAY),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([slot(at(MONDAY, '09:00'), at(MONDAY, '18:00'))]);
  });

  it('leaves out days the User doesn’t work', () => {
    const free = freeSlots({
      events: [],
      from: at('2026-10-09', '00:00'),
      to: at('2026-10-12', '23:59'),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    // Friday and Monday; not the weekend.
    expect(free).toEqual([
      slot(at('2026-10-09', '09:00'), at('2026-10-09', '18:00')),
      slot(at('2026-10-12', '09:00'), at('2026-10-12', '18:00')),
    ]);
  });

  it('takes out overlapping events from every Account and calendar', () => {
    const free = freeSlots({
      events: [
        event(at(MONDAY, '10:00'), at(MONDAY, '11:00'), {}, 'google:alex'),
        // Overlaps the first, from a work Account.
        event(at(MONDAY, '10:30'), at(MONDAY, '12:00'), {}, 'outlook:sam'),
        event(at(MONDAY, '14:00'), at(MONDAY, '14:30'), {
          calendar: { id: 'c', name: 'TL', colour: '#000' },
        }),
        // Runs past the end of the day.
        event(at(MONDAY, '17:00'), at(MONDAY, '19:00'), {}, 'outlook:sam'),
      ],
      ...workingDay(MONDAY),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([
      slot(at(MONDAY, '09:00'), at(MONDAY, '10:00')),
      slot(at(MONDAY, '12:00'), at(MONDAY, '14:00')),
      slot(at(MONDAY, '14:30'), at(MONDAY, '17:00')),
    ]);
  });

  it('ignores declined and free events, and Commander’s own busy copies, but not focus blocks', () => {
    const free = freeSlots({
      events: [
        event(at(MONDAY, '09:00'), at(MONDAY, '12:00'), { myResponse: 'declined' }),
        event(at(MONDAY, '12:00'), at(MONDAY, '13:00'), { busy: false }),
        event(at(MONDAY, '13:00'), at(MONDAY, '15:00'), { createdByCommander: 'busy-block', private: true }),
        event(at(MONDAY, '15:00'), at(MONDAY, '16:00'), { createdByCommander: 'focus-block', private: true }),
        // Unanswered and tentative invitations still hold the time.
        event(at(MONDAY, '16:00'), at(MONDAY, '16:30'), { myResponse: 'needs-action' }),
        event(at(MONDAY, '16:30'), at(MONDAY, '17:00'), { myResponse: 'tentative' }),
      ],
      ...workingDay(MONDAY),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([
      slot(at(MONDAY, '09:00'), at(MONDAY, '15:00')),
      slot(at(MONDAY, '17:00'), at(MONDAY, '18:00')),
    ]);
  });

  it('keeps only slots of at least the length asked for', () => {
    const free = freeSlots({
      events: [
        event(at(MONDAY, '09:20'), at(MONDAY, '12:00')),
        event(at(MONDAY, '12:45'), at(MONDAY, '18:00')),
      ],
      ...workingDay(MONDAY),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([slot(at(MONDAY, '12:00'), at(MONDAY, '12:45'))]);
  });

  it('starts from now, at the next quarter hour, and treats extra busy times like events', () => {
    const now = at(MONDAY, '10:07');
    const free = freeSlots({
      events: [],
      busy: [slot(at(MONDAY, '13:00'), at(MONDAY, '14:00'))],
      from: now,
      to: at(MONDAY, '23:59'),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([
      slot(at(MONDAY, '10:15'), at(MONDAY, '13:00')),
      slot(at(MONDAY, '14:00'), at(MONDAY, '18:00')),
    ]);
  });

  it('works out working hours in the User’s zone, whatever zone an event was made in', () => {
    const free = freeSlots({
      events: [event(Date.UTC(2026, 9, 5, 13), Date.UTC(2026, 9, 5, 14))],
      ...workingDay(MONDAY, NEW_YORK),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: NEW_YORK,
      minMinutes: 30,
    });
    // 09:00–10:00 New York is booked: 13:00–14:00 UTC.
    expect(free).toEqual([slot(at(MONDAY, '10:00', NEW_YORK), at(MONDAY, '18:00', NEW_YORK))]);
  });

  it('keeps working hours on the clock across a change of the clocks', () => {
    const free = freeSlots({
      events: [],
      from: at('2026-10-23', '00:00'),
      to: at('2026-10-26', '23:59'),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([
      slot(Date.UTC(2026, 9, 23, 8), Date.UTC(2026, 9, 23, 17)),
      slot(Date.UTC(2026, 9, 26, 9), Date.UTC(2026, 9, 26, 18)),
    ]);
  });

  it('counts a busy all-day event as the whole of its days in the User’s zone', () => {
    const free = freeSlots({
      events: [
        event(Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 6), {
          allDay: true,
          start: { at: Date.UTC(2026, 9, 5), timeZone: null, date: '2026-10-05' },
          end: { at: Date.UTC(2026, 9, 6), timeZone: null, date: '2026-10-06' },
        }),
      ],
      from: at(MONDAY, '00:00', NEW_YORK),
      to: at('2026-10-06', '23:59', NEW_YORK),
      workingHours: DEFAULT_WORKING_HOURS,
      timeZone: NEW_YORK,
      minMinutes: 30,
    });
    expect(free).toEqual([slot(at('2026-10-06', '09:00', NEW_YORK), at('2026-10-06', '18:00', NEW_YORK))]);
  });

  it('takes custom working hours', () => {
    const free = freeSlots({
      events: [],
      ...workingDay('2026-10-10'),
      workingHours: { days: [6], start: '10:00', end: '12:30' },
      timeZone: LONDON,
      minMinutes: 30,
    });
    expect(free).toEqual([slot(at('2026-10-10', '10:00'), at('2026-10-10', '12:30'))]);
  });
});

describe('the next working days', () => {
  it('runs from now to the end of the fifth working day, today counting if it is one', () => {
    expect(nextWorkingDays(at(MONDAY, '10:00'), 5, DEFAULT_WORKING_HOURS, LONDON)).toEqual({
      from: at(MONDAY, '10:00'),
      to: at('2026-10-10', '00:00'),
      days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
    });
    // From a Saturday: Monday to Friday.
    expect(nextWorkingDays(at('2026-10-10', '10:00'), 5, DEFAULT_WORKING_HOURS, LONDON).days).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
    ]);
  });

  it('skips today once its working hours are over', () => {
    expect(nextWorkingDays(at(MONDAY, '18:30'), 2, DEFAULT_WORKING_HOURS, LONDON).days).toEqual([
      '2026-10-06',
      '2026-10-07',
    ]);
  });
});

describe('checking focus blocks', () => {
  const free = [
    slot(at(MONDAY, '09:00'), at(MONDAY, '11:00')),
    slot(at(MONDAY, '14:00'), at(MONDAY, '17:00')),
  ];

  it('keeps blocks inside a free slot, and drops those outside one or overlapping another', () => {
    const { kept, dropped } = checkFocusBlocks(
      [
        { ref: 'a', start: at(MONDAY, '09:00'), end: at(MONDAY, '11:00') },
        // Spills out of its slot into a meeting.
        { ref: 'b', start: at(MONDAY, '10:30'), end: at(MONDAY, '12:00') },
        // Spans two slots and the meeting between.
        { ref: 'c', start: at(MONDAY, '10:00'), end: at(MONDAY, '15:00') },
        { ref: 'd', start: at(MONDAY, '14:00'), end: at(MONDAY, '15:30') },
        // Overlaps d.
        { ref: 'e', start: at(MONDAY, '15:00'), end: at(MONDAY, '16:00') },
        { ref: 'f', start: at(MONDAY, '15:30'), end: at(MONDAY, '17:00') },
        // Ends before it starts.
        { ref: 'g', start: at(MONDAY, '16:00'), end: at(MONDAY, '15:45') },
      ],
      free,
    );
    expect(kept.map((block) => block.ref)).toEqual(['a', 'd', 'f']);
    expect(dropped.map(({ block, why }) => [block.ref, why])).toEqual([
      ['b', 'outside your free time'],
      ['c', 'outside your free time'],
      ['e', 'overlaps another focus block'],
      ['g', 'ends before it starts'],
    ]);
  });

  it('drops blocks shorter than the shortest slot asked for', () => {
    const { kept, dropped } = checkFocusBlocks(
      [{ ref: 'a', start: at(MONDAY, '09:00'), end: at(MONDAY, '09:10') }],
      free,
      { minMinutes: 15 },
    );
    expect(kept).toEqual([]);
    expect(dropped[0]?.why).toBe('shorter than 15 minutes');
  });
});

describe('focus settings', () => {
  it('defaults to Monday–Friday 09:00–18:00, no Account chosen and no pairs', () => {
    expect(focusSettings.parse({})).toEqual({
      workingHours: DEFAULT_WORKING_HOURS,
      focusAccount: null,
      blockPairs: [],
    });
  });

  it('refuses working hours that end before they start, and a pair blocking its own Account', () => {
    expect(
      focusSettings.safeParse({ workingHours: { days: [1], start: '18:00', end: '09:00' } }).success,
    ).toBe(false);
    expect(
      focusSettings.safeParse({ blockPairs: [{ from: 'google:a', to: 'google:a', on: true }] }).success,
    ).toBe(false);
  });
});
