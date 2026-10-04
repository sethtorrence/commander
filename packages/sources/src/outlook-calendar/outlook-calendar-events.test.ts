import { isDeepStrictEqual } from 'node:util';
import {
  type CommanderEventCreate,
  type CommanderEventMove,
  CREATE_FIELD,
  DELETE_FIELD,
  type EventDetail,
  MOVE_FIELD,
  pendingEventExternalId,
  type SourceItem,
} from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarChoices } from '../google-calendar/google-calendar-source';
import {
  type AccessToken,
  type FieldChange,
  RateLimited,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  WriteRejected,
  type WriteResult,
} from '../source';
import { createOutlookCalendarSource } from './outlook-calendar-source';
import writes from './recorded/writes.json';
import { graphEvent, toEventItem } from './shapes';

// The Outlook Calendar adapter writing the events Commander makes itself (focus blocks and busy
// copies, #131) against recorded Microsoft Graph v1.0 responses, shaped as Graph answers. Each
// recording pins the method, address and (where it matters) body Commander must send for it.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { method: string; path: string; body?: unknown }; response: Recorded };
type Sent = {
  method: string;
  path: string;
  body: unknown;
  prefer: string | null;
  authorization: string | null;
  contentType: string | null;
};

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const ME = 'sam@contoso.test';
const DEFAULT = 'AAMkAGI2-cal-default=';
const COMMANDER = 'AAMkAGI2-cal-commander=';
const FOCUS_ID = '3f2b8c1e-5d4a-4c6b-9e8f-0a1b2c3d4e5f';
const FOCUS2_ID = '7a9d2e4f-1b3c-4d5e-8f6a-b7c8d9e0f1a2';
const BUSY_ID = 'c4e6a8b0-2d4f-4a6c-8e0b-1d3f5a7c9e2b';
const FOCUS_EVENT = 'AAMkAGI2-evt-focus1=';
const MARKER = 'String {00020329-0000-0000-C000-000000000046} Name CommanderEvent';
const token: AccessToken = { token: 'eyJ0eXAiOi.recorded', kind: 'oauth' };
const recorded = writes as unknown as Record<string, Exchange[]>;

let sent: Sent[];
let problems: string[];

beforeEach(() => {
  sent = [];
  problems = [];
});

// Writes never read calendars through the choices: only sync does.
const calendars: CalendarChoices = {
  listed: (_account, found) => new Set(found.map((each) => each.id)),
  held: () => [],
};

// Answers each request with the recording made for its method and address (each used once, in order),
// noting any request the recording didn't expect, or whose body differs from the one recorded.
function script(name: string) {
  const queue = structuredClone(recorded[name] ?? []);
  if (!queue.length) throw new Error(`No recording ${name}`);
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({
      method,
      path,
      body,
      prefer: headers.get('prefer'),
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
    });
    const index = queue.findIndex((each) => each.request.method === method && each.request.path === path);
    if (index < 0) {
      problems.push(`Unexpected ${method} ${path}`);
      throw new Error(`Unexpected ${method} ${path}`);
    }
    const [next] = queue.splice(index, 1) as [Exchange];
    if (next.request.body !== undefined && !isDeepStrictEqual(next.request.body, body)) {
      problems.push(`${method} ${path} sent ${JSON.stringify(body)}`);
    }
    const { status, headers: answer, body: content } = next.response;
    return new Response(content === null ? null : JSON.stringify(content), { status, headers: answer });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

const adapter = (fetch: typeof globalThis.fetch): SourceAdapter =>
  createOutlookCalendarSource({ graphUrl: () => GRAPH, calendars, fetch, now: () => NOW });

const change = (field: string, value: unknown): FieldChange => ({
  field,
  value,
  synced: null,
  madeAt: NOW - 60_000,
});

// Writes one Item's changes; any request the recording didn't expect fails the test first.
async function write(
  source: SourceAdapter,
  externalId: string,
  changes: FieldChange[],
): Promise<WriteResult> {
  if (!source.write) throw new Error('Outlook Calendar has no write');
  try {
    return await source.write({
      account: ACCOUNT,
      externalId,
      changes,
      accessToken: async () => token,
      signal: new AbortController().signal,
    });
  } finally {
    expect(problems).toEqual([]);
  }
}

async function refusal(source: SourceAdapter, externalId: string, changes: FieldChange[]) {
  return write(source, externalId, changes).then(
    () => {
      throw new Error('The write went through');
    },
    (error: unknown) => error,
  );
}

const london = (at: number) => ({ at, timeZone: 'Europe/London', date: null });

const focusBlock = (overrides: Partial<CommanderEventCreate> = {}): CommanderEventCreate => ({
  kind: 'focus-block',
  calendarId: null,
  commanderId: FOCUS_ID,
  title: 'Write the quarterly plan',
  // 09:00–11:00 in London, on summer time.
  start: london(Date.UTC(2026, 9, 6, 8)),
  end: london(Date.UTC(2026, 9, 6, 10)),
  allDay: false,
  ...overrides,
});

const secondFocusBlock = focusBlock({
  commanderId: FOCUS2_ID,
  title: 'Review the hiring plan',
  start: london(Date.UTC(2026, 9, 7, 8)),
  end: london(Date.UTC(2026, 9, 7, 9)),
});

const move: CommanderEventMove = {
  start: london(Date.UTC(2026, 9, 6, 13)),
  end: london(Date.UTC(2026, 9, 6, 14, 30)),
  allDay: false,
};

const detailOf = (item: SourceItem | null) => item?.detail as EventDetail;
const requests = () => sent.map((each) => `${each.method} ${each.path}`);
const eventPosts = () => sent.filter((each) => each.method === 'POST' && each.path.endsWith('/events'));

describe('making a focus block', () => {
  it('makes the Commander calendar on first use, then the event: busy, private, no reminder, with its transactionId and Commander’s marker', async () => {
    const replay = script('first-focus-block');
    const result = await write(adapter(replay.fetch), pendingEventExternalId(FOCUS_ID), [
      change(CREATE_FIELD, focusBlock()),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(requests()).toEqual([
      'GET /me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=50',
      'POST /me/calendars',
      `POST /me/calendars/${COMMANDER}/events`,
    ]);
    expect(sent[1]?.body).toEqual({ name: 'Commander' });
    expect(sent[2]?.body).toEqual({
      subject: 'Write the quarterly plan',
      start: { dateTime: '2026-10-06T09:00:00.0000000', timeZone: 'Europe/London' },
      end: { dateTime: '2026-10-06T11:00:00.0000000', timeZone: 'Europe/London' },
      isAllDay: false,
      showAs: 'busy',
      sensitivity: 'private',
      isReminderOn: false,
      transactionId: `focus-block:${FOCUS_ID}`,
      singleValueExtendedProperties: [{ id: MARKER, value: `focus-block:${FOCUS_ID}` }],
    });
    expect(sent.every((each) => each.prefer === 'IdType="ImmutableId"' || each.method === 'GET')).toBe(true);
    expect(sent.every((each) => each.prefer?.includes('IdType="ImmutableId"'))).toBe(true);
    expect(sent.every((each) => each.authorization === 'Bearer eyJ0eXAiOi.recorded')).toBe(true);
    expect(
      sent.filter((each) => each.method === 'POST').every((each) => each.contentType === 'application/json'),
    ).toBe(true);

    expect(result.superseded).toEqual([]);
    expect(result.cost).toEqual({ requests: 3, complexity: null });
    expect(result.item).toEqual({
      externalId: FOCUS_EVENT,
      kind: 'event',
      title: 'Write the quarterly plan',
      people: [ME],
      status: 'open',
      commanderItemId: FOCUS_ID,
      detail: {
        kind: 'event',
        calendar: { id: COMMANDER, name: 'Commander', colour: '#0078d4' },
        accountEmail: ME,
        start: { at: Date.UTC(2026, 9, 6, 8), timeZone: 'Europe/London', date: null },
        end: { at: Date.UTC(2026, 9, 6, 10), timeZone: 'Europe/London', date: null },
        allDay: false,
        location: null,
        description: null,
        organiser: { email: ME, name: 'Sam Rivera', self: true },
        attendees: [],
        myResponse: null,
        meetingUrl: null,
        busy: true,
        private: true,
        seriesId: null,
        webUrl: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(FOCUS_EVENT)}&exvsurl=1&path=/calendar/item`,
        createdByCommander: 'focus-block',
      } satisfies EventDetail,
    });
  });

  it('makes one event however often the create is retried: the same transactionId, and Graph’s answer is the event it already made', async () => {
    const source = adapter(script('retried-create').fetch);
    const changes = [change(CREATE_FIELD, focusBlock())];

    // The first attempt reached Graph, but its answer was lost on the way back.
    const lost = await refusal(source, pendingEventExternalId(FOCUS_ID), changes);
    expect(lost).toBeInstanceOf(SourceUnavailable);
    const result = await write(source, pendingEventExternalId(FOCUS_ID), changes);

    const [first, retry] = eventPosts();
    expect(eventPosts()).toHaveLength(2);
    expect(retry?.body).toEqual(first?.body);
    expect(retry?.body).toMatchObject({ transactionId: `focus-block:${FOCUS_ID}` });
    expect(result.item?.externalId).toBe(FOCUS_EVENT);
    expect(result.item?.commanderItemId).toBe(FOCUS_ID);
  });

  it('reuses the Account’s own Commander calendar (not someone else’s shared one), and remembers it', async () => {
    const replay = script('existing-commander-calendar');
    const source = adapter(replay.fetch);
    const first = await write(source, pendingEventExternalId(FOCUS_ID), [change(CREATE_FIELD, focusBlock())]);
    const second = await write(source, pendingEventExternalId(FOCUS2_ID), [
      change(CREATE_FIELD, secondFocusBlock),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(requests()).toEqual([
      'GET /me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=50',
      `POST /me/calendars/${COMMANDER}/events`,
      `POST /me/calendars/${COMMANDER}/events`,
    ]);
    expect(detailOf(first.item).calendar).toEqual({ id: COMMANDER, name: 'Commander', colour: '#4bcfc1' });
    expect(detailOf(second.item).calendar).toEqual({ id: COMMANDER, name: 'Commander', colour: '#4bcfc1' });
    expect(second.item?.commanderItemId).toBe(FOCUS2_ID);
    expect(second.cost.requests).toBe(1);
  });

  it('finds or makes the Commander calendar again when the one it remembered is gone', async () => {
    const replay = script('cached-calendar-gone');
    const source = adapter(replay.fetch);
    await write(source, pendingEventExternalId(FOCUS_ID), [change(CREATE_FIELD, focusBlock())]);
    const result = await write(source, pendingEventExternalId(FOCUS2_ID), [
      change(CREATE_FIELD, secondFocusBlock),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(requests().slice(2)).toEqual([
      `POST /me/calendars/${COMMANDER}/events`,
      'GET /me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=50',
      'POST /me/calendars',
      'POST /me/calendars/AAMkAGI2-cal-commander-2=/events',
    ]);
    expect(detailOf(result.item).calendar.id).toBe('AAMkAGI2-cal-commander-2=');
    expect(result.cost.requests).toBe(4);
  });

  it('makes the event first, then moves it, when it was moved before it reached Outlook', async () => {
    const replay = script('create-and-move');
    const result = await write(adapter(replay.fetch), pendingEventExternalId(FOCUS_ID), [
      change(CREATE_FIELD, focusBlock()),
      change(MOVE_FIELD, move),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(requests().slice(1)).toEqual([
      `POST /me/calendars/${COMMANDER}/events`,
      `PATCH /me/events/${FOCUS_EVENT}`,
    ]);
    // The create always carries its own times, so a retry's POST is the same as the first.
    expect(sent[1]?.body).toHaveProperty('start', {
      dateTime: '2026-10-06T09:00:00.0000000',
      timeZone: 'Europe/London',
    });
    expect(detailOf(result.item).start.at).toBe(Date.UTC(2026, 9, 6, 13));
    expect(detailOf(result.item).calendar.id).toBe(COMMANDER);
    expect(result.item?.commanderItemId).toBe(FOCUS_ID);
  });

  it('refuses a create it can’t make sense of', async () => {
    const source = adapter(script('first-focus-block').fetch);
    const error = await refusal(source, pendingEventExternalId(FOCUS_ID), [
      change(CREATE_FIELD, { ...focusBlock(), commanderId: 'not-a-uuid' }),
    ]);
    expect(error).toBeInstanceOf(WriteRejected);
    expect(sent).toEqual([]);
  });
});

describe('making a busy copy', () => {
  it('puts it on the calendar it names, all day by its days, titled Busy', async () => {
    const replay = script('busy-copy');
    const result = await write(adapter(replay.fetch), pendingEventExternalId(BUSY_ID), [
      change(CREATE_FIELD, {
        kind: 'busy-block',
        calendarId: DEFAULT,
        commanderId: BUSY_ID,
        title: 'Busy',
        start: { at: Date.UTC(2026, 9, 8), timeZone: null, date: '2026-10-08' },
        end: { at: Date.UTC(2026, 9, 9), timeZone: null, date: '2026-10-09' },
        allDay: true,
      } satisfies CommanderEventCreate),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(requests()[1]).toBe(`POST /me/calendars/${DEFAULT}/events`);
    expect(sent[1]?.body).toMatchObject({
      subject: 'Busy',
      start: { dateTime: '2026-10-08T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-09T00:00:00.0000000', timeZone: 'UTC' },
      isAllDay: true,
      transactionId: `busy-block:${BUSY_ID}`,
    });
    expect(result.item?.commanderItemId).toBe(BUSY_ID);
    expect(detailOf(result.item)).toMatchObject({
      calendar: { id: DEFAULT, name: 'Calendar', colour: '#0078d4' },
      allDay: true,
      start: { date: '2026-10-08' },
      end: { date: '2026-10-09' },
      createdByCommander: 'busy-block',
    });
  });
});

describe('moving one', () => {
  it('PATCHes its new start and end, and answers with the event on its calendar', async () => {
    const replay = script('move');
    const result = await write(adapter(replay.fetch), FOCUS_EVENT, [change(MOVE_FIELD, move)]);

    expect(replay.remaining()).toBe(0);
    expect(requests()).toEqual([`PATCH /me/events/${FOCUS_EVENT}`, `GET /me/events/${FOCUS_EVENT}/calendar`]);
    expect(sent[0]?.body).toEqual({
      start: { dateTime: '2026-10-06T14:00:00.0000000', timeZone: 'Europe/London' },
      end: { dateTime: '2026-10-06T15:30:00.0000000', timeZone: 'Europe/London' },
      isAllDay: false,
    });
    expect(result.item?.externalId).toBe(FOCUS_EVENT);
    expect(result.item?.commanderItemId).toBe(FOCUS_ID);
    expect(detailOf(result.item)).toMatchObject({
      calendar: { id: COMMANDER, name: 'Commander', colour: '#4bcfc1' },
      start: { at: Date.UTC(2026, 9, 6, 13) },
      end: { at: Date.UTC(2026, 9, 6, 14, 30) },
    });
    expect(result.cost.requests).toBe(2);
  });

  it('refuses to move an event Outlook no longer has', async () => {
    const error = await refusal(adapter(script('move-gone').fetch), FOCUS_EVENT, [change(MOVE_FIELD, move)]);
    expect(error).toBeInstanceOf(WriteRejected);
  });
});

describe('deleting one', () => {
  it('deletes a confirmed event by its id', async () => {
    const replay = script('delete-confirmed');
    const result = await write(adapter(replay.fetch), FOCUS_EVENT, [change(DELETE_FIELD, true)]);
    expect(replay.remaining()).toBe(0);
    expect(requests()).toEqual([`DELETE /me/events/${FOCUS_EVENT}`]);
    expect(result).toEqual({ item: null, superseded: [], cost: { requests: 1, complexity: null } });
  });

  it('takes an event already gone as deleted', async () => {
    const result = await write(adapter(script('delete-gone').fetch), FOCUS_EVENT, [
      change(DELETE_FIELD, true),
    ]);
    expect(result.item).toBeNull();
  });

  it('never makes an event created and deleted in the same write, deleting it if an earlier attempt made it', async () => {
    const replay = script('delete-placeholder-found');
    const result = await write(adapter(replay.fetch), pendingEventExternalId(FOCUS_ID), [
      change(CREATE_FIELD, focusBlock()),
      change(DELETE_FIELD, true),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(requests()).toEqual([
      `GET /me/events?$filter=singleValueExtendedProperties/Any(ep: ep/id eq '${MARKER}' and ep/value eq 'focus-block:${FOCUS_ID}')&$select=id`,
      `DELETE /me/events/${FOCUS_EVENT}`,
    ]);
    expect(eventPosts()).toEqual([]);
    expect(result.item).toBeNull();
  });

  it('looks a placeholder up by Commander’s marker, of any kind, and deletes nothing when Outlook never got it', async () => {
    const replay = script('delete-placeholder-not-found');
    const result = await write(adapter(replay.fetch), pendingEventExternalId(FOCUS_ID), [
      change(DELETE_FIELD, true),
    ]);

    expect(replay.remaining()).toBe(0);
    expect(sent.map((each) => each.method)).toEqual(['GET', 'GET', 'GET']);
    expect(result).toEqual({ item: null, superseded: [], cost: { requests: 3, complexity: null } });
  });

  it('ignores a delete taken back', async () => {
    const replay = script('move');
    const result = await write(adapter(replay.fetch), FOCUS_EVENT, [
      change(DELETE_FIELD, null),
      change(MOVE_FIELD, move),
    ]);
    expect(requests()[0]).toBe(`PATCH /me/events/${FOCUS_EVENT}`);
    expect(result.item?.externalId).toBe(FOCUS_EVENT);
  });
});

describe('refusals and throttling', () => {
  const deleting = [change(DELETE_FIELD, true)];

  it('takes a 429 for a rate limit, waiting as long as Microsoft asks', async () => {
    const error = await refusal(adapter(script('rate-limited').fetch), FOCUS_EVENT, deleting);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(30_000);
    expect((error as RateLimited).cost).toEqual({ requests: 1, complexity: null });
  });

  it('takes a 401 or 403 for a refused sign-in', async () => {
    expect(await refusal(adapter(script('sign-in-refused').fetch), FOCUS_EVENT, deleting)).toBeInstanceOf(
      SignInRefused,
    );
    expect(await refusal(adapter(script('forbidden').fetch), FOCUS_EVENT, deleting)).toBeInstanceOf(
      SignInRefused,
    );
  });

  it('takes a 400 for a change Outlook refuses, and anything else for a passing outage', async () => {
    const rejected = await refusal(adapter(script('bad-request').fetch), FOCUS_EVENT, [
      change(MOVE_FIELD, move),
    ]);
    expect(rejected).toBeInstanceOf(WriteRejected);
    expect((rejected as Error).message).toMatch(/Outlook/);
    expect(await refusal(adapter(script('unavailable').fetch), FOCUS_EVENT, deleting)).toBeInstanceOf(
      SourceUnavailable,
    );
  });
});

describe('sync recognising Commander’s events', () => {
  it('knows them by their transactionId, naming their Item, and leaves other apps’ transactionIds alone', async () => {
    const saved: SourceItem[] = [];
    const replay = script('sync-recognises-commander-events');
    await adapter(replay.fetch).sync({
      account: ACCOUNT,
      cursor: null,
      mode: 'full',
      accessToken: async () => token,
      save: (page) => saved.push(...page.items),
      signal: new AbortController().signal,
    });

    expect(replay.remaining()).toBe(0);
    const byId = new Map(saved.map((item) => [item.externalId, item]));
    expect(byId.get(FOCUS_EVENT)?.commanderItemId).toBe(FOCUS_ID);
    expect(detailOf(byId.get(FOCUS_EVENT) ?? null).createdByCommander).toBe('focus-block');
    expect(byId.get('AAMkAGI2-evt-busy1=')?.commanderItemId).toBe(BUSY_ID);
    expect(detailOf(byId.get('AAMkAGI2-evt-busy1=') ?? null).createdByCommander).toBe('busy-block');
    expect(byId.get('AAMkAGI2-evt-lunch=')).not.toHaveProperty('commanderItemId');
    expect(detailOf(byId.get('AAMkAGI2-evt-lunch=') ?? null).createdByCommander).toBeNull();
  });

  it('knows them by Commander’s marker too, when an answer carries extended properties', () => {
    const calendar = { id: COMMANDER, name: 'Commander', colour: '#4bcfc1' };
    const event = graphEvent.parse({
      id: FOCUS_EVENT,
      subject: 'Write the quarterly plan',
      start: { dateTime: '2026-10-06T08:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-06T10:00:00.0000000', timeZone: 'UTC' },
      transactionId: null,
      singleValueExtendedProperties: [
        {
          id: 'String {00020329-0000-0000-c000-000000000046} Name CommanderEvent',
          value: `focus-block:${FOCUS_ID}`,
        },
      ],
    });
    const item = toEventItem(event, calendar, ME);
    expect(item.commanderItemId).toBe(FOCUS_ID);
    expect(detailOf(item).createdByCommander).toBe('focus-block');

    const strange = toEventItem(
      graphEvent.parse({
        ...event,
        transactionId: 'meeting-block:not-ours',
        singleValueExtendedProperties: [],
      }),
      calendar,
      ME,
    );
    expect(detailOf(strange).createdByCommander).toBeNull();
    expect(strange).not.toHaveProperty('commanderItemId');
  });
});
