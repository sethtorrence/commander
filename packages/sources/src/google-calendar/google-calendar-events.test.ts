import {
  type CommanderEventCreate,
  type CommanderEventMove,
  CREATE_FIELD,
  DELETE_FIELD,
  type EventDetail,
  MOVE_FIELD,
  pendingEventExternalId,
} from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessToken,
  type FieldChange,
  RateLimited,
  SignInRefused,
  SourceUnavailable,
  WriteRejected,
} from '../source';
import { type CalendarChoices, createGoogleCalendarSource } from './google-calendar-source';
import writes from './recorded/writes.json';
import { googleEvent, toEventItem } from './shapes';

// The Google Calendar adapter writing the events Commander makes (focus blocks and busy copies, #131),
// against recorded Calendar API v3 responses shaped as Google answers. Each recording pins down the
// request Commander must send for it (method, path and, where it matters, the body), in order.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { method: string; path: string; body?: unknown }; response: Recorded };
const recorded = writes as unknown as { [name in keyof typeof writes]: Exchange };

const API = 'https://calendar.test/calendar/v3';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const COMMANDER = 'c_7f3e9a1b5c2d4e6f8a0b1c2d3e4f5a6b@group.calendar.google.com';
const FOCUS_ID = '6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';
const FOCUS_EVENT = '6f1c2a4e8b3d4e5f9a7b1c2d3e4f5a6b';
const SECOND_ID = 'b2e4d6f8-1a3c-4e5d-8f7a-9b0c1d2e3f4a';
const BUSY_ID = 'd4c3b2a1-9f8e-4d7c-a6b5-0e1f2a3b4c5d';
const BUSY_EVENT = 'd4c3b2a19f8e4d7ca6b50e1f2a3b4c5d';
const token: AccessToken = { token: 'ya29.recorded', kind: 'oauth' };

const london = (hour: number, minute = 0) => ({
  at: Date.UTC(2026, 9, 5, hour, minute),
  timeZone: 'Europe/London',
  date: null,
});

const focusBlock: CommanderEventCreate = {
  kind: 'focus-block',
  calendarId: null,
  commanderId: FOCUS_ID,
  title: 'Focus: Write the Q4 plan',
  start: london(12),
  end: london(14),
  allDay: false,
};
const secondFocusBlock: CommanderEventCreate = {
  kind: 'focus-block',
  calendarId: null,
  commanderId: SECOND_ID,
  title: 'Focus: Review the hiring loop',
  start: { at: Date.UTC(2026, 9, 6), timeZone: null, date: '2026-10-06' },
  end: { at: Date.UTC(2026, 9, 7), timeZone: null, date: '2026-10-07' },
  allDay: true,
};
const busyCopy: CommanderEventCreate = {
  kind: 'busy-block',
  calendarId: PRIMARY,
  commanderId: BUSY_ID,
  title: 'Busy',
  start: london(8, 30),
  end: london(9),
  allDay: false,
};
const moved: CommanderEventMove = { start: london(14), end: london(16), allDay: false };

let sent: { method: string; path: string; body: unknown; authorization: string | null }[];
let problems: string[];

beforeEach(() => {
  sent = [];
  problems = [];
});

// Answers each request with the next recording, after checking it is the request recorded. A wrong
// request is noted (a throw inside fetch would read as Google being unreachable) and answered 599.
function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(API.length));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body, authorization: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (!next || next.request.method !== method || next.request.path !== path) {
      problems.push(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
      return new Response(null, { status: 599 });
    }
    if (next.request.body !== undefined && JSON.stringify(body) !== JSON.stringify(next.request.body)) {
      try {
        expect(body).toEqual(next.request.body);
      } catch (error) {
        problems.push(`${method} ${path} sent the wrong body: ${(error as Error).message}`);
      }
    }
    const { status, headers, body: answer } = next.response;
    return new Response(answer === null ? null : JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

// No calendar is switched on: a sync only lists the Account's calendars.
const calendars: CalendarChoices = { listed: () => new Set(), held: () => [] };

const sourceWith = (fetch: typeof globalThis.fetch) =>
  createGoogleCalendarSource({ apiUrl: () => API, calendars, fetch, now: () => NOW });

type Source = ReturnType<typeof sourceWith>;

async function write(source: Source, externalId: string, changes: [string, unknown][]) {
  const write = source.write;
  if (!write) throw new Error('The Google Calendar adapter has no write');
  return write({
    account: ACCOUNT,
    externalId,
    changes: changes.map(([field, value]): FieldChange => ({ field, value, synced: null, madeAt: NOW })),
    accessToken: async () => token,
    signal: new AbortController().signal,
  });
}

// Runs the writes in order on one adapter, checking every recording was asked for, as recorded.
async function run(exchanges: Exchange[], ...writes: [string, [string, unknown][]][]) {
  const recording = replay(exchanges);
  const source = sourceWith(recording.fetch);
  const results = [];
  for (const [externalId, changes] of writes) results.push(await write(source, externalId, changes));
  expect(problems).toEqual([]);
  expect(recording.remaining()).toBe(0);
  return results;
}

const detailOf = (item: { detail?: unknown } | null) => item?.detail as EventDetail;
const pending = pendingEventExternalId(FOCUS_ID);
const confirmed = `${COMMANDER}/${FOCUS_EVENT}`;

describe('making a focus block', () => {
  it('makes the Commander calendar on first use, then inserts the event with Commander’s id, marked, private and busy', async () => {
    const [result] = await run(
      [recorded.calendarListWithoutCommander, recorded.makeCommanderCalendar, recorded.insertFocusBlock],
      [pending, [[CREATE_FIELD, focusBlock]]],
    );

    expect(sent.every((request) => request.authorization === 'Bearer ya29.recorded')).toBe(true);
    expect(result?.cost.requests).toBe(3);
    expect(result?.superseded).toEqual([]);
    expect(result?.item).toMatchObject({
      externalId: confirmed,
      kind: 'event',
      title: 'Focus: Write the Q4 plan',
      commanderItemId: FOCUS_ID,
    });
    expect(detailOf(result?.item ?? null)).toMatchObject({
      calendar: { id: COMMANDER, name: 'Commander', colour: '#4285f4' },
      accountEmail: PRIMARY,
      start: { at: Date.UTC(2026, 9, 5, 12), timeZone: 'Europe/London', date: null },
      end: { at: Date.UTC(2026, 9, 5, 14), timeZone: 'Europe/London', date: null },
      allDay: false,
      busy: true,
      private: true,
      description: null,
      attendees: [],
      createdByCommander: 'focus-block',
    });
  });

  it('reuses the Commander calendar the Account lists (its own, not one shared with it), and remembers it for the next write', async () => {
    const [first, second] = await run(
      [recorded.calendarListWithCommander, recorded.insertFocusBlock, recorded.insertSecondFocusBlock],
      [pending, [[CREATE_FIELD, focusBlock]]],
      [pendingEventExternalId(SECOND_ID), [[CREATE_FIELD, secondFocusBlock]]],
    );

    expect(first?.cost.requests).toBe(2);
    expect(detailOf(first?.item ?? null).calendar).toEqual({
      id: COMMANDER,
      name: 'Commander',
      colour: '#7986cb',
    });
    expect(second?.cost.requests).toBe(1);
    expect(second?.item).toMatchObject({
      externalId: `${COMMANDER}/b2e4d6f81a3c4e5d8f7a9b0c1d2e3f4a`,
      commanderItemId: SECOND_ID,
    });
    expect(detailOf(second?.item ?? null)).toMatchObject({
      allDay: true,
      start: { date: '2026-10-06' },
      end: { date: '2026-10-07' },
    });
  });

  it('needs no calendar list when the last sync already listed the Commander calendar', async () => {
    const recording = replay([recorded.calendarListWithCommander, recorded.insertFocusBlock]);
    const source = sourceWith(recording.fetch);
    await source.sync({
      account: ACCOUNT,
      cursor: null,
      mode: 'full',
      accessToken: async () => token,
      save: () => {},
      signal: new AbortController().signal,
    });
    const result = await write(source, pending, [[CREATE_FIELD, focusBlock]]);

    expect(problems).toEqual([]);
    expect(recording.remaining()).toBe(0);
    expect(result.cost.requests).toBe(1);
    expect(detailOf(result.item).calendar.colour).toBe('#7986cb');
  });

  it('takes a 409 to a retried insert for the event it made before: reads that one rather than making a second', async () => {
    const [result] = await run(
      [recorded.calendarListWithCommander, recorded.insertFocusBlockAgain, recorded.getFocusBlock],
      [pending, [[CREATE_FIELD, focusBlock]]],
    );

    expect(result?.item).toMatchObject({ externalId: confirmed, commanderItemId: FOCUS_ID });
    expect(sent.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('finds or makes the Commander calendar again when the one it remembered has gone (404)', async () => {
    const [, again] = await run(
      [
        recorded.calendarListWithCommander,
        recorded.insertFocusBlock,
        recorded.insertFocusBlockIntoGoneCalendar,
        recorded.calendarListWithoutCommander,
        recorded.makeCommanderCalendar,
        recorded.insertFocusBlock,
      ],
      [pending, [[CREATE_FIELD, focusBlock]]],
      [pending, [[CREATE_FIELD, focusBlock]]],
    );

    expect(again?.cost.requests).toBe(4);
    expect(again?.item?.externalId).toBe(confirmed);
  });

  it('makes an event moved before it reached Google at its new time', async () => {
    const [result] = await run(
      [recorded.calendarListWithCommander, recorded.insertMovedFocusBlock],
      [
        pending,
        [
          [CREATE_FIELD, focusBlock],
          [MOVE_FIELD, moved],
        ],
      ],
    );

    expect(detailOf(result?.item ?? null).start.at).toBe(Date.UTC(2026, 9, 5, 14));
  });

  it('moves an event Google already had from an earlier attempt to its new time', async () => {
    const conflict: Exchange = {
      request: recorded.insertMovedFocusBlock.request,
      response: recorded.insertFocusBlockAgain.response,
    };
    const [result] = await run(
      [recorded.calendarListWithCommander, conflict, recorded.patchFocusBlock],
      [
        pending,
        [
          [CREATE_FIELD, focusBlock],
          [MOVE_FIELD, moved],
        ],
      ],
    );

    expect(detailOf(result?.item ?? null).start.at).toBe(Date.UTC(2026, 9, 5, 14));
  });

  it('ignores a delete taken back', async () => {
    const [result] = await run(
      [recorded.calendarListWithCommander, recorded.insertFocusBlock],
      [
        pending,
        [
          [CREATE_FIELD, focusBlock],
          [DELETE_FIELD, null],
        ],
      ],
    );

    expect(result?.item?.externalId).toBe(confirmed);
  });

  it('refuses a create it can’t make sense of, sending nothing', async () => {
    const error = await write(sourceWith(replay([]).fetch), pending, [
      [CREATE_FIELD, { kind: 'focus-block', title: '' }],
    ]).catch((caught) => caught);

    expect(error).toBeInstanceOf(WriteRejected);
    expect(sent).toEqual([]);
  });
});

describe('busy copies', () => {
  it('puts a busy copy on the calendar it names, without looking for the Commander calendar', async () => {
    const [result] = await run(
      [recorded.insertBusyCopy],
      [pendingEventExternalId(BUSY_ID), [[CREATE_FIELD, busyCopy]]],
    );

    expect(result?.cost.requests).toBe(1);
    expect(result?.item).toMatchObject({
      externalId: `${PRIMARY}/${BUSY_EVENT}`,
      title: 'Busy',
      commanderItemId: BUSY_ID,
    });
    expect(detailOf(result?.item ?? null)).toMatchObject({
      calendar: { id: PRIMARY },
      busy: true,
      private: true,
      createdByCommander: 'busy-block',
    });
  });
});

describe('moving', () => {
  it('patches a confirmed event’s start and end', async () => {
    const [result] = await run([recorded.patchFocusBlock], [confirmed, [[MOVE_FIELD, moved]]]);

    expect(result?.cost.requests).toBe(1);
    expect(result?.item).toMatchObject({ externalId: confirmed, commanderItemId: FOCUS_ID });
    expect(detailOf(result?.item ?? null)).toMatchObject({
      calendar: { id: COMMANDER, name: 'Commander' },
      start: { at: Date.UTC(2026, 9, 5, 14) },
      end: { at: Date.UTC(2026, 9, 5, 16) },
    });
  });
});

describe('deleting', () => {
  it('deletes a confirmed event', async () => {
    const [result] = await run([recorded.deleteFocusBlock], [confirmed, [[DELETE_FIELD, true]]]);

    expect(result).toEqual({ item: null, superseded: [], cost: { requests: 1, complexity: null } });
  });

  it('takes an event Google has already deleted (410) as gone', async () => {
    const [result] = await run([recorded.deleteDeletedFocusBlock], [confirmed, [[DELETE_FIELD, true]]]);

    expect(result?.item).toBeNull();
  });

  it('deletes an event whose creation was never confirmed, when it did reach Google', async () => {
    const [result] = await run(
      [recorded.calendarListWithCommander, recorded.deleteFocusBlock, recorded.deleteMissingFromPrimary],
      [pending, [[DELETE_FIELD, true]]],
    );

    expect(result?.item).toBeNull();
  });

  it('takes a 404 for an event whose creation never reached Google as nothing to delete', async () => {
    const [result] = await run(
      [
        recorded.calendarListWithCommander,
        recorded.deleteMissingFocusBlock,
        recorded.deleteMissingFromPrimary,
      ],
      [pending, [[DELETE_FIELD, true]]],
    );

    expect(result?.item).toBeNull();
  });

  it('looks only on the main calendar (for a busy copy) when the Account has no Commander calendar', async () => {
    const [result] = await run(
      [recorded.calendarListWithoutCommander, recorded.deleteMissingFromPrimary],
      [pending, [[DELETE_FIELD, true]]],
    );

    expect(result?.item).toBeNull();
  });

  it('never makes an event created and deleted in one write, only makes sure it’s gone', async () => {
    await run(
      [recorded.calendarListWithCommander, recorded.deleteMissingFocusBlock],
      [
        pending,
        [
          [CREATE_FIELD, focusBlock],
          [MOVE_FIELD, moved],
          [DELETE_FIELD, true],
        ],
      ],
    );

    expect(sent.some((request) => request.method === 'POST')).toBe(false);
  });

  it('looks for a busy copy created and deleted in one write on the calendar it names', async () => {
    const missing: Exchange = {
      request: { method: 'DELETE', path: `/calendars/${PRIMARY}/events/${BUSY_EVENT}` },
      response: recorded.deleteMissingFocusBlock.response,
    };
    const [result] = await run(
      [missing],
      [
        pendingEventExternalId(BUSY_ID),
        [
          [CREATE_FIELD, busyCopy],
          [DELETE_FIELD, true],
        ],
      ],
    );

    expect(result?.item).toBeNull();
  });
});

describe('refusals', () => {
  it.each([
    ['a 429', recorded.insertRateLimited, RateLimited],
    ['a 403 userRateLimitExceeded', recorded.insertQuotaRefused, RateLimited],
    ['a 401', recorded.insertSignInRefused, SignInRefused],
    ['any other 403', recorded.insertForbidden, SignInRefused],
    ['a 400', recorded.insertBadRequest, WriteRejected],
    ['a 503', recorded.insertUnavailable, SourceUnavailable],
  ] as const)('takes %s as Google would mean it', async (_, refusal, kind) => {
    const recording = replay([recorded.calendarListWithCommander, refusal]);
    const error = await write(sourceWith(recording.fetch), pending, [[CREATE_FIELD, focusBlock]]).catch(
      (caught) => caught,
    );

    expect(problems).toEqual([]);
    expect(error).toBeInstanceOf(kind);
  });

  it('waits as long as Google asks after a 429', async () => {
    const recording = replay([recorded.calendarListWithCommander, recorded.insertRateLimited]);
    const error = await write(sourceWith(recording.fetch), pending, [[CREATE_FIELD, focusBlock]]).catch(
      (caught) => caught,
    );

    expect((error as RateLimited).retryAfterMs).toBe(30_000);
  });
});

describe('sync recognising Commander’s events', () => {
  const calendar = { id: COMMANDER, name: 'Commander', colour: '#7986cb' };
  const answered = recorded.getFocusBlock.response.body as Record<string, unknown>;

  it('names the Item of an event Commander made', () => {
    const item = toEventItem(googleEvent.parse(answered), calendar, null, PRIMARY);

    expect(item.commanderItemId).toBe(FOCUS_ID);
    expect(detailOf(item).createdByCommander).toBe('focus-block');
  });

  it('names none for an event without Commander’s mark, or with a garbled one', () => {
    const unmarked = toEventItem(
      googleEvent.parse({ ...answered, extendedProperties: undefined }),
      calendar,
      null,
      PRIMARY,
    );
    const garbled = toEventItem(
      googleEvent.parse({ ...answered, extendedProperties: { private: { commanderId: 'not-an-id' } } }),
      calendar,
      null,
      PRIMARY,
    );

    expect(unmarked.commanderItemId).toBeUndefined();
    expect(garbled.commanderItemId).toBeUndefined();
  });
});
