import { describe, expect, it } from 'vitest';
import { whenShort } from './when';

describe('when an activity entry happened, in short', () => {
  const now = new Date(2026, 9, 3, 16, 0).getTime();

  it('gives the time for today', () => {
    expect(whenShort(new Date(2026, 9, 3, 9, 5).getTime(), now)).toBe('09:05');
  });

  it('gives the day for earlier this year', () => {
    expect(whenShort(new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe('30 Sep');
  });

  it('adds the year for an earlier year', () => {
    expect(whenShort(new Date(2025, 11, 31, 9, 5).getTime(), now)).toBe('31 Dec 2025');
  });
});
