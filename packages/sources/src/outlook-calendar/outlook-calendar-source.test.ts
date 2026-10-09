import { calendarOnByDefault, type EventDetail, type SourceItem } from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarChoices } from '../google-calendar/google-calendar-source';
import type { ListedCalendar } from '../google-calendar/shapes';
import {
  type AccessToken,
  CursorExpired,
  RateLimited,
  SignInRefused,
  SourceUnavailable,
  type SyncPage,
} from '../source';
import {
  CURSOR_VERSION,
  createOutlookCalendarSource,
  MAX_CONCURRENT_REQUESTS,
  OUTLOOK_CALENDAR_CADENCE,
  type OutlookCalendarCursor,
} from './outlook-calendar-source';
import expired from './recorded/expired.json';
import firstSync from './recorded/first-sync.json';
import incremental from './recorded/incremental.json';
import partialDelta from './recorded/partial-delta.json';
import quiet from './recorded/quiet.json';
import { graphEvent, hydrated, isBare } from './shapes';

// The Outlook Calendar adapter against recorded Microsoft Graph v1.0 responses (shaped as Graph
// answers), each recording also pinning down the request Commander must send for it. Calendars sync
// side by side, so requests are matched by address rather than order.
//
// Most recordings give delta's events in full, as the primary calendar's delta does. Graph's
// per-calendar delta gave the User's work account bare events instead (times and series, no subject,
// #241), which partial-delta.json records: those are read in full by their ids, in JSON batches.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
// A JSON batch's recording also pins down the requests it carries.
type BatchRequest = { id: string; method: string; url: string; headers?: Record<string, string> };
type Exchange = { request: { path: string; body?: { requests: BatchRequest[] } }; response: Recorded };

const GRAPH = 'https://graph.test/v1.0';
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const ME = 'sam@contoso.test';
const DEFAULT = 'AAMkAGI2-cal-default=';
const PROJECTS = 'AAMkAGI2-cal-titanlink=';
const HOLIDAYS = 'AAMkAGI2-cal-usholidays=';
const SHARED = 'AAMkAGI2-cal-dana=';
const evt = (name: string) => `AAMkAGI2-evt-${name}=`;
const WINDOW = 'startDateTime=2026-09-03T12:00:00.000Z&endDateTime=2027-10-03T12:00:00.000Z';
const token: AccessToken = { token: 'eyJ0eXAiOi.recorded', kind: 'oauth' };

let held: Map<string, SourceItem>;
let listed: ListedCalendar[];
let switched: Map<string, boolean>;
let sent: {
  path: string;
  authorization: string | null;
  prefer: string | null;
  batch?: BatchRequest[];
}[];

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

// A batch's requests as compared: their addresses decoded.
const batchKey = (requests: BatchRequest[]) =>
  JSON.stringify(requests.map((each) => ({ ...each, url: decodeURIComponent(each.url) })));

// Answers each request with a recording made for that address (each used once, in order); a JSON
// batch with the recording made for the requests it carries.
function replay(exchanges: Exchange[], delayMs = 0) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const headers = new Headers(init?.headers);
    const batch =
      path === '/$batch' ? (JSON.parse(String(init?.body)).requests as BatchRequest[]) : undefined;
    sent.push({
      path,
      authorization: headers.get('authorization'),
      prefer: headers.get('prefer'),
      ...(batch && { batch }),
    });
    const index = queue.findIndex(
      (each) =>
        each.request.path === path &&
        (!batch || (!!each.request.body && batchKey(each.request.body.requests) === batchKey(batch))),
    );
    if (index < 0) throw new Error(`Unexpected request ${path}`);
    const [next] = queue.splice(index, 1) as [Exchange];
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const { status, headers: answer, body } = next.response;
    return new Response(body === null ? '' : JSON.stringify(body), { status, headers: answer });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

async function sync(fetch: typeof globalThis.fetch, cursor: unknown = null, now = NOW) {
  const pages: SyncPage[] = [];
  const source = createOutlookCalendarSource({ graphUrl: () => GRAPH, calendars, fetch, now: () => now });
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
    cursor: result.cursor as OutlookCalendarCursor,
    cost: result.cost,
    pages,
    items: pages.flatMap((page) => page.items),
    deleted: pages.flatMap((page) => page.deleted),
  };
}

const eventOf = (id: string) => held.get(id);
const detailOf = (id: string) => eventOf(id)?.detail as EventDetail;
const exchanges = (recorded: unknown) => structuredClone(recorded) as Exchange[];

async function afterFirstSync() {
  const { cursor } = await sync(replay(exchanges(firstSync)).fetch);
  sent = [];
  return cursor;
}

describe('the first sync', () => {
  it('lists every calendar (page by page), then reads those on from 30 days back to 12 months ahead, across pages', async () => {
    const recorded = replay(exchanges(firstSync));
    const { cursor, cost } = await sync(recorded.fetch);

    expect(recorded.remaining()).toBe(0);
    expect(cost.requests).toBe(5);
    // Events delta gives in full aren't read again.
    expect(sent.some((request) => request.path === '/$batch')).toBe(false);
    expect(sent.every((request) => request.authorization === 'Bearer eyJ0eXAiOi.recorded')).toBe(true);
    expect(listed).toEqual([
      { id: DEFAULT, name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
      { id: PROJECTS, name: 'Titanlink', colour: '#33b679', primary: false, accessRole: 'owner' },
      {
        id: HOLIDAYS,
        name: 'United States holidays',
        colour: '#f7a35c',
        primary: false,
        accessRole: 'reader',
      },
      { id: SHARED, name: 'Dana Ruiz', colour: '#4f9ee8', primary: false, accessRole: 'reader' },
    ]);
    // The holidays and shared calendars are off until the User switches them on: never read.
    expect(sent.some((request) => request.path.includes(HOLIDAYS) || request.path.includes(SHARED))).toBe(
      false,
    );
    expect(sent.map((request) => request.path)).toContain(
      `/me/calendars/${DEFAULT}/calendarView/delta?${WINDOW}`,
    );
    expect(cursor).toEqual({
      version: 2,
      calendars: {
        [DEFAULT]: {
          deltaLink: `${GRAPH}/me/calendars/${DEFAULT}/calendarView/delta?$deltatoken=default-delta-1`,
          since: NOW,
        },
        [PROJECTS]: {
          deltaLink: `${GRAPH}/me/calendars/${PROJECTS}/calendarView/delta?$deltatoken=projects-delta-1`,
          since: NOW,
        },
      },
    });
    expect([...held.keys()].sort()).toEqual(
      [
        evt('dentist'),
        evt('designreview'),
        evt('localfirstconf'),
        evt('standup-20261005'),
        evt('standup-20261006'),
      ].sort(),
    );
  });

  it('asks for immutable ids and a page size on every calendar request', async () => {
    await sync(replay(exchanges(firstSync)).fetch);
    const reads = sent.filter((request) => request.path.includes('/calendarView/delta'));
    expect(reads).toHaveLength(3);
    for (const request of reads) {
      expect(request.prefer).toContain('IdType="ImmutableId"');
      expect(request.prefer).toMatch(/odata\.maxpagesize=\d+/);
    }
  });

  it('keeps every field of an event: times with their zone, people and answers, the Teams link and the web link', async () => {
    await afterFirstSync();
    const review = eventOf(evt('designreview'));
    expect(review).toMatchObject({
      kind: 'event',
      title: 'Design review: onboarding',
      status: 'open',
      people: ['dana@titanlink.test', 'sam@contoso.test', 'leo@titanlink.test'],
    });
    expect(review?.detail).toEqual({
      kind: 'event',
      calendar: { id: DEFAULT, name: 'Calendar', colour: '#0078d4' },
      accountEmail: ME,
      start: { at: Date.UTC(2026, 9, 6, 14), timeZone: 'America/New_York', date: null },
      end: { at: Date.UTC(2026, 9, 6, 15), timeZone: 'America/New_York', date: null },
      allDay: false,
      location: 'Room 4',
      description:
        'Walk through the new onboarding flow.\n\nNotes (https://docs.example.test/onboarding)\n\n[image]',
      organiser: { email: 'dana@titanlink.test', name: 'Dana Ruiz', self: false },
      attendees: [
        {
          email: 'dana@titanlink.test',
          name: 'Dana Ruiz',
          self: false,
          response: 'needs-action',
          organiser: true,
          optional: false,
          resource: false,
        },
        {
          email: ME,
          name: 'Sam Rivera',
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
          email: 'room4@titanlink.test',
          name: 'Room 4',
          self: false,
          response: 'accepted',
          organiser: false,
          optional: false,
          resource: true,
        },
      ],
      myResponse: 'needs-action',
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_onboarding%40thread.v2/0',
      // Tentative still blocks the time.
      busy: true,
      private: false,
      seriesId: null,
      webUrl: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(evt('designreview'))}&exvsurl=1&path=/calendar/item`,
      createdByCommander: null,
      icalUid: '040000008200E00074C5B7101A82E008-designreview',
    } satisfies EventDetail);
  });

  it('keeps a private event of the User’s own as private, with no answer of theirs, and its plain-text notes', async () => {
    await afterFirstSync();
    expect(detailOf(evt('dentist'))).toMatchObject({
      private: true,
      myResponse: null,
      organiser: { email: ME, name: 'Sam Rivera', self: true },
      description: 'Bring the form.',
      // Outlook names the zone the Windows way: GMT Standard Time is London.
      start: { at: Date.UTC(2026, 9, 8, 9), timeZone: 'Europe/London', date: null },
    });
  });

  it('keeps all-day events by their days (the end day exclusive), and free time as free', async () => {
    await afterFirstSync();
    expect(detailOf(evt('localfirstconf'))).toMatchObject({
      allDay: true,
      start: { at: Date.UTC(2026, 9, 12), timeZone: null, date: '2026-10-12' },
      end: { at: Date.UTC(2026, 9, 14), timeZone: null, date: '2026-10-14' },
      busy: false,
    });
  });

  it('keeps each instance of a recurring event as its own event, naming its series', async () => {
    await afterFirstSync();
    const monday = detailOf(evt('standup-20261005'));
    const tuesday = detailOf(evt('standup-20261006'));
    expect(monday).toMatchObject({
      seriesId: evt('standup'),
      calendar: { id: PROJECTS, name: 'Titanlink', colour: '#33b679' },
      start: { at: Date.UTC(2026, 9, 5, 15), timeZone: 'America/Los_Angeles' },
      // The User organises it and has guests: they're going.
      myResponse: 'accepted',
    });
    expect(tuesday.seriesId).toBe(evt('standup'));
    expect(tuesday.start.at - monday.start.at).toBe(DAY);
  });

  it('never keeps an event Outlook says is cancelled', async () => {
    const { deleted } = await sync(replay(exchanges(firstSync)).fetch);
    expect(eventOf(evt('budgetsync'))).toBeUndefined();
    expect(deleted).toContain(evt('budgetsync'));
  });
});

describe('events a delta answers without their properties (#241)', () => {
  const BUSY_COPY = evt('busycopy');

  it('reads each bare event in full by its id, in a JSON batch, and stores all of it', async () => {
    // What a first sync of full events stores, to compare with.
    await sync(replay(exchanges(firstSync)).fetch);
    const full = new Map(held);
    held = new Map();
    sent = [];

    const recorded = replay(exchanges(partialDelta));
    const { cursor, cost } = await sync(recorded.fetch);
    expect(recorded.remaining()).toBe(0);
    // Two pages of calendars, a delta of each calendar on, and a batch for each.
    expect(cost.requests).toBe(6);
    const batches = sent.filter((request) => request.path === '/$batch');
    expect(batches).toHaveLength(2);
    for (const { batch } of batches) {
      expect(batch?.every((each) => each.method === 'GET' && each.url.startsWith('/me/events/'))).toBe(true);
      expect(batch?.every((each) => each.headers?.prefer === 'IdType="ImmutableId"')).toBe(true);
    }
    // Each event as a delta of full events stores it: subject, organiser, guests, link, place, notes.
    for (const id of [
      evt('designreview'),
      evt('dentist'),
      evt('standup-20261005'),
      evt('standup-20261006'),
    ]) {
      expect(eventOf(id)).toEqual(full.get(id));
    }
    expect(eventOf(evt('designreview'))).toMatchObject({
      title: 'Design review: onboarding',
      detail: {
        organiser: { email: 'dana@titanlink.test' },
        location: 'Room 4',
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_onboarding%40thread.v2/0',
        description: expect.stringContaining('Walk through the new onboarding flow.'),
      },
    });
    expect(detailOf(evt('designreview')).attendees).toHaveLength(4);
    expect([...held.values()].some((item) => item.title === '(No title)')).toBe(false);
    expect(cursor.version).toBe(CURSOR_VERSION);
  });

  it('keeps each recurring instance its own, with the delta’s id and times', async () => {
    await sync(replay(exchanges(partialDelta)).fetch);
    expect(eventOf(evt('standup-20261005'))).toMatchObject({
      externalId: evt('standup-20261005'),
      title: 'TL standup',
      detail: {
        seriesId: evt('standup'),
        start: { at: Date.UTC(2026, 9, 5, 15), timeZone: 'America/Los_Angeles' },
        end: { at: Date.UTC(2026, 9, 5, 15, 15) },
      },
    });
    expect(detailOf(evt('standup-20261006')).start.at).toBe(Date.UTC(2026, 9, 6, 15));
  });

  it('fills a bare event in from its full one, keeping what the delta said', () => {
    const bare = graphEvent.parse({
      id: evt('standup-20261007'),
      type: 'exception',
      seriesMasterId: evt('standup'),
      start: { dateTime: '2026-10-07T16:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-07T16:15:00.0000000', timeZone: 'UTC' },
    });
    const full = graphEvent.parse({
      id: evt('standup'),
      type: 'seriesMaster',
      subject: 'TL standup',
      seriesMasterId: null,
      start: { dateTime: '2026-10-05T15:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-05T15:15:00.0000000', timeZone: 'UTC' },
    });
    expect(isBare(bare)).toBe(true);
    expect(isBare(full)).toBe(false);
    expect(isBare(graphEvent.parse({ id: evt('x'), '@removed': { reason: 'deleted' } }))).toBe(false);
    expect(hydrated(bare, full)).toMatchObject({
      id: evt('standup-20261007'),
      type: 'exception',
      subject: 'TL standup',
      seriesMasterId: evt('standup'),
      start: { dateTime: '2026-10-07T16:00:00.0000000' },
      end: { dateTime: '2026-10-07T16:15:00.0000000' },
    });
  });

  it('knows its own busy copy by the transactionId only the full event carries', async () => {
    await sync(replay(exchanges(partialDelta)).fetch);
    expect(eventOf(BUSY_COPY)).toMatchObject({
      title: 'Busy',
      commanderItemId: '7d9c2f3e-41a6-4c1b-9e57-2b8d0f6a1c34',
      detail: { createdByCommander: 'busy-block', private: true },
    });
  });

  it('tombstones an event the full read says is cancelled', async () => {
    const { deleted } = await sync(replay(exchanges(partialDelta)).fetch);
    expect(eventOf(evt('budgetsync'))).toBeUndefined();
    expect(deleted).toContain(evt('budgetsync'));
  });

  // One calendar answering `count` bare events in one page, each read in full through batches whose
  // answers `answer` gives (each event in full, unless it says otherwise). `owned`: the User's own
  // calendar, or a colleague's shared with them.
  function bareCalendar(
    count: number,
    answer: (id: string) => { status: number; headers?: Record<string, string>; body?: unknown } = (id) => ({
      status: 200,
      body: { id, subject: `Meeting ${id}`, start: {}, end: {} },
    }),
    owned = true,
  ) {
    const calendarId = owned ? DEFAULT : SHARED;
    if (!owned) switched.set(SHARED, true);
    const ids = Array.from({ length: count }, (_, n) => evt(`bare${n + 1}`));
    const at = (n: number, minutes: string) =>
      `2026-10-05T${String(9 + n).padStart(2, '0')}:${minutes}:00.0000000`;
    const value = ids.map((id, n) => ({
      '@odata.etag': `W/"${n}"`,
      id,
      type: 'singleInstance',
      start: { dateTime: at(n, '00'), timeZone: 'UTC' },
      end: { dateTime: at(n, '30'), timeZone: 'UTC' },
    }));
    let running = 0;
    let most = 0;
    const batches: BatchRequest[][] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = decodeURIComponent(String(url).slice(GRAPH.length));
      if (path.startsWith('/me/calendars?')) {
        const calendar = {
          id: calendarId,
          name: owned ? 'Calendar' : 'Dana Ruiz',
          isDefaultCalendar: owned,
          canEdit: owned,
          owner: { address: owned ? ME : 'dana@titanlink.test' },
        };
        return new Response(JSON.stringify({ value: [calendar] }));
      }
      if (path.includes('/calendarView/delta')) {
        return new Response(JSON.stringify({ value, '@odata.deltaLink': `${GRAPH}/d?$deltatoken=b` }));
      }
      const requests = JSON.parse(String(init?.body)).requests as BatchRequest[];
      batches.push(requests.map((each) => ({ ...each, url: decodeURIComponent(each.url) })));
      running += requests.length;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= requests.length;
      const responses = requests.map((each) => {
        const id = decodeURIComponent(/\/events\/([^?]+)/.exec(each.url)?.[1] ?? '');
        return { id: each.id, ...answer(id) };
      });
      return new Response(JSON.stringify({ responses }));
    }) as typeof globalThis.fetch;
    return { ids, fetch, batches, most: () => most };
  }

  it(`batches at most ${MAX_CONCURRENT_REQUESTS} events at a time, within the mailbox’s ${MAX_CONCURRENT_REQUESTS} requests at once`, async () => {
    const calendar = bareCalendar(10);
    await sync(calendar.fetch);
    expect(calendar.batches.map((batch) => batch.length)).toEqual([4, 4, 2]);
    expect(calendar.most()).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(calendar.ids.map((id) => eventOf(id)?.title)).toEqual(calendar.ids.map((id) => `Meeting ${id}`));
    expect(detailOf(evt('bare3')).start.at).toBe(Date.UTC(2026, 9, 5, 11));
  });

  it('reads a shared calendar’s bare events through that calendar', async () => {
    const calendar = bareCalendar(1, undefined, false);
    await sync(calendar.fetch);
    expect(calendar.batches[0]?.[0]?.url).toMatch(
      new RegExp(`^/me/calendars/${SHARED}/events/${evt('bare1')}\\?\\$select=id,type,subject,`),
    );
    expect(eventOf(evt('bare1'))?.title).toBe(`Meeting ${evt('bare1')}`);
  });

  it('leaves an event Graph won’t give in full as Commander last saw it, even on a full read', async () => {
    await sync(bareCalendar(2).fetch);
    const again = bareCalendar(2, (id) =>
      id === evt('bare2')
        ? { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
        : { status: 200, body: { id, subject: 'Planning', start: {}, end: {} } },
    );
    const { items, deleted } = await sync(again.fetch);
    expect(items.map((item) => item.externalId)).toEqual([evt('bare1')]);
    expect(deleted).toEqual([]);
    expect(eventOf(evt('bare2'))?.title).toBe(`Meeting ${evt('bare2')}`);
  });

  it('takes a throttled read in a batch for a rate limit, waiting as long as Microsoft asks', async () => {
    const calendar = bareCalendar(1, () => ({
      status: 429,
      headers: { 'Retry-After': '20' },
      body: { error: { code: 'ApplicationThrottled' } },
    }));
    const error = await sync(calendar.fetch).catch((caught) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(20_000);
  });

  it('fails the sync, to be tried again, when Graph can’t give an event just now', async () => {
    const calendar = bareCalendar(1, () => ({
      status: 500,
      body: { error: { code: 'InternalServerError' } },
    }));
    await expect(sync(calendar.fetch)).rejects.toBeInstanceOf(SourceUnavailable);
  });

  it('expires a cursor from before, once: reading from scratch gives "(No title)" events their titles', async () => {
    // What the earlier version stored from the bare events, and the cursor it kept.
    const { version: _, ...before } = (await sync(replay(exchanges(partialDelta)).fetch)).cursor;
    for (const item of held.values()) held.set(item.externalId, { ...item, title: '(No title)' });

    await expect(sync(replay(exchanges(quiet)).fetch, before)).rejects.toBeInstanceOf(CursorExpired);
    // The engine forgets the cursor and syncs from scratch.
    const again = await sync(replay(exchanges(partialDelta)).fetch, null);
    expect(again.items.map((item) => item.externalId).sort()).toEqual(
      [
        evt('designreview'),
        evt('dentist'),
        BUSY_COPY,
        evt('standup-20261005'),
        evt('standup-20261006'),
      ].sort(),
    );
    expect([...held.values()].map((item) => item.title).sort()).toEqual(
      ['Busy', 'Dentist', 'Design review: onboarding', 'TL standup', 'TL standup'].sort(),
    );
    // From then on, it reads from the delta links again.
    const recorded = replay(exchanges(quiet));
    await sync(recorded.fetch, again.cursor);
    expect(recorded.remaining()).toBe(0);
  });
});

describe('incremental sync', () => {
  it('reads each calendar from its delta link', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(exchanges(incremental));
    const next = await sync(recorded.fetch, cursor);

    expect(recorded.remaining()).toBe(0);
    expect(sent.map((request) => request.path).filter((path) => path.includes('delta'))).toEqual(
      expect.arrayContaining([
        `/me/calendars/${DEFAULT}/calendarView/delta?$deltatoken=default-delta-1`,
        `/me/calendars/${PROJECTS}/calendarView/delta?$deltatoken=projects-delta-1`,
      ]),
    );
    expect(next.cursor.calendars[DEFAULT]).toEqual({
      deltaLink: `${GRAPH}/me/calendars/${DEFAULT}/calendarView/delta?$deltatoken=default-delta-2`,
      since: NOW,
    });
  });

  it('saves changed and new events, and tombstones removed ones and a cancelled instance', async () => {
    const cursor = await afterFirstSync();
    const { items, deleted } = await sync(replay(exchanges(incremental)).fetch, cursor);

    expect(items.map((item) => item.externalId).sort()).toEqual([evt('dentist'), evt('lunchpriya')].sort());
    expect(detailOf(evt('dentist')).start.at).toBe(Date.UTC(2026, 9, 8, 10));
    expect(detailOf(evt('lunchpriya'))).toMatchObject({ myResponse: 'accepted', location: 'Dishoom' });
    expect(deleted.sort()).toEqual([evt('designreview'), evt('standup-20261006')].sort());
    expect(eventOf(evt('standup-20261005'))).toBeDefined();
  });

  it('with nothing changed, saves nothing and keeps the new delta links', async () => {
    const cursor = await afterFirstSync();
    const before = structuredClone([...held.entries()]);
    const { pages, cursor: next } = await sync(replay(exchanges(quiet)).fetch, cursor);
    expect(pages).toEqual([]);
    expect([...held.entries()]).toEqual(before);
    expect(next.calendars[DEFAULT]?.deltaLink).toContain('default-delta-1b');
  });

  it('tombstones every held instance when a whole recurring series is removed', async () => {
    const cursor = await afterFirstSync();
    const recorded = exchanges(quiet);
    const projects = recorded[3]?.response.body as { value: unknown[] };
    projects.value = [{ id: evt('standup'), '@removed': { reason: 'deleted' } }];
    const { deleted } = await sync(replay(recorded).fetch, cursor);
    expect(deleted.sort()).toEqual([evt('standup-20261005'), evt('standup-20261006')].sort());
  });

  it('keeps an event’s Item when it moves to another calendar (immutable ids), whichever calendar reports first', async () => {
    for (const delay of [false, true]) {
      held = new Map();
      const cursor = await afterFirstSync();
      const recorded = exchanges(quiet);
      const fromDefault = recorded[2]?.response.body as { value: unknown[] };
      const toProjects = recorded[3]?.response.body as { value: unknown[] };
      const dentist = (exchanges(firstSync)[2]?.response.body as { value: { id: string }[] } | undefined)
        ?.value[1];
      fromDefault.value = [{ id: evt('dentist'), '@removed': { reason: 'deleted' } }];
      toProjects.value = [dentist];
      // One calendar's answer held back, so the other's is saved first.
      const answers = replay(recorded);
      const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes(delay ? DEFAULT : PROJECTS)) await new Promise((r) => setTimeout(r, 10));
        return answers.fetch(url, init);
      }) as typeof globalThis.fetch;
      await sync(fetch, cursor);
      expect(detailOf(evt('dentist'))?.calendar.id).toBe(PROJECTS);
    }
  });
});

describe('a delta link Graph no longer accepts', () => {
  it('raises CursorExpired on 410 SyncStateNotFound; the full re-sync then tombstones what disappeared, saving only what changed', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(exchanges(expired));
    await expect(sync(recorded.fetch, cursor)).rejects.toBeInstanceOf(CursorExpired);

    // The engine syncs again from scratch: a full read of every calendar on.
    const again = await sync(recorded.fetch, null);
    expect(recorded.remaining()).toBe(0);
    expect(sent.map((request) => request.path)).toContain(
      `/me/calendars/${DEFAULT}/calendarView/delta?${WINDOW}`,
    );
    expect(again.deleted).toEqual([evt('localfirstconf')]);
    expect(again.items).toEqual([]);
    expect(again.cursor.calendars[DEFAULT]?.deltaLink).toContain('default-delta-9');
  });

  it.each([
    [410, 'resyncRequired'],
    [400, 'SyncStateInvalid'],
  ])('takes a %i %s for an expired delta link too', async (status, code) => {
    const cursor = await afterFirstSync();
    const recorded = exchanges(quiet);
    (recorded[2] as Exchange).response = {
      status,
      headers: {},
      body: { error: { code, message: 'Resync.' } },
    };
    await expect(sync(replay(recorded).fetch, cursor)).rejects.toBeInstanceOf(CursorExpired);
  });
});

describe('the rolling window', () => {
  // Reads of each calendar from a fresh window starting `days` after the first sync.
  function freshWindow(days: number, change: (exchanges: Exchange[]) => void = () => {}) {
    const later = NOW + days * DAY;
    const window = `startDateTime=${new Date(later - 30 * DAY).toISOString()}&endDateTime=${new Date(later + 365 * DAY).toISOString()}`;
    const recorded = exchanges(expired).slice(6);
    for (const each of recorded) each.request.path = each.request.path.replace(WINDOW, window);
    change(recorded);
    return { recorded: [...exchanges(firstSync).slice(0, 2), ...recorded], later, window };
  }

  it('keeps reading from the delta links while the window is under a week old', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(exchanges(quiet));
    await sync(recorded.fetch, cursor, NOW + 6 * DAY);
    expect(recorded.remaining()).toBe(0);
  });

  it('starts a fresh delta once the window’s start is over a week old, saving only what changed', async () => {
    const cursor = await afterFirstSync();
    const { recorded, later, window } = freshWindow(8, (fresh) => {
      const page = fresh[0]?.response.body as { value: { subject: string }[] };
      const dentist = page.value[1];
      if (dentist) dentist.subject = 'Dentist (moved room)';
    });
    const answers = replay(recorded);
    const { items, deleted, cursor: next } = await sync(answers.fetch, cursor, later);

    expect(answers.remaining()).toBe(0);
    expect(sent.map((request) => request.path)).toContain(
      `/me/calendars/${DEFAULT}/calendarView/delta?${window}`,
    );
    expect(sent.some((request) => request.path.includes('$deltatoken'))).toBe(false);
    // Only the renamed event is saved; the conference no longer returned is gone.
    expect(items.map((item) => item.externalId)).toEqual([evt('dentist')]);
    expect(deleted).toEqual([evt('localfirstconf')]);
    expect(next.calendars[DEFAULT]).toEqual({
      deltaLink: `${GRAPH}/me/calendars/${DEFAULT}/calendarView/delta?$deltatoken=default-delta-9`,
      since: later,
    });
  });

  it('leaves held events that have fallen behind the new window alone', async () => {
    const cursor = await afterFirstSync();
    // 45 days on, the October events are all before the window: none is returned, none is deleted.
    const { recorded, later } = freshWindow(45, (fresh) => {
      for (const each of fresh) (each.response.body as { value: unknown[] }).value = [];
    });
    const { deleted } = await sync(replay(recorded).fetch, cursor, later);
    expect(deleted).toEqual([]);
    expect(held.size).toBe(5);
  });
});

describe('calendars switched on and off', () => {
  it('stops reading a calendar switched off and lets its events go; switched back on, reads it in full', async () => {
    const cursor = await afterFirstSync();
    switched.set(PROJECTS, false);
    const off = await sync(replay(exchanges(quiet).slice(0, 3)).fetch, cursor);
    expect(Object.keys(off.cursor.calendars)).toEqual([DEFAULT]);
    expect(off.deleted.sort()).toEqual([evt('standup-20261005'), evt('standup-20261006')].sort());

    switched.set(PROJECTS, true);
    const recorded: Exchange[] = [
      ...exchanges(quiet).slice(0, 2),
      {
        request: { path: `/me/calendars/${DEFAULT}/calendarView/delta?$deltatoken=default-delta-1b` },
        response: {
          status: 200,
          headers: {},
          body: { value: [], '@odata.deltaLink': `${GRAPH}/x?$deltatoken=d2` },
        },
      },
      exchanges(firstSync)[4] as Exchange,
    ];
    const on = await sync(replay(recorded).fetch, off.cursor);
    expect(on.items.map((item) => item.externalId).sort()).toEqual(
      [evt('standup-20261005'), evt('standup-20261006')].sort(),
    );
    expect(Object.keys(on.cursor.calendars).sort()).toEqual([DEFAULT, PROJECTS].sort());
  });
});

describe('refusals and throttling', () => {
  const list = () => exchanges(firstSync).slice(0, 2);
  const refusal = (path: string, status: number, body: unknown, headers: Record<string, string> = {}) => ({
    request: { path },
    response: { status, headers: { 'content-type': 'application/json', ...headers }, body },
  });
  const defaultRead = `/me/calendars/${DEFAULT}/calendarView/delta?${WINDOW}`;
  const projectsRead = exchanges(firstSync)[4] as Exchange;

  it('takes a 429 for a rate limit, waiting as long as Microsoft asks', async () => {
    const error = await sync(
      replay([
        ...list(),
        refusal(
          defaultRead,
          429,
          { error: { code: 'TooManyRequests', message: 'Too many requests.' } },
          { 'retry-after': '30' },
        ),
        projectsRead,
      ]).fetch,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(30_000);
  });

  it('takes a 503 with Retry-After for a rate limit, and one without for a passing outage', async () => {
    const limited = await sync(
      replay([
        ...list(),
        refusal(defaultRead, 503, { error: { code: 'ServiceUnavailable' } }, { 'retry-after': '5' }),
        projectsRead,
      ]).fetch,
    ).catch((caught) => caught);
    expect(limited).toBeInstanceOf(RateLimited);
    expect((limited as RateLimited).retryAfterMs).toBe(5_000);

    const down = await sync(
      replay([...list(), refusal(defaultRead, 503, { error: { code: 'ServiceUnavailable' } }), projectsRead])
        .fetch,
    ).catch((caught) => caught);
    expect(down).toBeInstanceOf(SourceUnavailable);
  });

  it('takes a 401 for a refused sign-in', async () => {
    const error = await sync(
      replay([
        refusal(
          `/me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=50`,
          401,
          {},
        ),
      ]).fetch,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(SignInRefused);
  });

  it('skips a calendar Graph won’t share (404), carrying on with the rest', async () => {
    const { cursor } = await sync(
      replay([...list(), refusal(defaultRead, 404, { error: { code: 'ErrorItemNotFound' } }), projectsRead])
        .fetch,
    );
    expect(Object.keys(cursor.calendars)).toEqual([PROJECTS]);
  });

  it('never follows a link away from Graph with the User’s token', async () => {
    const recorded = exchanges(firstSync);
    (recorded[2]?.response.body as Record<string, unknown>)['@odata.nextLink'] = 'https://evil.test/steal';
    const error = await sync(replay(recorded).fetch).catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceUnavailable);
  });

  it(`runs no more than ${MAX_CONCURRENT_REQUESTS} requests at once for one mailbox, reading calendars side by side`, async () => {
    expect(MAX_CONCURRENT_REQUESTS).toBe(4);
    // Six calendars of the User's own, each read in one page.
    const ids = [1, 2, 3, 4, 5, 6].map((n) => `AAMkAGI2-cal-own${n}=`);
    const calendarsPage: Exchange = {
      request: {
        path: '/me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=50',
      },
      response: {
        status: 200,
        headers: {},
        body: {
          value: ids.map((id, index) => ({
            id,
            name: `Calendar ${index + 1}`,
            hexColor: '',
            color: 'auto',
            isDefaultCalendar: index === 0,
            canEdit: true,
            owner: { name: 'Sam Rivera', address: ME },
          })),
        },
      },
    };
    const reads: Exchange[] = ids.map((id) => ({
      request: { path: `/me/calendars/${id}/calendarView/delta?${WINDOW}` },
      response: {
        status: 200,
        headers: {},
        body: { value: [], '@odata.deltaLink': `${GRAPH}/d?$deltatoken=${id}` },
      },
    }));
    const answers = replay([calendarsPage, ...reads], 15);
    let running = 0;
    let most = 0;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      running += 1;
      most = Math.max(most, running);
      try {
        return await answers.fetch(url, init);
      } finally {
        running -= 1;
      }
    }) as typeof globalThis.fetch;
    const { cursor } = await sync(fetch);
    expect(Object.keys(cursor.calendars)).toHaveLength(6);
    expect(most).toBe(MAX_CONCURRENT_REQUESTS);
  });
});

it('syncs every 15 minutes by default', () => {
  expect(OUTLOOK_CALENDAR_CADENCE.defaultMinutes).toBe(15);
});
