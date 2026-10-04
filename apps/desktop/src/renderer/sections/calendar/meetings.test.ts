import type { OutlookAccountSummary } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { changesFrom, editorFor, lengthLabel, type MeetingDraft } from './meetings';

// A meeting card's draft (#132): what the User changed, as the gate takes it when accepting, and where
// Edit in… hands it off.

const draft: MeetingDraft = {
  title: 'Call with Leo',
  start: Date.UTC(2026, 9, 6, 13),
  end: Date.UTC(2026, 9, 6, 13, 30),
  account: 'google:alex',
  calendarId: 'alex@gmail.test',
  guests: [{ email: 'leo.park@acme.test', name: 'Leo Park' }],
  toFill: [],
  timeZone: 'Europe/London',
};

describe('a meeting draft', () => {
  it('unchanged, accepts as Ares proposed it', () => {
    expect(changesFrom(draft, { ...draft })).toEqual({});
  });

  it('names only what the User changed', () => {
    const later = { ...draft, start: draft.start + 3_600_000, end: draft.end + 3_600_000 };
    expect(changesFrom(draft, later)).toEqual({
      event: {
        start: { at: later.start, timeZone: 'Europe/London', date: null },
        end: { at: later.end, timeZone: 'Europe/London', date: null },
      },
    });
    expect(changesFrom(draft, { ...draft, account: 'outlook:t:u', calendarId: null })).toEqual({
      event: { account: 'outlook:t:u', calendarId: null },
    });
    // Guests to fill in that the User left blank are dropped, so the guests are always sent then.
    expect(changesFrom({ ...draft, toFill: ['Omar'] }, { ...draft, toFill: ['Omar'] })).toEqual({
      event: { attendees: draft.guests },
    });
  });

  it('reads lengths as people say them', () => {
    expect([15, 30, 60, 90, 120].map(lengthLabel)).toEqual(['15 min', '30 min', '1 h', '1 h 30 min', '2 h']);
  });

  it('hands an Outlook Account’s meeting to Outlook on the web’s compose page', () => {
    const sam = {
      id: 'outlook:t:u',
      source: 'outlook',
      userPrincipalName: 'sam@contoso.test',
      personal: false,
    } as OutlookAccountSummary;
    const { url, where } = editorFor({ ...draft, account: sam.id }, sam, 'From my Daily Note');
    expect(where).toBe('Outlook');
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://outlook.office.com/calendar/deeplink/compose');
    expect(parsed.searchParams.get('to')).toBe('leo.park@acme.test');
    expect(parsed.searchParams.get('body')).toBe('From my Daily Note');
    expect(parsed.searchParams.get('login_hint')).toBe('sam@contoso.test');
  });
});
