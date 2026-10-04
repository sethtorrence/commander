import { isDeepStrictEqual } from 'node:util';
import {
  type CommanderEventCreate,
  CREATE_FIELD,
  type EventDetail,
  pendingEventExternalId,
} from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarChoices } from '../google-calendar/google-calendar-source';
import type { AccessToken, SourceAdapter } from '../source';
import { createOutlookCalendarSource } from './outlook-calendar-source';
import recordings from './recorded/scheduling.json';

// The Outlook Calendar adapter for Ares's scheduler (#132), against recorded Microsoft Graph v1.0
// responses: making a meeting with guests (Outlook sends the invitations itself) and asking Graph for
// guests' free/busy in the User's work organisation (`getSchedule`, which personal accounts don't have).

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { method: string; path: string; body?: unknown }; response: Recorded };
const recorded = recordings as unknown as Record<string, Exchange[]>;

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const DEFAULT = 'AAMkAGI2-cal-default=';
const MEETING_ID = '5b7d9f1a-3c5e-4a7b-9d1f-2e4a6c8e0b3d';
const token: AccessToken = { token: 'eyJ0eXAiOi.recorded', kind: 'oauth' };

let problems: string[];
beforeEach(() => {
  problems = [];
});

const calendars: CalendarChoices = {
  listed: (_account, found) => new Set(found.map((each) => each.id)),
  held: () => [],
};

function script(name: string) {
  const queue = structuredClone(recorded[name] ?? []);
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const index = queue.findIndex((each) => each.request.method === method && each.request.path === path);
    if (index < 0) {
      problems.push(`Unexpected ${method} ${path}`);
      return new Response(null, { status: 599 });
    }
    const [next] = queue.splice(index, 1) as [Exchange];
    if (next.request.body !== undefined && !isDeepStrictEqual(next.request.body, body)) {
      problems.push(`${method} ${path} sent ${JSON.stringify(body)}`);
    }
    const { status, headers, body: content } = next.response;
    return new Response(content === null ? null : JSON.stringify(content), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

const adapter = (fetch: typeof globalThis.fetch): SourceAdapter =>
  createOutlookCalendarSource({ graphUrl: () => GRAPH, calendars, fetch, now: () => NOW });

const london = (hour: number) => ({ at: Date.UTC(2026, 9, 6, hour), timeZone: 'Europe/London', date: null });

describe('a meeting with guests', () => {
  it('goes on its calendar with the guests as required attendees, busy and not private', async () => {
    const recording = script('meeting');
    const meeting: CommanderEventCreate = {
      kind: 'meeting',
      calendarId: DEFAULT,
      commanderId: MEETING_ID,
      title: 'Pricing review',
      start: london(13),
      end: london(14),
      allDay: false,
      attendees: [
        { email: 'dana@contoso.test', name: 'Dana Whitfield' },
        { email: 'leo@acme.test', name: null },
      ],
    };
    const result = await adapter(recording.fetch).write?.({
      account: ACCOUNT,
      externalId: pendingEventExternalId(MEETING_ID),
      changes: [{ field: CREATE_FIELD, value: meeting, synced: null, madeAt: NOW }],
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(problems).toEqual([]);
    expect(recording.remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: 'AAMkAGI2-evt-meet1=', commanderItemId: MEETING_ID });
    const detail = result?.item?.detail as EventDetail;
    expect(detail).toMatchObject({ private: false, busy: true, createdByCommander: 'meeting' });
    expect(detail.attendees.map((each) => each.email)).toEqual(['dana@contoso.test', 'leo@acme.test']);
  });
});

describe('guests’ free/busy', () => {
  const from = Date.UTC(2026, 9, 5, 23);
  const to = Date.UTC(2026, 9, 7, 23);

  it('asks getSchedule, counting busy, tentative and away as busy, and says whom Graph couldn’t find', async () => {
    const recording = script('get-schedule');
    const result = await adapter(recording.fetch).freeBusy?.({
      account: ACCOUNT,
      emails: ['dana@contoso.test', 'nobody@contoso.test'],
      from,
      to,
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(problems).toEqual([]);
    expect(result?.calendars).toEqual([
      {
        email: 'dana@contoso.test',
        busy: [
          { start: Date.UTC(2026, 9, 6, 9), end: Date.UTC(2026, 9, 6, 10) },
          { start: Date.UTC(2026, 9, 7, 0), end: Date.UTC(2026, 9, 7, 12) },
        ],
        problem: null,
      },
      {
        email: 'nobody@contoso.test',
        busy: null,
        problem: 'The specified email address could not be found.',
      },
    ]);
  });

  it('refused, says so for every guest rather than failing', async () => {
    const recording = script('get-schedule-forbidden');
    const result = await adapter(recording.fetch).freeBusy?.({
      account: ACCOUNT,
      emails: ['dana@contoso.test'],
      from,
      to,
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
    expect(result?.calendars).toEqual([
      { email: 'dana@contoso.test', busy: null, problem: 'Microsoft wouldn’t share free/busy.' },
    ]);
  });
});
