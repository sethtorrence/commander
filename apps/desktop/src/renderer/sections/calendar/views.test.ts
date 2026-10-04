import { describe, expect, it } from 'vitest';
import { outsideSyncedWindow, rangeTitle, stepAnchor, viewDays, viewOf } from './views';

// Which days each view shows, how [ and ] move it, and how its range reads: plain calendar-day
// arithmetic, with no clock and no time zone.

describe('viewDays', () => {
  it('shows one day in Day', () => {
    expect(viewDays('day', '2026-10-07', 30)).toEqual(['2026-10-07']);
  });

  it('shows the week from Monday to Sunday in Week', () => {
    expect(viewDays('week', '2026-10-07', 30)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
    // A Sunday belongs to the week that started the Monday before.
    expect(viewDays('week', '2026-10-11', 30)[0]).toBe('2026-10-05');
  });

  it('shows whole weeks covering the month in Month', () => {
    const october = viewDays('month', '2026-10-20', 30);
    // 1 October 2026 is a Thursday; 31 October a Saturday.
    expect(october[0]).toBe('2026-09-28');
    expect(october.at(-1)).toBe('2026-11-01');
    expect(october).toHaveLength(35);
    // February 2027 starts on a Monday and ends on a Sunday: exactly four weeks.
    expect(viewDays('month', '2027-02-14', 30)).toHaveLength(28);
  });

  it('shows the Agenda’s days from the day it starts', () => {
    const agenda = viewDays('agenda', '2026-10-05', 30);
    expect(agenda[0]).toBe('2026-10-05');
    expect(agenda).toHaveLength(30);
    expect(agenda.at(-1)).toBe('2026-11-03');
  });
});

describe('stepAnchor', () => {
  it('moves by a day, a week, a month or the Agenda’s days', () => {
    expect(stepAnchor('day', '2026-10-31', 1, 30)).toBe('2026-11-01');
    expect(stepAnchor('day', '2026-10-01', -1, 30)).toBe('2026-09-30');
    expect(stepAnchor('week', '2026-10-07', 1, 30)).toBe('2026-10-14');
    expect(stepAnchor('week', '2026-10-07', -1, 30)).toBe('2026-09-30');
    expect(stepAnchor('agenda', '2026-10-05', 1, 30)).toBe('2026-11-04');
  });

  it('moves a month to the same day of the next one, or its last day', () => {
    expect(stepAnchor('month', '2026-10-20', 1, 30)).toBe('2026-11-20');
    expect(stepAnchor('month', '2027-01-31', 1, 30)).toBe('2027-02-28');
    expect(stepAnchor('month', '2026-03-31', -1, 30)).toBe('2026-02-28');
    expect(stepAnchor('month', '2026-12-15', 1, 30)).toBe('2027-01-15');
    expect(stepAnchor('month', '2026-01-15', -1, 30)).toBe('2025-12-15');
  });
});

describe('rangeTitle', () => {
  it('reads each view’s range', () => {
    expect(rangeTitle('day', '2026-10-07', 30)).toBe('Wednesday 7 October 2026');
    expect(rangeTitle('week', '2026-10-07', 30)).toBe('5 – 11 October 2026');
    expect(rangeTitle('week', '2026-09-30', 30)).toBe('28 September – 4 October 2026');
    expect(rangeTitle('week', '2026-12-30', 30)).toBe('28 December 2026 – 3 January 2027');
    expect(rangeTitle('month', '2026-10-20', 30)).toBe('October 2026');
    expect(rangeTitle('agenda', '2026-10-05', 30)).toBe('5 October – 3 November 2026');
  });
});

describe('outsideSyncedWindow', () => {
  // Calendar sync keeps 30 days back and 12 months ahead.
  it('says when a range reaches before or after the synced window', () => {
    expect(outsideSyncedWindow(['2026-10-05', '2026-10-11'], '2026-10-05')).toEqual({
      before: false,
      after: false,
    });
    expect(outsideSyncedWindow(['2026-09-04', '2026-09-05'], '2026-10-05')).toEqual({
      before: true,
      after: false,
    });
    expect(outsideSyncedWindow(['2026-09-05', '2026-09-06'], '2026-10-05').before).toBe(false);
    expect(outsideSyncedWindow(['2027-10-05', '2027-10-06'], '2026-10-05').after).toBe(true);
    expect(outsideSyncedWindow(['2027-10-04', '2027-10-04'], '2026-10-05').after).toBe(false);
  });
});

describe('viewOf', () => {
  it('reads a saved view, and anything else as the Agenda', () => {
    expect(viewOf('week')).toBe('week');
    expect(viewOf('year')).toBe('agenda');
    expect(viewOf(null)).toBe('agenda');
  });
});
