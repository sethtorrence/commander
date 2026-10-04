import {
  type CommanderEventCreate,
  CREATE_FIELD,
  DELETE_FIELD,
  type EventDetail,
  pendingEventExternalId,
} from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessToken, FieldChange, StoredItem } from '../source';
import { type CalendarChoices, createGoogleCalendarSource } from './google-calendar-source';
import recordings from './recorded/scheduling.json';

// The Google Calendar adapter for Ares's scheduler (#132), against recorded Calendar API v3 responses:
// making a meeting with guests (Google sends the invitations, `sendUpdates=all`), taking it back again
// (Google tells the guests), and asking Google for guests' free/busy (`freeBusy.query`).

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { method: string; path: string; body?: unknown }; response: Recorded };
const recorded = recordings as unknown as Record<keyof typeof recordings, Exchange>;

const API = 'https://calendar.test/calendar/v3';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const MEETING_ID = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MEETING_EVENT = '9c8b7a6d5e4f4a3b8c2d1e0f9a8b7c6d';
const token: AccessToken = { token: 'ya29.recorded', kind: 'oauth' };

let problems: string[];
beforeEach(() => {
  problems = [];
});

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(API.length));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const next = queue.shift();
    if (!next || next.request.method !== method || next.request.path !== path) {
      problems.push(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
      return new Response(null, { status: 599 });
    }
    if (next.request.body !== undefined && JSON.stringify(body) !== JSON.stringify(next.request.body)) {
      problems.push(`${method} ${path} sent ${JSON.stringify(body)}`);
    }
    const { status, headers, body: answer } = next.response;
    return new Response(answer === null ? null : JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

const calendars: CalendarChoices = { listed: () => new Set(), held: () => [] };

const london = (hour: number, minute = 0) => ({
  at: Date.UTC(2026, 9, 6, hour, minute),
  timeZone: 'Europe/London',
  date: null,
});

const meeting: CommanderEventCreate = {
  kind: 'meeting',
  calendarId: PRIMARY,
  commanderId: MEETING_ID,
  title: 'Call with Leo',
  start: london(13),
  end: london(13, 30),
  allDay: false,
  attendees: [
    { email: 'leo.park@acme.test', name: 'Leo Park' },
    { email: 'dana@titanlink.test', name: null },
  ],
};

const change = (field: string, value: unknown): FieldChange => ({ field, value, synced: null, madeAt: NOW });

describe('a meeting with guests', () => {
  it('goes on its calendar with the guests, and Google invites them', async () => {
    const recording = replay([recorded.insertMeeting]);
    const source = createGoogleCalendarSource({
      apiUrl: () => API,
      calendars,
      fetch: recording.fetch,
      now: () => NOW,
    });
    const result = await source.write?.({
      account: ACCOUNT,
      externalId: pendingEventExternalId(MEETING_ID),
      changes: [change(CREATE_FIELD, meeting)],
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(problems).toEqual([]);
    expect(recording.remaining()).toBe(0);
    expect(result?.item).toMatchObject({
      externalId: `${PRIMARY}/${MEETING_EVENT}`,
      title: 'Call with Leo',
      commanderItemId: MEETING_ID,
    });
    const detail = result?.item?.detail as EventDetail;
    expect(detail).toMatchObject({
      busy: true,
      private: false,
      organiser: { email: PRIMARY, self: true },
      createdByCommander: 'meeting',
    });
    expect(detail.attendees.map((each) => [each.email, each.response])).toEqual([
      ['alex@gmail.test', 'accepted'],
      ['leo.park@acme.test', 'needs-action'],
      ['dana@titanlink.test', 'needs-action'],
    ]);
  });

  it('taken back, is deleted with Google telling the guests', async () => {
    const recording = replay([recorded.deleteMeeting]);
    const source = createGoogleCalendarSource({
      apiUrl: () => API,
      calendars,
      fetch: recording.fetch,
      now: () => NOW,
    });
    const externalId = `${PRIMARY}/${MEETING_EVENT}`;
    const stored: StoredItem = {
      externalId,
      title: 'Call with Leo',
      people: [],
      status: 'open',
      detail: { kind: 'event', createdByCommander: 'meeting' } as unknown as EventDetail,
    };
    const result = await source.write?.({
      account: ACCOUNT,
      externalId,
      changes: [change(DELETE_FIELD, true)],
      stored: () => [stored],
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(problems).toEqual([]);
    expect(recording.remaining()).toBe(0);
    expect(result?.item).toBeNull();
  });
});

describe('guests’ free/busy', () => {
  const from = Date.UTC(2026, 9, 5, 23);
  const to = Date.UTC(2026, 9, 7, 23);

  it('asks freeBusy.query, and says whose calendar Google wouldn’t share', async () => {
    const recording = replay([recorded.freeBusy]);
    const source = createGoogleCalendarSource({
      apiUrl: () => API,
      calendars,
      fetch: recording.fetch,
      now: () => NOW,
    });
    const result = await source.freeBusy?.({
      account: ACCOUNT,
      emails: ['priya@titanlink.test', 'omar@titanlink.test'],
      from,
      to,
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(problems).toEqual([]);
    expect(result?.calendars).toEqual([
      {
        email: 'priya@titanlink.test',
        busy: [
          { start: Date.UTC(2026, 9, 6, 8), end: Date.UTC(2026, 9, 6, 9, 30) },
          { start: Date.UTC(2026, 9, 6, 13), end: Date.UTC(2026, 9, 6, 14) },
        ],
        problem: null,
      },
      { email: 'omar@titanlink.test', busy: null, problem: 'Google doesn’t share this calendar with you.' },
    ]);
    expect(result?.cost.requests).toBe(1);
  });

  it('refused, says so for every guest rather than failing', async () => {
    const recording = replay([recorded.freeBusyForbidden]);
    const source = createGoogleCalendarSource({
      apiUrl: () => API,
      calendars,
      fetch: recording.fetch,
      now: () => NOW,
    });
    const result = await source.freeBusy?.({
      account: ACCOUNT,
      emails: ['priya@titanlink.test'],
      from,
      to,
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(result?.calendars).toEqual([
      { email: 'priya@titanlink.test', busy: null, problem: 'Google wouldn’t share free/busy (HTTP 403).' },
    ]);
  });
});
