import { describe, expect, it } from 'vitest';
import { readAtOf } from './shapes';

describe('readAtOf', () => {
  it('reads a real last-read time', () => {
    expect(readAtOf('2026-10-05T14:02:00Z')).toBe(Date.UTC(2026, 9, 5, 14, 2));
  });

  it.each([
    ["Graph's never-read placeholder", '0001-01-01T00:00:00Z'],
    ['a time before 1970', '1969-12-31T23:59:59Z'],
    ['nothing', null],
    ['an empty string', ''],
    ['something that is not a date', 'yesterday'],
  ])('treats %s as never read', (_case, value) => {
    expect(readAtOf(value)).toBeNull();
  });
});
