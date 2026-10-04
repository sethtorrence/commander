import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateOf,
  dayKey,
  dayLabel,
  longDate,
  notePartNumber,
  weekday,
  weekOf,
  weekRange,
} from './days';

describe('days', () => {
  it('are keyed by their local date', () => {
    expect(dayKey(new Date(2026, 9, 3, 23, 59))).toBe('2026-10-03');
    expect(dayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    expect(dateOf('2026-10-03')).toEqual(new Date(2026, 9, 3));
  });

  it('step across months, years and daylight-saving changes', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('are written out as the sheets show them', () => {
    expect(weekday('2026-10-01')).toBe('Thursday');
    expect(longDate('2026-10-01')).toBe('1 October 2026');
    expect(notePartNumber('2026-10-01')).toBe('DN-2026-274');
    expect(notePartNumber('2026-10-03')).toBe('DN-2026-276');
  });

  it('say how long ago they were', () => {
    expect(dayLabel('2026-10-03', '2026-10-03')).toBe('Today');
    expect(dayLabel('2026-10-02', '2026-10-03')).toBe('Yesterday');
    expect(dayLabel('2026-10-01', '2026-10-03')).toBe('2 days ago');
  });

  it('say how far ahead they are (a day opened from a [[day]] chip)', () => {
    expect(dayLabel('2026-10-04', '2026-10-03')).toBe('Tomorrow');
    expect(dayLabel('2026-10-09', '2026-10-03')).toBe('In 6 days');
  });

  it('belong to a week from Monday to Sunday', () => {
    expect(weekOf('2026-10-01')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(weekOf('2026-10-04')[0]).toBe('2026-09-28');
    expect(weekRange('2026-10-01')).toBe('28 Sep — 04 Oct');
  });
});
