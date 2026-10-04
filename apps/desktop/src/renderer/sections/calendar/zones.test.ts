import { describe, expect, it } from 'vitest';
import { eventZoneNote, hereAndThere, isTimeZone, secondZoneHours, zoneName } from './zones';

// The second time zone (#127): its name, its column of hours beside the time grid, the detail
// pane's "15:00 here · 10:00 New York", and the note on an event set in another zone.

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const KOLKATA = 'Asia/Kolkata';

describe('zoneName', () => {
  it('names a zone by its city', () => {
    expect(zoneName(NEW_YORK)).toBe('New York');
    expect(zoneName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneName('UTC')).toBe('UTC');
  });
});

describe('isTimeZone', () => {
  it('knows a time zone from anything else', () => {
    expect(isTimeZone(NEW_YORK)).toBe(true);
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});

describe('hereAndThere', () => {
  it('reads an instant in the User’s zone and the second one', () => {
    expect(hereAndThere(Date.parse('2026-10-05T14:00:00Z'), LONDON, NEW_YORK)).toBe(
      '15:00 here · 10:00 New York',
    );
  });

  it('says when it is another day there', () => {
    expect(hereAndThere(Date.parse('2026-10-05T23:30:00Z'), LONDON, KOLKATA)).toBe(
      '00:30 here · 05:00 Kolkata',
    );
    expect(hereAndThere(Date.parse('2026-10-05T22:30:00Z'), LONDON, KOLKATA)).toBe(
      '23:30 here · 04:00 Kolkata (+1 day)',
    );
    expect(hereAndThere(Date.parse('2026-10-05T03:00:00Z'), LONDON, NEW_YORK)).toBe(
      '04:00 here · 23:00 New York (−1 day)',
    );
  });
});

describe('secondZoneHours', () => {
  it('gives the second zone’s time at each of the day’s hours', () => {
    const hours = secondZoneHours('2026-10-05', LONDON, NEW_YORK);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe('19:00');
    expect(hours[9]).toBe('04:00');
    expect(hours[15]).toBe('10:00');
  });

  it('keeps half-hour zones exact', () => {
    expect(secondZoneHours('2026-10-05', LONDON, KOLKATA)[9]).toBe('13:30');
  });

  it('follows the second zone’s own change of clocks', () => {
    // New York goes back on 1 November 2026; London went back a week earlier.
    expect(secondZoneHours('2026-10-30', LONDON, NEW_YORK)[9]).toBe('05:00');
    expect(secondZoneHours('2026-11-02', LONDON, NEW_YORK)[9]).toBe('04:00');
  });
});

describe('eventZoneNote', () => {
  const at = Date.parse('2026-10-05T14:00:00Z');
  const ends = Date.parse('2026-10-05T15:00:00Z');

  it('says when an event was set in a zone whose clocks differ from the User’s', () => {
    expect(eventZoneNote({ start: at, end: ends, timeZone: NEW_YORK }, LONDON)).toBe(
      'Set in New York time: 10:00–11:00 there',
    );
  });

  it('says nothing for the User’s own zone, or one that keeps the same time', () => {
    expect(eventZoneNote({ start: at, end: ends, timeZone: LONDON }, LONDON)).toBeNull();
    expect(eventZoneNote({ start: at, end: ends, timeZone: 'Europe/Dublin' }, LONDON)).toBeNull();
    expect(eventZoneNote({ start: at, end: ends, timeZone: null }, LONDON)).toBeNull();
    expect(eventZoneNote({ start: at, end: ends, timeZone: 'Not/AZone' }, LONDON)).toBeNull();
  });
});
