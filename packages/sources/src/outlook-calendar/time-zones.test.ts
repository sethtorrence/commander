import { describe, expect, it } from 'vitest';
import { ianaZone, zonedInstant } from './time-zones';

describe('time zone names', () => {
  it('turns Windows time zone names (as Outlook writes them) into IANA ones', () => {
    expect(ianaZone('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(ianaZone('GMT Standard Time')).toBe('Europe/London');
    expect(ianaZone('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(ianaZone('AUS Eastern Standard Time')).toBe('Australia/Sydney');
    expect(ianaZone('india standard time')).toBe('Asia/Kolkata');
  });

  it('keeps IANA names, takes Microsoft’s UTC for UTC, and gives up on custom or unknown zones', () => {
    expect(ianaZone('Europe/Paris')).toBe('Europe/Paris');
    expect(ianaZone('UTC')).toBe('UTC');
    expect(ianaZone('tzone://Microsoft/Utc')).toBe('UTC');
    expect(ianaZone('tzone://Microsoft/Custom')).toBeNull();
    expect(ianaZone('Customized Time Zone')).toBeNull();
    expect(ianaZone('Not/AZone')).toBeNull();
    expect(ianaZone('')).toBeNull();
    expect(ianaZone(null)).toBeNull();
  });

  it('knows every zone it maps to', () => {
    for (const name of [
      'Dateline Standard Time',
      'Line Islands Standard Time',
      'Chatham Islands Standard Time',
    ]) {
      const zone = ianaZone(name);
      expect(zone).not.toBeNull();
      expect(() => new Intl.DateTimeFormat('en', { timeZone: zone ?? '' })).not.toThrow();
    }
  });
});

describe('wall-clock times in a zone', () => {
  it('reads Graph’s UTC times (seven decimals, no offset)', () => {
    expect(zonedInstant('2026-10-06T14:00:00.0000000', 'UTC')).toBe(Date.UTC(2026, 9, 6, 14));
  });

  it('reads a time given in a Windows zone, either side of a clock change', () => {
    // New York is UTC-4 in October and UTC-5 in December.
    expect(zonedInstant('2026-10-06T10:00:00.0000000', 'Eastern Standard Time')).toBe(
      Date.UTC(2026, 9, 6, 14),
    );
    expect(zonedInstant('2026-12-01T10:00:00.0000000', 'Eastern Standard Time')).toBe(
      Date.UTC(2026, 11, 1, 15),
    );
    expect(zonedInstant('2026-07-01T09:30:00', 'Europe/London')).toBe(Date.UTC(2026, 6, 1, 8, 30));
  });

  it('honours an offset written into the time itself, and takes an unknown zone for UTC', () => {
    expect(zonedInstant('2026-10-06T10:00:00-04:00', 'Pacific Standard Time')).toBe(Date.UTC(2026, 9, 6, 14));
    expect(zonedInstant('2026-10-06T10:00:00.0000000', 'tzone://Microsoft/Custom')).toBe(
      Date.UTC(2026, 9, 6, 10),
    );
  });

  it('answers NaN for a time it can’t read', () => {
    expect(zonedInstant('soon', 'UTC')).toBeNaN();
    expect(zonedInstant(null, 'UTC')).toBeNaN();
  });
});
