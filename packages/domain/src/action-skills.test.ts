import { describe, expect, it } from 'vitest';
import {
  dueDayFrom,
  fileInput,
  linearActionsInput,
  manageTodosInput,
  scheduleAt,
  scheduleInput,
  scheduleWindow,
  snoozeInput,
  snoozeUntilFrom,
} from './action-skills';
import { DEFAULT_WORKING_HOURS, zonedTime } from './focus-time';

// The words Ares's action Skills take times in (#196), turned into days and times on the User's own
// calendar. Every clock here is local, so they hold in any time zone, and just after midnight.

const at = (month: number, day: number, hour = 0, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();
// Tuesday 6 October 2026, five past midnight.
const TUESDAY = at(10, 6, 0, 5);
const FRIDAY = at(10, 9, 23, 55);
const SATURDAY = at(10, 10, 9);
const SUNDAY = at(10, 11, 0, 1);

describe('due days', () => {
  it('reads today, tomorrow, the weekend and next week from just after midnight', () => {
    expect(dueDayFrom('today', TUESDAY)).toBe('2026-10-06');
    expect(dueDayFrom('tomorrow', TUESDAY)).toBe('2026-10-07');
    expect(dueDayFrom('this-weekend', TUESDAY)).toBe('2026-10-10');
    expect(dueDayFrom('next-week', TUESDAY)).toBe('2026-10-12');
    expect(dueDayFrom('this-weekend', SUNDAY)).toBe('2026-10-11');
    expect(dueDayFrom('next-week', SUNDAY)).toBe('2026-10-12');
  });

  it('takes a weekday as the next one, today counting: “by Friday” on a Friday is today', () => {
    expect(dueDayFrom('Friday', TUESDAY)).toBe('2026-10-09');
    expect(dueDayFrom('friday', FRIDAY)).toBe('2026-10-09');
    expect(dueDayFrom('tuesday', TUESDAY)).toBe('2026-10-06');
    expect(dueDayFrom('monday', TUESDAY)).toBe('2026-10-12');
  });

  it('keeps a real date as it is, across the month and year, and nothing else', () => {
    expect(dueDayFrom('2026-11-02', TUESDAY)).toBe('2026-11-02');
    expect(dueDayFrom('tomorrow', at(12, 31, 0, 1))).toBe('2027-01-01');
    expect(dueDayFrom('2026-02-30', TUESDAY)).toBeNull();
    expect(dueDayFrom('someday', TUESDAY)).toBeNull();
  });
});

describe('snooze times', () => {
  it('reads the times Commander’s own Snooze offers', () => {
    expect(snoozeUntilFrom('later-today', TUESDAY)).toBe(at(10, 6, 18));
    expect(snoozeUntilFrom('tomorrow', TUESDAY)).toBe(at(10, 7, 8));
    expect(snoozeUntilFrom('this-weekend', TUESDAY)).toBe(at(10, 10, 8));
    expect(snoozeUntilFrom('next-week', TUESDAY)).toBe(at(10, 12, 8));
    expect(snoozeUntilFrom('this-weekend', SATURDAY)).toBe(at(10, 17, 8));
  });

  it('takes a weekday as the next one after today, at 08:00', () => {
    expect(snoozeUntilFrom('Monday', TUESDAY)).toBe(at(10, 12, 8));
    expect(snoozeUntilFrom('tuesday', TUESDAY)).toBe(at(10, 13, 8));
    expect(snoozeUntilFrom('saturday', FRIDAY)).toBe(at(10, 10, 8));
  });

  it('takes a date (08:00) or a time on one, and refuses one already gone', () => {
    expect(snoozeUntilFrom('2026-10-20', TUESDAY)).toBe(at(10, 20, 8));
    expect(snoozeUntilFrom('2026-10-06T14:30', TUESDAY)).toBe(at(10, 6, 14, 30));
    expect(snoozeUntilFrom('2026-10-06', TUESDAY + 9 * 3_600_000)).toBeNull();
    expect(snoozeUntilFrom('later-today', at(10, 6, 18, 30))).toBeNull();
    expect(snoozeUntilFrom('2026-10-06T25:00', TUESDAY)).toBeNull();
    expect(snoozeUntilFrom('soon', TUESDAY)).toBeNull();
  });
});

describe('what each action Skill needs', () => {
  it('names Items only by refs, and times only in the words Commander reads', () => {
    expect(
      manageTodosInput.parse({ action: 'add', title: ' Send Leo the redlines ', due: 'Friday' }),
    ).toEqual({
      action: 'add',
      title: 'Send Leo the redlines',
      due: 'friday',
    });
    expect(manageTodosInput.safeParse({ action: 'add', title: 'X', due: 'whenever' }).success).toBe(false);
    expect(manageTodosInput.safeParse({ action: 'done', todos: ['the invoice Todo'] }).success).toBe(false);
    expect(manageTodosInput.safeParse({ action: 'due', todos: ['I1'], due: null }).success).toBe(true);
    expect(fileInput.safeParse({ items: [], project: 'LT' }).success).toBe(false);
    expect(snoozeInput.safeParse({ items: ['I2'], until: '2026-10-12T09:15' }).success).toBe(true);
    expect(linearActionsInput.safeParse({ action: 'assign', issues: ['I1'], to: null }).success).toBe(true);
    expect(linearActionsInput.safeParse({ action: 'delete', issues: ['I1'] }).success).toBe(false);
  });
});

// Schedule (#198): the span a "when" means and the instant an "at" means, in the User's own zone,
// given explicitly, so they hold whatever the machine's zone is.
describe('Schedule’s times', () => {
  const zone = 'America/New_York';
  const local = (day: string, time: string) => zonedTime(day, time, zone);
  const hours = DEFAULT_WORKING_HOURS;
  // Tuesday 6 October 2026, five past midnight in New York.
  const now = local('2026-10-06', '00:05');

  it('reads today, tomorrow, a weekday, this week and next week from just after midnight', () => {
    expect(scheduleWindow('today', now, zone, hours)).toEqual({
      from: now,
      to: local('2026-10-07', '00:00'),
      words: 'today',
    });
    expect(scheduleWindow('tomorrow', now, zone, hours)).toMatchObject({
      from: local('2026-10-07', '00:00'),
      to: local('2026-10-08', '00:00'),
    });
    // A weekday is the next one, today counting.
    expect(scheduleWindow('tuesday', now, zone, hours)).toMatchObject({
      from: now,
      to: local('2026-10-07', '00:00'),
      words: 'Tuesday 6 October',
    });
    expect(scheduleWindow('Monday', now, zone, hours)).toMatchObject({
      from: local('2026-10-12', '00:00'),
      words: 'Monday 12 October',
    });
    expect(scheduleWindow('this-week', now, zone, hours)).toEqual({
      from: now,
      to: local('2026-10-12', '00:00'),
      words: 'this week',
    });
    expect(scheduleWindow('next-week', now, zone, hours)).toEqual({
      from: local('2026-10-12', '00:00'),
      to: local('2026-10-19', '00:00'),
      words: 'next week',
    });
    // On a Sunday, next week is the one starting tomorrow.
    expect(scheduleWindow('next-week', local('2026-10-11', '23:50'), zone, hours).from).toBe(
      local('2026-10-12', '00:00'),
    );
    expect(scheduleWindow('2026-10-20', now, zone, hours)).toMatchObject({
      from: local('2026-10-20', '00:00'),
      to: local('2026-10-21', '00:00'),
    });
  });

  it('looks in the next five working days when no time was said', () => {
    expect(scheduleWindow(undefined, now, zone, hours)).toEqual({
      from: now,
      to: local('2026-10-13', '00:00'),
      words: 'the next 5 working days',
    });
  });

  it('reads an exact time on the User’s clock', () => {
    expect(scheduleAt('2026-10-06T14:00', zone)).toBe(local('2026-10-06', '14:00'));
    expect(scheduleAt('2026-10-06 09:30', 'Asia/Tokyo')).toBe(zonedTime('2026-10-06', '09:30', 'Asia/Tokyo'));
  });

  it('takes people, a length and a time only in the words Commander reads, and Items only by refs', () => {
    expect(
      scheduleInput.parse({ action: 'meeting', with: [' Leo '], minutes: 60, when: 'Next-Week' }),
    ).toEqual({ action: 'meeting', with: ['Leo'], minutes: 60, when: 'next-week' });
    expect(scheduleInput.safeParse({ action: 'meeting', with: [] }).success).toBe(false);
    expect(scheduleInput.safeParse({ action: 'meeting', with: ['Leo'], minutes: 5 }).success).toBe(false);
    expect(
      scheduleInput.safeParse({ action: 'meeting', with: ['Leo'], at: '2026-02-30T10:00' }).success,
    ).toBe(false);
    expect(
      scheduleInput.safeParse({ action: 'meeting', with: ['Leo'], at: '2026-10-06T14:00' }).success,
    ).toBe(true);
    expect(scheduleInput.safeParse({ action: 'focus', todo: 'the Acme Todo', minutes: 120 }).success).toBe(
      false,
    );
    expect(scheduleInput.safeParse({ action: 'focus', todo: 'I2', minutes: 120 }).success).toBe(true);
    expect(scheduleInput.safeParse({ action: 'booking-link', to: 'I1' }).success).toBe(true);
    expect(scheduleInput.safeParse({ action: 'send', to: 'I1' }).success).toBe(false);
  });
});
