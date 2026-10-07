import { describe, expect, it } from 'vitest';
import { parseInvitation } from './ics';
import { readGmailMessage } from './message';
import recorded from './recorded/invitation.json';
import type { GmailMessage } from './shapes';

// The calendar invitation a Gmail message carries (#144): its text/calendar part read into what finds
// the event (the method, UID, title and times), over a recorded Google Calendar invitation and its
// cancellation, and the iCalendar shapes other calendars write (a Windows zone from Outlook, a date
// alone, a duration, folded and escaped lines).

const LABELS = new Map<string, string>();
const read = (message: unknown) => readGmailMessage(message as GmailMessage, LABELS);

describe('a Google Calendar invitation (recorded)', () => {
  it('reads its method, UID, title and times from the inline calendar part', () => {
    const item = read(recorded.invitation.response.body);
    const detail = item.detail?.kind === 'email' ? item.detail : null;
    expect(detail?.hasInvitation).toBe(true);
    expect(detail?.invitation).toEqual({
      method: 'request',
      uid: '5k2m8q1v7c3n9b0x4r6t2p8s1d@google.com',
      eventId: null,
      title: 'Pricing review',
      start: Date.parse('2026-10-08T14:00:00Z'),
      end: Date.parse('2026-10-08T15:00:00Z'),
      allDay: false,
    });
    // The attached invite.ics is still listed as an attachment, as before.
    expect(detail?.attachments.map((each) => each.name)).toEqual(['invite.ics']);
  });

  it('reads a cancellation as one', () => {
    const item = read(recorded.cancellation.response.body);
    expect(item.detail?.kind === 'email' && item.detail.invitation?.method).toBe('cancel');
  });
});

describe('parseInvitation', () => {
  it('reads a time in a Windows zone as Outlook writes it', () => {
    const found = parseInvitation(
      [
        'BEGIN:VCALENDAR',
        'METHOD:REQUEST',
        'BEGIN:VTIMEZONE',
        'TZID:GMT Standard Time',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:040000008200E00074C5B7101A82E00800000000',
        'SUMMARY;LANGUAGE=en-GB:Board prep',
        'DTSTART;TZID=GMT Standard Time:20261008T093000',
        'DTEND;TZID=GMT Standard Time:20261008T103000',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    // 09:30 in London in October is 08:30 UTC.
    expect(found?.start).toBe(Date.parse('2026-10-08T08:30:00Z'));
    expect(found?.end).toBe(Date.parse('2026-10-08T09:30:00Z'));
    expect(found?.title).toBe('Board prep');
    expect(found?.uid).toBe('040000008200E00074C5B7101A82E00800000000');
  });

  it('reads an all-day event, a duration, folded lines and escapes', () => {
    const allDay = parseInvitation(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a1\nSUMMARY:Offsite\\, day one\nDTSTART;VALUE=DATE:20261012\nEND:VEVENT\nEND:VCALENDAR',
    );
    expect(allDay).toMatchObject({
      method: 'request',
      title: 'Offsite, day one',
      start: Date.UTC(2026, 9, 12),
      end: Date.UTC(2026, 9, 13),
      allDay: true,
    });
    const timed = parseInvitation(
      'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:b2\r\nSUMMARY:Call with\r\n  Leo\r\nDTSTART:20261008T150000Z\r\nDURATION:PT45M\r\nEND:VEVENT\r\nEND:VCALENDAR',
    );
    expect(timed).toMatchObject({
      title: 'Call with Leo',
      start: Date.parse('2026-10-08T15:00:00Z'),
      end: Date.parse('2026-10-08T15:45:00Z'),
    });
  });

  it('leaves what it can’t read null, and finds nothing without an event', () => {
    expect(parseInvitation('BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR')).toBeNull();
    expect(parseInvitation('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:soon\nEND:VEVENT\nEND:VCALENDAR')).toEqual(
      {
        method: 'request',
        uid: null,
        eventId: null,
        title: null,
        start: null,
        end: null,
        allDay: false,
      },
    );
  });
});
