import type { EventDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type FieldChange, type StoredItem, WriteRejected } from '../source';
import { type CalendarChoices, createGoogleCalendarSource } from './google-calendar-source';
import rsvp from './recorded/rsvp.json';

// Answering invitations through Google Calendar (#129), against recorded Calendar API v3 responses:
// each recording pins down the requests Commander must send, in order, with their bodies.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const recorded = rsvp as unknown as Record<keyof typeof rsvp, Exchange[]>;

const API = 'https://calendar.test/calendar/v3';
const ACCOUNT = 'google:104512345678901234567';
const CALENDAR = { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7' };
// When the User answered: Monday 5 October 2026, 08:00 UTC.
const MADE_AT = Date.UTC(2026, 9, 5, 8);

const calendars: CalendarChoices = { listed: () => new Set(), held: () => [] };

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: { method: string; path: string; body: unknown; authorization: string | null }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(API.length));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path, body, authorization: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(body).toEqual(next.request.body);
    const { status, headers, body: answer } = next.response;
    return new Response(JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, remaining: () => queue.length };
}

const storedEvent = (externalId: string, detail: Partial<EventDetail> = {}): StoredItem => ({
  externalId,
  title: 'Pricing review',
  people: [],
  status: 'open',
  detail: {
    kind: 'event',
    calendar: CALENDAR,
    accountEmail: 'alex@gmail.test',
    start: { at: Date.UTC(2026, 9, 8, 14), timeZone: 'Europe/London', date: null },
    end: { at: Date.UTC(2026, 9, 8, 15), timeZone: 'Europe/London', date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: { email: 'dana@acme.test', name: 'Dana Reyes', self: false },
    attendees: [],
    myResponse: 'needs-action',
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: null,
    webUrl: null,
    createdByCommander: null,
    ...detail,
  },
});

async function write(exchanges: Exchange[], externalId: string, changes: FieldChange[], stored?: StoredItem) {
  const recording = replay(exchanges);
  const source = createGoogleCalendarSource({ apiUrl: () => API, calendars, fetch: recording.fetch });
  const result = await source.write?.({
    account: ACCOUNT,
    externalId,
    changes,
    stored: (ids) => (stored && ids.includes(stored.externalId) ? [stored] : []),
    accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

const ONE_OFF = 'alex@gmail.test/pr1c1ngrev1ew0ct08';
const INSTANCE = 'alex@gmail.test/w33klyp1ann1ng_20261008T140000Z';
const answered = (field: string, value: string, synced = 'needs-action'): FieldChange => ({
  field,
  value,
  synced,
  madeAt: MADE_AT,
});

describe('answering an invitation in Google Calendar', () => {
  it('patches only the User’s own answer, telling the organiser, and hands back the event', async () => {
    const { result, sent, remaining } = await write(
      recorded.accept,
      ONE_OFF,
      [answered('response', 'accepted')],
      storedEvent(ONE_OFF),
    );
    expect(remaining()).toBe(0);
    expect(sent.every((each) => each.authorization === 'Bearer ya29.recorded')).toBe(true);
    expect(result?.superseded).toEqual([]);
    expect(result?.cost.requests).toBe(2);
    expect(result?.item).toMatchObject({
      externalId: ONE_OFF,
      title: 'Pricing review',
      detail: { calendar: CALENDAR, myResponse: 'accepted', accountEmail: 'alex@gmail.test' },
    });
  });

  it('answers one instance of a series on its own', async () => {
    const { result, remaining } = await write(
      recorded.instance,
      INSTANCE,
      [answered('response', 'tentative', 'accepted')],
      storedEvent(INSTANCE, { seriesId: 'w33klyp1ann1ng', myResponse: 'accepted' }),
    );
    expect(remaining()).toBe(0);
    expect((result?.item?.detail as EventDetail | undefined)?.myResponse).toBe('tentative');
  });

  it('answers the whole series through the recurring event, then reads the instance again', async () => {
    const { result, remaining } = await write(
      recorded.series,
      INSTANCE,
      [answered('response', 'declined'), answered('seriesResponse', 'declined')],
      storedEvent(INSTANCE, { seriesId: 'w33klyp1ann1ng' }),
    );
    // The instance followed the series, so nothing more was sent for it.
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
    expect((result?.item?.detail as EventDetail | undefined)?.myResponse).toBe('declined');
  });

  it('sends nothing when an answer given in Google Calendar since is newer, and says when', async () => {
    const { result, remaining } = await write(
      recorded.superseded,
      ONE_OFF,
      [answered('response', 'accepted')],
      storedEvent(ONE_OFF),
    );
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([
      { field: 'response', by: null, at: Date.parse('2026-10-05T08:30:00.000Z') },
    ]);
    // Google's answer, to save with the note.
    expect((result?.item?.detail as EventDetail | undefined)?.myResponse).toBe('declined');
  });

  it('sends an answer made after Google’s last change, even when it differs from what Commander saw', async () => {
    const later = { ...answered('response', 'accepted'), madeAt: Date.parse('2026-10-05T09:00:00.000Z') };
    const exchanges = [...recorded.superseded, recorded.accept[1] as Exchange];
    const { result, remaining } = await write(exchanges, ONE_OFF, [later], storedEvent(ONE_OFF));
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
  });

  it('sends nothing for an answer Google already has (a retry whose first reply was lost)', async () => {
    const already = recorded.accept[1]?.response.body;
    const exchanges: Exchange[] = [
      {
        request: recorded.accept[0]?.request as Exchange['request'],
        response: { status: 200, headers: {}, body: already },
      },
    ];
    const { result, remaining } = await write(
      exchanges,
      ONE_OFF,
      [answered('response', 'accepted')],
      storedEvent(ONE_OFF),
    );
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
  });

  it('refuses an answer to an event no longer in Google Calendar, which retrying won’t fix', async () => {
    await expect(write(recorded.gone, ONE_OFF, [answered('response', 'accepted')])).rejects.toBeInstanceOf(
      WriteRejected,
    );
  });
});
