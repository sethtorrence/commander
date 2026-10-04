import type { EventDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import type { CalendarChoices } from '../google-calendar/google-calendar-source';
import { type FieldChange, type StoredItem, WriteRejected } from '../source';
import { createOutlookCalendarSource } from './outlook-calendar-source';
import rsvp from './recorded/rsvp.json';

// Answering invitations through Outlook (#129), against recorded Microsoft Graph v1.0 responses:
// each recording pins down the requests Commander must send, in order, with their bodies.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const recorded = rsvp as unknown as Record<keyof typeof rsvp, Exchange[]>;

const GRAPH = 'https://graph.test/v1.0';
const ACCOUNT = 'outlook:tenant-contoso:sam';
const CALENDAR = { id: 'AAMkAGI2-cal-default=', name: 'Calendar', colour: '#0078d4' };
const MADE_AT = Date.UTC(2026, 9, 5, 8);

const calendars: CalendarChoices = { listed: () => new Set(), held: () => [] };

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: { method: string; path: string; prefer: string | null }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path, prefer: new Headers(init?.headers).get('prefer') });
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(body).toEqual(next.request.body);
    const { status, headers, body: answer } = next.response;
    return new Response(answer === null ? null : JSON.stringify(answer), { status, headers });
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
    accountEmail: 'sam@contoso.test',
    start: { at: Date.UTC(2026, 9, 8, 14), timeZone: 'Europe/London', date: null },
    end: { at: Date.UTC(2026, 9, 8, 15), timeZone: 'Europe/London', date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: { email: 'dana@contoso.test', name: 'Dana Reyes', self: false },
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
  const source = createOutlookCalendarSource({ graphUrl: () => GRAPH, calendars, fetch: recording.fetch });
  const result = await source.write?.({
    account: ACCOUNT,
    externalId,
    changes,
    stored: (ids) => (stored && ids.includes(stored.externalId) ? [stored] : []),
    accessToken: async () => ({ token: 'eyJ0.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

const ONE_OFF = 'AAMkAGI2-evt-pricing=';
const INSTANCE = 'AAMkAGI2-evt-weekly-20261008=';
const answered = (field: string, value: string, synced = 'needs-action'): FieldChange => ({
  field,
  value,
  synced,
  madeAt: MADE_AT,
});

describe('answering an invitation in Outlook', () => {
  it('accepts, telling the organiser, then reads the event back to hand over', async () => {
    const { result, sent, remaining } = await write(
      recorded.accept,
      ONE_OFF,
      [answered('response', 'accepted')],
      storedEvent(ONE_OFF),
    );
    expect(remaining()).toBe(0);
    // Immutable ids, as calendar sync reads them.
    expect(sent.every((each) => each.prefer?.includes('IdType="ImmutableId"'))).toBe(true);
    expect(result?.superseded).toEqual([]);
    expect(result?.cost.requests).toBe(3);
    expect(result?.item).toMatchObject({
      externalId: ONE_OFF,
      detail: { calendar: CALENDAR, myResponse: 'accepted', accountEmail: 'sam@contoso.test' },
    });
  });

  it('declines one instance of a series on its own', async () => {
    const { result, remaining } = await write(
      recorded.instance,
      INSTANCE,
      [answered('response', 'declined', 'accepted')],
      storedEvent(INSTANCE, { seriesId: 'AAMkAGI2-evt-weekly-master=', myResponse: 'accepted' }),
    );
    expect(remaining()).toBe(0);
    expect((result?.item?.detail as EventDetail | undefined)?.myResponse).toBe('declined');
  });

  it('answers the whole series through its series master, then reads the instance again', async () => {
    const { result, remaining } = await write(
      recorded.series,
      INSTANCE,
      [answered('response', 'tentative'), answered('seriesResponse', 'tentative')],
      storedEvent(INSTANCE, { seriesId: 'AAMkAGI2-evt-weekly-master=' }),
    );
    expect(remaining()).toBe(0);
    expect((result?.item?.detail as EventDetail | undefined)?.myResponse).toBe('tentative');
  });

  it('sends nothing when an answer given in Outlook since is newer, and says when', async () => {
    const { result, remaining } = await write(
      recorded.superseded,
      ONE_OFF,
      [answered('response', 'accepted')],
      storedEvent(ONE_OFF),
    );
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([
      { field: 'response', by: null, at: Date.parse('2026-10-05T08:30:00Z') },
    ]);
    expect((result?.item?.detail as EventDetail | undefined)?.myResponse).toBe('declined');
  });

  it('can’t take an answer back to “not answered”, which Outlook has no way to do', async () => {
    const exchanges = [recorded.accept[2] as Exchange];
    await expect(
      write(exchanges, ONE_OFF, [answered('response', 'needs-action', 'accepted')], storedEvent(ONE_OFF)),
    ).rejects.toThrow(WriteRejected);
  });

  it('refuses an answer to an event no longer in Outlook, which retrying won’t fix', async () => {
    await expect(write(recorded.gone, ONE_OFF, [answered('response', 'accepted')])).rejects.toBeInstanceOf(
      WriteRejected,
    );
  });
});
