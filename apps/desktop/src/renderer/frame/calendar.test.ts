import { describe, expect, it } from 'vitest';
import { clockTime, dayOfYear, isoWeek, partNumber, shortDate } from './calendar';

// Local dates, as the header shows them.
const day = (y: number, m: number, d: number, h = 9, min = 5, s = 7) => new Date(y, m - 1, d, h, min, s);

describe('the drawing calendar', () => {
  it('numbers the day of the year, counting 29 February in leap years', () => {
    expect(dayOfYear(day(2026, 1, 1))).toBe(1);
    expect(dayOfYear(day(2026, 10, 1))).toBe(274); // the prototypes' Thursday 1 October
    expect(dayOfYear(day(2024, 12, 31, 23, 59))).toBe(366);
  });

  it('numbers ISO weeks, which start on Monday and may belong to the neighbouring year', () => {
    expect(isoWeek(day(2026, 10, 1))).toBe(40);
    expect(isoWeek(day(2026, 1, 1))).toBe(1);
    expect(isoWeek(day(2027, 1, 1))).toBe(53); // a Friday, still in 2026's last week
    expect(isoWeek(day(2024, 12, 30))).toBe(1); // a Monday, already 2025's first week
  });

  it("stamps a sheet's part number with its code, the year and the day", () => {
    expect(partNumber('DSH', day(2026, 10, 1))).toBe('DSH-2026-274');
    expect(partNumber('TDO', day(2026, 1, 9))).toBe('TDO-2026-009');
  });

  it('writes the date and clock the way the header shows them', () => {
    expect(shortDate(day(2026, 10, 1))).toBe('Thu 01 Oct');
    expect(clockTime(day(2026, 10, 1, 9, 5, 7))).toBe('09:05:07');
  });
});
