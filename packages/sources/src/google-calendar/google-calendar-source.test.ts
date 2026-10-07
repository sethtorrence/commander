import { calendarOnByDefault, type EventDetail, type SourceItem } from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AccessToken, CursorExpired, RateLimited, SignInRefused, type SyncPage } from '../source';
import {
  type CalendarChoices,
  createGoogleCalendarSource,
  GOOGLE_CALENDAR_CADENCE,
  type GoogleCalendarCursor,
} from './google-calendar-source';
import expired from './recorded/expired.json';
import firstSync from './recorded/first-sync.json';
import incremental from './recorded/incremental.json';
import quiet from './recorded/quiet.json';
import seriesCancelled from './recorded/series-cancelled.json';
import type { ListedCalendar } from './shapes';

// The Google Calendar adapter against recorded Calendar API v3 responses (shaped as Google answers),
// each recording also pinning down the request Commander must send for it, in order.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { path: string }; response: Recorded };

const API = 'https://calendar.test/calendar/v3';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const STANDUPS = 'c_tl_standups@group.calendar.google.com';
const HOLIDAYS = 'en.uk#holiday@group.v.calendar.google.com';
const token: AccessToken = { token: 'ya29.recorded', kind: 'oauth' };

// What the Item store holds (live events), and the calendars it was told about.
let held: Map<string, SourceItem>;
let listed: ListedCalendar[];
// The User's switches: calendar id → on.
let switched: Map<string, boolean>;
let sent: { path: string; authorization: string | null }[];

beforeEach(() => {
  held = new Map();
  listed = [];
  switched = new Map();
  sent = [];
});

const calendars: CalendarChoices = {
  listed(_account, found) {
    listed = found;
    return new Set(
      found.filter((each) => switched.get(each.id) ?? calendarOnByDefault(each)).map((each) => each.id),
    );
  },
  held(_account, calendarId) {
    return [...held.values()]
      .filter((item) => (item.detail as EventDetail).calendar.id === calendarId)
      .map((item) => ({
        externalId: item.externalId,
        title: item.title,
        people: item.people ?? [],
        status: 'open',
        detail: item.detail ?? null,
      }));
  },
};

// Answers each request with the next recording, after checking it is the request recorded.
function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(API.length));
    sent.push({ path, authorization: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (next?.request.path !== path)
      throw new Error(`Unexpected request ${path}, wanted ${next?.request.path}`);
    const { status, headers, body } = next.response;
    return new Response(body === null ? '' : JSON.stringify(body), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

async function sync(fetch: typeof globalThis.fetch, cursor: unknown = null, now = NOW) {
  const pages: SyncPage[] = [];
  const source = createGoogleCalendarSource({ apiUrl: () => API, calendars, fetch, now: () => now });
  const result = await source.sync({
    account: ACCOUNT,
    cursor,
    mode: 'full',
    accessToken: async () => token,
    save: (page) => {
      pages.push(page);
      for (const item of page.items) held.set(item.externalId, item);
      for (const id of page.deleted) held.delete(id);
    },
    signal: new AbortController().signal,
  });
  return {
    cursor: result.cursor as GoogleCalendarCursor,
    cost: result.cost,
    pages,
    items: pages.flatMap((page) => page.items),
    deleted: pages.flatMap((page) => page.deleted),
  };
}

const eventOf = (externalId: string) => held.get(externalId);
const detailOf = (externalId: string) => eventOf(externalId)?.detail as EventDetail;

async function afterFirstSync() {
  const { cursor } = await sync(replay(firstSync as Exchange[]).fetch);
  sent = [];
  return cursor;
}

describe('the first sync', () => {
  it('lists every calendar (page by page), and reads those on from 30 days back to 12 months ahead', async () => {
    const recorded = replay(firstSync as Exchange[]);
    const { cursor, cost } = await sync(recorded.fetch);

    expect(recorded.remaining()).toBe(0);
    expect(cost.requests).toBe(5);
    expect(sent.every((request) => request.authorization === 'Bearer ya29.recorded')).toBe(true);
    expect(listed).toEqual([
      { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
      { id: STANDUPS, name: 'Titanlink Standups', colour: '#33b679', primary: false, accessRole: 'owner' },
      {
        id: HOLIDAYS,
        name: 'Holidays in United Kingdom',
        colour: '#16a765',
        primary: false,
        accessRole: 'reader',
      },
    ]);
    // The holidays calendar is subscribed, so off until the User switches it on: never read.
    expect(sent.some((request) => request.path.includes(HOLIDAYS))).toBe(false);
    expect(sent[2]?.path).toContain('timeMin=2026-09-03T12:00:00.000Z&timeMax=2027-10-03T12:00:00.000Z');
    expect(cursor).toEqual({
      calendars: { [PRIMARY]: { syncToken: 'sync-primary-1' }, [STANDUPS]: { syncToken: 'sync-standups-1' } },
    });
    expect([...held.keys()].sort()).toEqual([
      `${PRIMARY}/commanderfocus412`,
      `${PRIMARY}/dentist2026`,
      `${PRIMARY}/designreview1`,
      `${PRIMARY}/localfirstconf`,
      `${STANDUPS}/standup_20261005T080000Z`,
      `${STANDUPS}/standup_20261006T080000Z`,
    ]);
  });

  it('keeps every field of an event: times with their zones, people, responses, the meeting link and the web link', async () => {
    await afterFirstSync();
    const review = eventOf(`${PRIMARY}/designreview1`);
    expect(review).toMatchObject({
      kind: 'event',
      title: 'Design review: onboarding',
      status: 'open',
      people: ['dana@titanlink.test', 'alex@gmail.test', 'leo@titanlink.test'],
    });
    expect(review?.detail).toEqual({
      kind: 'event',
      calendar: { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
      accountEmail: PRIMARY,
      start: { at: Date.UTC(2026, 9, 6, 14), timeZone: 'America/New_York', date: null },
      end: { at: Date.UTC(2026, 9, 6, 15), timeZone: 'America/New_York', date: null },
      allDay: false,
      location: 'Room 4',
      description: 'Walk through the new onboarding flow.\nNotes: https://docs.example.test/onboarding',
      organiser: { email: 'dana@titanlink.test', name: 'Dana Ruiz', self: false },
      attendees: [
        {
          email: 'dana@titanlink.test',
          name: 'Dana Ruiz',
          self: false,
          response: 'accepted',
          organiser: true,
          optional: false,
          resource: false,
        },
        {
          email: PRIMARY,
          name: null,
          self: true,
          response: 'needs-action',
          organiser: false,
          optional: false,
          resource: false,
        },
        {
          email: 'leo@titanlink.test',
          name: 'Leo Park',
          self: false,
          response: 'tentative',
          organiser: false,
          optional: true,
          resource: false,
        },
        {
          email: 'c_room4@resource.calendar.google.com',
          name: 'Room 4',
          self: false,
          response: 'accepted',
          organiser: false,
          optional: false,
          resource: true,
        },
      ],
      myResponse: 'needs-action',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      busy: true,
      private: false,
      seriesId: null,
      webUrl: 'https://www.google.com/calendar/event?eid=ZGVzaWducmV2aWV3MSBhbGV4QGdtYWlsLnRlc3Q',
      createdByCommander: null,
      icalUid: 'designreview1@google.com',
    } satisfies EventDetail);
  });

  it('turns an HTML description into plain text: links kept with their address, an image only named, scripts gone', async () => {
    await afterFirstSync();
    expect(detailOf(`${PRIMARY}/dentist2026`)).toMatchObject({
      description: 'Bring the form.\n\nForm (https://example.test/form)\n\n[image]',
      private: true,
      myResponse: null,
      organiser: { email: PRIMARY, name: null, self: true },
    });
  });

  it('keeps all-day events by their days (the end day exclusive), free time, and Commander’s own focus blocks', async () => {
    await afterFirstSync();
    expect(detailOf(`${PRIMARY}/localfirstconf`)).toMatchObject({
      allDay: true,
      start: { at: Date.UTC(2026, 9, 12), timeZone: null, date: '2026-10-12' },
      end: { at: Date.UTC(2026, 9, 14), timeZone: null, date: '2026-10-14' },
      busy: false,
    });
    expect(detailOf(`${PRIMARY}/commanderfocus412`)).toMatchObject({ createdByCommander: 'focus-block' });
  });

  it('keeps each instance of a recurring event as its own event, naming its series', async () => {
    await afterFirstSync();
    const monday = detailOf(`${STANDUPS}/standup_20261005T080000Z`);
    const tuesday = detailOf(`${STANDUPS}/standup_20261006T080000Z`);
    expect(monday).toMatchObject({
      seriesId: 'standup',
      calendar: { id: STANDUPS, name: 'Titanlink Standups', colour: '#33b679' },
      start: { at: Date.UTC(2026, 9, 5, 8), timeZone: 'Europe/London' },
      myResponse: 'accepted',
    });
    expect(tuesday.seriesId).toBe('standup');
    expect(tuesday.start.at - monday.start.at).toBe(24 * 60 * 60_000);
  });
});

describe('incremental sync', () => {
  it('asks only for what changed since each calendar’s sync token, without the window', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(incremental as Exchange[]);
    const next = await sync(recorded.fetch, cursor);

    expect(recorded.remaining()).toBe(0);
    expect(sent.map((request) => request.path).slice(1)).toEqual([
      `/calendars/${PRIMARY}/events?singleEvents=true&maxResults=250&syncToken=sync-primary-1`,
      `/calendars/${STANDUPS}/events?singleEvents=true&maxResults=250&syncToken=sync-standups-1`,
    ]);
    expect(next.cursor).toEqual({
      calendars: { [PRIMARY]: { syncToken: 'sync-primary-2' }, [STANDUPS]: { syncToken: 'sync-standups-2' } },
    });
  });

  it('saves changed and new events, tombstones cancelled ones, and drops new ones outside the window', async () => {
    const cursor = await afterFirstSync();
    const { items, deleted } = await sync(replay(incremental as Exchange[]).fetch, cursor);

    expect(items.map((item) => item.externalId)).toEqual([`${PRIMARY}/dentist2026`, `${PRIMARY}/lunchpriya`]);
    expect(detailOf(`${PRIMARY}/dentist2026`).start.at).toBe(Date.UTC(2026, 9, 5, 10));
    // The cancelled one-off event and the one cancelled instance of the standup.
    expect(deleted).toEqual([`${PRIMARY}/designreview1`, `${STANDUPS}/standup_20261006T080000Z`]);
    expect(eventOf(`${STANDUPS}/standup_20261005T080000Z`)).toBeDefined();
    // Passport renewal in 2028 is past the window.
    expect(eventOf(`${PRIMARY}/farfuture`)).toBeUndefined();
  });

  it('keeps an event it holds current even when it moves outside the window', async () => {
    const cursor = await afterFirstSync();
    const moved = structuredClone(incremental) as Exchange[];
    const page = moved[1]?.response.body as { items: { id: string; start: unknown; end: unknown }[] };
    const dentist = page.items.find((each) => each.id === 'dentist2026');
    if (!dentist) throw new Error('No dentist in the recording');
    dentist.start = { dateTime: '2028-02-01T10:00:00Z' };
    dentist.end = { dateTime: '2028-02-01T11:00:00Z' };
    await sync(replay(moved).fetch, cursor);
    expect(detailOf(`${PRIMARY}/dentist2026`).start.at).toBe(Date.UTC(2028, 1, 1, 10));
  });

  it('with nothing changed, saves nothing and keeps the new tokens', async () => {
    const cursor = await afterFirstSync();
    const before = structuredClone([...held.entries()]);
    const { pages, cursor: next } = await sync(replay(quiet as Exchange[]).fetch, cursor);
    expect(pages).toEqual([]);
    expect([...held.entries()]).toEqual(before);
    expect(next.calendars[PRIMARY]?.syncToken).toBe('sync-primary-1b');
  });

  it('tombstones every held instance when a whole recurring series is cancelled', async () => {
    const cursor = await afterFirstSync();
    const { deleted } = await sync(replay(seriesCancelled as Exchange[]).fetch, cursor);
    expect(deleted).toEqual([
      `${STANDUPS}/standup`,
      `${STANDUPS}/standup_20261005T080000Z`,
      `${STANDUPS}/standup_20261006T080000Z`,
    ]);
  });
});

describe('a sync token Google no longer accepts', () => {
  it('raises CursorExpired on 410 Gone; the full re-sync then tombstones what disappeared meanwhile', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(expired as Exchange[]);
    await expect(sync(recorded.fetch, cursor)).rejects.toBeInstanceOf(CursorExpired);

    // The engine syncs again from scratch: a full read of every calendar on.
    const again = await sync(recorded.fetch, null);
    expect(recorded.remaining()).toBe(0);
    expect(sent.at(-2)?.path).toContain('timeMin=');
    expect(again.deleted.sort()).toEqual([
      `${PRIMARY}/commanderfocus412`,
      `${PRIMARY}/designreview1`,
      `${PRIMARY}/localfirstconf`,
    ]);
    expect(again.cursor.calendars[PRIMARY]?.syncToken).toBe('sync-primary-9');
  });
});

describe('calendars switched on and off', () => {
  it('stops reading a calendar switched off and lets its events go; switched back on, reads it in full', async () => {
    const cursor = await afterFirstSync();
    switched.set(STANDUPS, false);
    const quietPrimary = (quiet as Exchange[]).slice(0, 2);
    const off = await sync(replay(quietPrimary).fetch, cursor);
    expect(off.cursor.calendars).toEqual({ [PRIMARY]: { syncToken: 'sync-primary-1b' } });
    expect(off.deleted.sort()).toEqual([
      `${STANDUPS}/standup_20261005T080000Z`,
      `${STANDUPS}/standup_20261006T080000Z`,
    ]);

    switched.set(STANDUPS, true);
    switched.set(HOLIDAYS, true);
    const list = (quiet as Exchange[])[0] as Exchange;
    const fullRead = (firstSync as Exchange[])[4] as Exchange;
    const holidays: Exchange = {
      request: {
        path: `/calendars/${HOLIDAYS}/events?singleEvents=true&maxResults=250&timeMin=2026-09-03T12:00:00.000Z&timeMax=2027-10-03T12:00:00.000Z`,
      },
      response: { status: 200, headers: {}, body: { items: [], nextSyncToken: 'sync-holidays-1' } },
    };
    const primaryAgain: Exchange = {
      request: {
        path: `/calendars/${PRIMARY}/events?singleEvents=true&maxResults=250&syncToken=sync-primary-1b`,
      },
      response: { status: 200, headers: {}, body: { items: [], nextSyncToken: 'sync-primary-1c' } },
    };
    const on = await sync(replay([list, primaryAgain, fullRead, holidays]).fetch, off.cursor);
    expect(on.items.map((item) => item.externalId)).toEqual([
      `${STANDUPS}/standup_20261005T080000Z`,
      `${STANDUPS}/standup_20261006T080000Z`,
    ]);
    expect(Object.keys(on.cursor.calendars)).toEqual([PRIMARY, STANDUPS, HOLIDAYS]);
  });
});

describe('refusals', () => {
  const list = (firstSync as Exchange[]).slice(0, 2);
  const eventsPath = `/calendars/${PRIMARY}/events?singleEvents=true&maxResults=250&timeMin=2026-09-03T12:00:00.000Z&timeMax=2027-10-03T12:00:00.000Z`;
  const refusal = (status: number, body: unknown, headers: Record<string, string> = {}): Exchange => ({
    request: { path: eventsPath },
    response: { status, headers: { 'content-type': 'application/json', ...headers }, body },
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'takes a 403 %s for a rate limit',
    async (reason) => {
      const error = await sync(
        replay([
          ...list,
          refusal(403, {
            error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason }] },
          }),
        ]).fetch,
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(RateLimited);
    },
  );

  it('takes a 429 for a rate limit, waiting as long as Google asks', async () => {
    const error = await sync(
      replay([...list, refusal(429, { error: { code: 429 } }, { 'retry-after': '120' })]).fetch,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(120_000);
  });

  it('takes a 401 for a refused sign-in', async () => {
    const error = await sync(replay([...list, refusal(401, { error: { code: 401 } })]).fetch).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(SignInRefused);
  });

  it('skips a calendar Google won’t share (404), carrying on with the rest', async () => {
    const standups = (firstSync as Exchange[])[4] as Exchange;
    const { cursor } = await sync(replay([...list, refusal(404, { error: { code: 404 } }), standups]).fetch);
    expect(Object.keys(cursor.calendars)).toEqual([STANDUPS]);
  });
});

it('syncs every 15 minutes by default', () => {
  expect(GOOGLE_CALENDAR_CADENCE.defaultMinutes).toBe(15);
});
