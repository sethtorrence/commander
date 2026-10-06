import {
  COMMANDER_CALENDAR_NAME,
  type CommanderEventCreate,
  type CommanderEventKind,
  type CommanderEventMove,
  CREATE_FIELD,
  commanderEventCreate,
  commanderEventKinds,
  commanderEventMove,
  DELETE_FIELD,
  type EventCalendar,
  isPendingEventExternalId,
  MOVE_FIELD,
  pendingEventExternalId,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import {
  type CalendarChoices,
  WINDOW_AHEAD_DAYS,
  WINDOW_BACK_DAYS,
} from '../google-calendar/google-calendar-source';
import type { ListedCalendar } from '../google-calendar/shapes';
import { type Gate, MAILBOX_CONCURRENCY, mailboxGate } from '../outlook/mailbox-gate';
import {
  type AccessToken,
  type Cadence,
  CursorExpired,
  type FieldChange,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  type StoredItem,
  type Superseded,
  type SyncCost,
  type SyncRequest,
  WriteRejected,
  type WriteRequest,
  type WriteResult,
} from '../source';
import {
  COMMANDER_EVENT_PROPERTY,
  calendarsPage,
  commanderEventTag,
  eventsPage,
  type GraphCalendar,
  type GraphEvent,
  graphCalendar,
  graphEvent,
  graphTime,
  isGone,
  responseOf,
  toEventItem,
  toListedCalendar,
} from './shapes';
import { zonedInstant } from './time-zones';

// Outlook Calendar as a Source: the events on each calendar of an Outlook Account the User has on,
// through Microsoft Graph v1.0 over fetch (decisions #3, #17, #20, #30). Change notifications need a
// public endpoint, so Commander polls, every 15 minutes, with delta queries:
//
// - Every sync lists the Account's calendars (`/me/calendars`), which the Item store keeps for
//   Settings → Accounts and answers which are on (the default calendar and the User's own; shared,
//   holiday and birthday calendars off).
// - Each calendar on is read with `/me/calendars/{id}/calendarView/delta`, which expands recurring
//   events into their instances, over the same window as Google Calendar (30 days back to 12 months
//   ahead), then from the delta link Graph hands back, kept per calendar in the cursor. Every request
//   asks for immutable ids, so an event moved to another calendar keeps its Item.
// - A delta's window is fixed when it starts, so once its start is more than 7 days old the calendar
//   starts a fresh delta: a quiet full re-read that saves only what changed and tombstones held events
//   in the new window that it no longer returns.
// - Removed (`@removed`) and cancelled events become tombstones; removing a series takes every held
//   instance of it.
// - An expired or invalid delta link (410, SyncStateNotFound, resyncRequired) raises CursorExpired, and
//   the engine syncs the Account's calendars again from scratch. 429s, and 503s with Retry-After, raise
//   RateLimited, and the engine waits as long as Microsoft asked.
// - Calendars are read side by side, but no more than 4 requests run at once per mailbox (Outlook's
//   limit), shared by every sync and write of the Account.
//
// It also writes the events Commander makes itself (#131, commander-events.ts): focus blocks, in a
// calendar named "Commander" it finds among the Account's own calendars or makes on first use (and
// remembers, per Account, until Graph says it's gone), and busy copies on the calendar the Core names.
// Each is busy, private and without a reminder, and carries Commander's id for it twice: as its
// `transactionId` (`<kind>:<id>`), so Graph hands back the event it already made when a create is
// retried rather than making a second, and as Commander's marker, an extended property Graph can find
// it by while its Item still holds a placeholder external id. Sync can't read extended properties
// (calendarView and delta won't expand them), so it knows Commander's events by their transactionId.
// A move PATCHes the new times; a delete deletes the event, wherever it got to.
//
// Answering invitations (#129, Two-way sync): the synced fields `response` (this event) and
// `seriesResponse` (the whole series an instance belongs to), judged against the event as Graph has it
// now: an answer Outlook already has is skipped, and one given in Outlook since Commander last saw it,
// later than the User answered (by `responseStatus.time`), wins. The rest go as `accept`,
// `tentativelyAccept` or `decline` with `sendResponse: true`, so the organiser hears; the series
// through its series master first, then the instance only if it didn't follow. Graph has no way to
// take an answer back to "not answered", so that one is refused (Couldn't sync).

export const OUTLOOK_CALENDAR_CADENCE: Cadence = { defaultMinutes: 15, choices: [15, 30, 60] };
export const MAX_CONCURRENT_REQUESTS = MAILBOX_CONCURRENCY;
// A delta restarts once its window's start is older than this.
export const RESTART_AFTER_DAYS = 7;

export type OutlookCalendarSourceOptions = {
  // Graph's base (https://graph.microsoft.com/v1.0); read per sync, so the end-to-end tests can point
  // it at a fake.
  graphUrl: () => string;
  calendars: CalendarChoices;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const DAY_MS = 24 * 60 * 60_000;
const PAGE_SIZE = 50;
const CALENDARS_PATH = '/me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit,owner&$top=50';
// Every request asks for immutable ids, and events a page at a time.
const PREFER = `IdType="ImmutableId", odata.maxpagesize=${PAGE_SIZE}`;
// Writes, and their look-ups, ask for immutable ids alone.
const WRITE_PREFER = 'IdType="ImmutableId"';
// Outlook's colour for a calendar Commander can't find in the Account's list.
const OUTLOOK_BLUE = '#0078d4';

// Per calendar: the delta link to read from next (null: read it in full), and when its delta started
// (its window runs from 30 days before that to 12 months after).
const calendarMark = z.object({ deltaLink: z.string().nullable(), since: z.number() });
const outlookCalendarCursor = z.object({ calendars: z.record(z.string(), calendarMark) });
export type OutlookCalendarCursor = z.infer<typeof outlookCalendarCursor>;
type CalendarMark = z.infer<typeof calendarMark>;

const graphError = z
  .object({ error: z.object({ code: z.string().nullish(), message: z.string().nullish() }).nullish() })
  .nullish();

// Graph's ways of saying a delta link can't be used any more.
const RESYNC_CODES = new Set(['syncstatenotfound', 'syncstateinvalid', 'resyncrequired']);

// One calendar Graph won't let Commander read (404 gone, 403 not allowed): skipped this sync.
class CalendarUnreadable extends Error {
  override name = 'CalendarUnreadable';
}

const iso = (time: number) => new Date(time).toISOString();

type Window = { min: number; max: number };

const overlaps = (item: Pick<SourceItem, 'detail'> | StoredItem, window: Window) => {
  const detail = item.detail?.kind === 'event' ? item.detail : null;
  return !!detail && detail.end.at > window.min && detail.start.at < window.max;
};

// JSON with object keys in order, for telling whether an event changed.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${stable(each)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const unchanged = (item: SourceItem, stored: StoredItem | undefined) =>
  !!stored &&
  stored.title === item.title &&
  stored.status === item.status &&
  stable(stored.people) === stable(item.people ?? []) &&
  stable(stored.detail) === stable(item.detail ?? null);

// What a request is for, which decides what some refusals mean. `calendar`: it reads one calendar's
// events, so a refusal is that calendar's alone. `write`: it changes (or looks up) an event Commander
// made, so a 400 is Outlook refusing the change. `missing`: a 404 answers null, for the caller to
// decide what a thing gone means.
// `calendar`: the request reads one calendar's events, so a refusal is that calendar's alone; `write`:
// it is made for a write; `missing`: a 404 answers null; `event`: it reads or answers one event the
// User is invited to (#129), so a 404 means it is gone and a refusal is final (both WriteRejected).
type Purpose = { calendar?: boolean; write?: boolean; missing?: boolean; event?: boolean };

function connect(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
  now: () => number,
  run: Gate,
  request: Pick<SyncRequest, 'accessToken'>,
  signal: AbortSignal,
) {
  const cost: SyncCost = { requests: 0, complexity: null };
  const base = baseUrl.replace(/\/$/, '');

  // Sends one request to a path under Graph's base, or a link Graph gave, through the mailbox's gate.
  async function call<T>(
    method: string,
    pathOrLink: string,
    payload: unknown,
    shape: z.ZodType<T>,
    about: Purpose,
  ): Promise<T | null> {
    const url = pathOrLink.startsWith('/') ? `${base}${pathOrLink}` : pathOrLink;
    // A link anywhere else would carry the User's token off Graph.
    if (!url.startsWith(`${base}/`)) {
      throw new SourceUnavailable('Outlook Calendar sent a link Commander didn’t expect.', cost);
    }
    return run(async () => {
      signal.throwIfAborted();
      const token: AccessToken = await request.accessToken();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token.token}`,
            accept: 'application/json',
            prefer: about.write ? WRITE_PREFER : PREFER,
            ...(payload !== undefined && { 'content-type': 'application/json' }),
          },
          ...(payload !== undefined && { body: JSON.stringify(payload) }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SourceUnavailable('Commander couldn’t reach Outlook Calendar.', cost);
      }
      cost.requests += 1;
      // An answer to an invitation (#129) answers 202 with nothing worth reading.
      if (response.ok && about.event && method === 'POST') return undefined as T;
      if (response.ok) {
        // A DELETE answers 204, with nothing at all.
        const text = await response.text().catch(() => '');
        let answer: unknown;
        try {
          answer = text ? JSON.parse(text) : null;
        } catch {
          answer = undefined;
        }
        const parsed = shape.safeParse(answer);
        if (!parsed.success) {
          throw new SourceUnavailable('Outlook Calendar sent an answer Commander didn’t understand.', cost);
        }
        return parsed.data;
      }
      const body = graphError.safeParse(await response.json().catch(() => null));
      const code = (body.success ? (body.data?.error?.code ?? '') : '').toLowerCase();
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
      if (response.status === 429 || (response.status === 503 && retryAfter !== null)) {
        throw new RateLimited(
          'Microsoft asked Commander to check Outlook Calendar less often.',
          retryAfter,
          cost,
        );
      }
      if ((response.status === 404 || response.status === 410) && about.event) {
        throw new WriteRejected('This event is no longer in Outlook.');
      }
      if ((response.status === 400 || response.status === 403) && about.event) {
        const message = body.success ? body.data?.error?.message : null;
        throw new WriteRejected(`Outlook wouldn’t take this answer${message ? `: ${message}` : '.'}`);
      }
      if (!about.write && (response.status === 410 || RESYNC_CODES.has(code))) {
        throw new CursorExpired('Outlook Calendar no longer accepts this calendar’s delta link.');
      }
      if (response.status === 401)
        throw new SignInRefused('Microsoft refused this Outlook Account’s sign-in.');
      if ((response.status === 403 || response.status === 404) && about.calendar) {
        throw new CalendarUnreadable(`Outlook wouldn’t share a calendar (HTTP ${response.status}).`);
      }
      if (response.status === 404 && about.missing) return null;
      if (response.status === 403) {
        throw new SignInRefused(
          about.write
            ? 'Microsoft no longer lets Commander change this Account’s calendars.'
            : 'Microsoft no longer lets Commander read this Account’s calendars.',
        );
      }
      if (response.status === 400 && about.write) {
        throw new WriteRejected('Outlook Calendar refused this change to an event Commander made.');
      }
      throw new SourceUnavailable(
        `Outlook Calendar couldn’t answer just now (HTTP ${response.status}).`,
        cost,
      );
    });
  }

  // GETs what a sync reads.
  async function get<T>(pathOrLink: string, shape: z.ZodType<T>, about: { calendar?: boolean } = {}) {
    return (await call('GET', pathOrLink, undefined, shape, about)) as T;
  }

  // Sends what a write needs, its look-ups too. `missing`: a 404 answers null rather than failing.
  function send<T>(method: string, path: string, payload: unknown, shape: z.ZodType<T>): Promise<T>;
  function send<T>(
    method: string,
    path: string,
    payload: unknown,
    shape: z.ZodType<T>,
    about: { missing: true },
  ): Promise<T | null>;
  function send<T>(
    method: string,
    path: string,
    payload: unknown,
    shape: z.ZodType<T>,
    about: { missing?: boolean } = {},
  ): Promise<T | null> {
    return call(method, path, payload, shape, { ...about, write: true });
  }

  // Reads one event the User is invited to, or (with `payload`) POSTs an answer to it (#129).
  async function event<T>(path: string, shape: z.ZodType<T>, payload?: unknown): Promise<T> {
    const method = payload === undefined ? 'GET' : 'POST';
    return (await call(method, path, payload, shape, { event: true })) as T;
  }

  return { get, send, event, cost, base };
}
type Api = ReturnType<typeof connect>;

// ---------------------------------------------------------------------------------------------
// Writing Commander's events

// What a write last learnt of an Account's calendars: their names and colours, who the User is (the
// default calendar's owner), and the Commander calendar's id once found or made.
type KnownCalendars = { me: string | null; calendars: Map<string, EventCalendar>; commander: string | null };

const eventPath = (id: string) => `/me/events/${encodeURIComponent(id)}`;
const found = z.object({ value: z.array(z.object({ id: z.string().min(1) })).default([]) });

// Lists the Account's calendars, finding the Commander calendar among them: by its exact name, and
// one the User can write to (a colleague's shared "Commander" calendar isn't theirs).
async function listCalendars(api: Api): Promise<KnownCalendars> {
  const all: GraphCalendar[] = [];
  for (let link: string | null = CALENDARS_PATH; link; ) {
    const page: z.infer<typeof calendarsPage> = await api.send('GET', link, undefined, calendarsPage);
    all.push(...page.value);
    link = page['@odata.nextLink'] ?? null;
  }
  const me = all.find((calendar) => calendar.isDefaultCalendar)?.owner?.address?.trim() || null;
  const calendars = new Map<string, EventCalendar>();
  for (const calendar of all) {
    const { id, name, colour } = toListedCalendar(calendar, me);
    calendars.set(id, { id, name, colour });
  }
  const commander =
    all.find((calendar) => calendar.name === COMMANDER_CALENDAR_NAME && calendar.canEdit === true)?.id ??
    null;
  return { me, calendars, commander };
}

// The Account's calendars with the one an event goes on among them (the Commander calendar for null,
// made if the Account has none): from memory when it has that calendar, otherwise listed afresh.
async function calendarsFor(
  api: Api,
  remembered: KnownCalendars | undefined,
  calendarId: string | null,
): Promise<{ known: KnownCalendars; fresh: boolean }> {
  const has = (known: KnownCalendars) => (calendarId ? known.calendars.has(calendarId) : !!known.commander);
  if (remembered && has(remembered)) return { known: remembered, fresh: false };
  const known = await listCalendars(api);
  if (!calendarId && !known.commander) {
    const made = await api.send('POST', '/me/calendars', { name: COMMANDER_CALENDAR_NAME }, graphCalendar);
    const { id, name, colour } = toListedCalendar(made, known.me);
    known.calendars.set(id, { id, name, colour });
    known.commander = id;
  }
  return { known, fresh: true };
}

// The ids of the events carrying Commander's marker for the event: one of a kind when the write says
// which, otherwise each kind in turn (Graph's filter on extended properties takes one value at a time).
async function markedEvents(api: Api, commanderId: string, kind: CommanderEventKind | undefined) {
  for (const each of kind ? [kind] : commanderEventKinds) {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${COMMANDER_EVENT_PROPERTY}' and ep/value eq '${commanderEventTag(each, commanderId)}')`;
    const answer = await api.send(
      'GET',
      `/me/events?$filter=${encodeURIComponent(filter)}&$select=id`,
      undefined,
      found,
    );
    if (answer.value.length) return answer.value.map((event) => event.id);
  }
  return [];
}

// Moves an event; Outlook no longer having it is a change that can't be made.
async function moveEvent(api: Api, id: string, move: CommanderEventMove): Promise<GraphEvent> {
  const body = {
    start: graphTime(move.start, move.allDay),
    end: graphTime(move.end, move.allDay),
    isAllDay: move.allDay,
  };
  const moved = await api.send('PATCH', eventPath(id), body, graphEvent, { missing: true });
  if (!moved) throw new WriteRejected('Outlook no longer has this event, so Commander couldn’t move it.');
  return moved;
}

/**
 * Carries out one Commander event's queued `create`, `time` and `delete`, returning the event as Outlook
 * has it afterwards (null once deleted). `memory`: what earlier writes learnt of the Account's calendars.
 *
 * - A delete wins over everything else in the write: a create queued with it is never sent. A
 *   placeholder external id means the create may or may not have reached Graph (its answer lost), so
 *   the event is looked up by Commander's marker and deleted if found.
 * - A create is always sent with its own times, and a move queued with it follows as a PATCH: a retry
 *   of the create then sends exactly the same POST, which Graph matches to the event it already made by
 *   the transactionId (answering with that event, perhaps at the old times, which the PATCH corrects).
 * - A move alone PATCHes the event (found by its marker while its id is still a placeholder).
 */
async function writeEvent(
  api: Api,
  request: WriteRequest,
  memory: { get(): KnownCalendars | undefined; set(known: KnownCalendars | null): void },
): Promise<SourceItem | null> {
  const latest = (field: string) => request.changes.findLast((change) => change.field === field)?.value;
  const created = latest(CREATE_FIELD);
  const moved = latest(MOVE_FIELD);
  const pending = isPendingEventExternalId(request.externalId);
  const placeholderId = request.externalId.slice(pendingEventExternalId('').length);

  if (latest(DELETE_FIELD)) {
    const draft = commanderEventCreate.safeParse(created).data;
    const ids = pending
      ? await markedEvents(api, draft?.commanderId ?? placeholderId, draft?.kind)
      : [request.externalId];
    // An event already gone is as good as deleted.
    for (const id of ids) await api.send('DELETE', eventPath(id), undefined, z.unknown(), { missing: true });
    return null;
  }

  let move: CommanderEventMove | null = null;
  if (moved) {
    const parsed = commanderEventMove.safeParse(moved);
    if (!parsed.success) throw new WriteRejected('Commander couldn’t make sense of this event’s new time.');
    move = parsed.data;
  }

  if (created) {
    const parsed = commanderEventCreate.safeParse(created);
    if (!parsed.success) throw new WriteRejected('Commander couldn’t make sense of this new event.');
    const draft = parsed.data;
    const { event, calendar, me } = await createEvent(api, draft, memory);
    const final = move ? await moveEvent(api, event.id, move) : event;
    return { ...toEventItem(final, calendar, me), commanderItemId: draft.commanderId };
  }

  if (move) {
    let id = request.externalId;
    if (pending) {
      const [first] = await markedEvents(api, placeholderId, undefined);
      if (!first) throw new WriteRejected('Outlook doesn’t have this event, so Commander couldn’t move it.');
      id = first;
    }
    const event = await moveEvent(api, id, move);
    // Which calendar it's on: the answer doesn't say. Commander's events are on the User's own
    // calendars, so its owner is the User.
    const on = await api.send('GET', `${eventPath(id)}/calendar`, undefined, graphCalendar, {
      missing: true,
    });
    if (!on) return null;
    const me = on.owner?.address?.trim() || null;
    const { name, colour } = toListedCalendar(on, me);
    return toEventItem(event, { id: on.id, name, colour }, me);
  }
  return null;
}

// Makes the event on its calendar. A remembered calendar Graph says is gone (404) is forgotten and
// found or made once more; one Graph says is gone straight after listing it can't take the event.
async function createEvent(
  api: Api,
  draft: CommanderEventCreate,
  memory: { get(): KnownCalendars | undefined; set(known: KnownCalendars | null): void },
): Promise<{ event: GraphEvent; calendar: EventCalendar; me: string | null }> {
  const tag = commanderEventTag(draft.kind, draft.commanderId);
  // A meeting (#132) is an ordinary event with its guests (Outlook sends their invitations) and the
  // User's own reminder; focus blocks and busy copies are private and quiet.
  const meeting = draft.kind === 'meeting';
  const body = {
    subject: draft.title,
    start: graphTime(draft.start, draft.allDay),
    end: graphTime(draft.end, draft.allDay),
    isAllDay: draft.allDay,
    showAs: 'busy',
    ...(meeting
      ? {
          attendees: (draft.attendees ?? []).map((guest) => ({
            emailAddress: { address: guest.email, ...(guest.name ? { name: guest.name } : {}) },
            type: 'required',
          })),
        }
      : { sensitivity: 'private', isReminderOn: false }),
    transactionId: tag,
    singleValueExtendedProperties: [{ id: COMMANDER_EVENT_PROPERTY, value: tag }],
  };
  for (;;) {
    const { known, fresh } = await calendarsFor(api, memory.get(), draft.calendarId);
    memory.set(known);
    const calendarId = draft.calendarId ?? known.commander ?? '';
    const event = await api.send(
      'POST',
      `/me/calendars/${encodeURIComponent(calendarId)}/events`,
      body,
      graphEvent,
      { missing: true },
    );
    const calendar = known.calendars.get(calendarId) ?? {
      id: calendarId,
      name: 'Calendar',
      colour: OUTLOOK_BLUE,
    };
    if (event) return { event, calendar, me: known.me };
    memory.set(null);
    if (fresh) {
      throw new WriteRejected(
        draft.calendarId
          ? `Outlook no longer has the calendar this ${meeting ? 'event' : 'busy copy'} goes on.`
          : 'Outlook wouldn’t let Commander use its Commander calendar.',
      );
    }
  }
}

// What getSchedule answers: each guest's busy times, or why Graph couldn't say. Busy, tentative and
// away (out of office) hold their time; free and working elsewhere don't.
const graphWhen = z.object({ dateTime: z.string(), timeZone: z.string().nullish() });
const scheduleAnswer = z.object({
  value: z
    .array(
      z.object({
        scheduleId: z.string(),
        scheduleItems: z
          .array(z.object({ status: z.string().nullish(), start: graphWhen, end: graphWhen }))
          .nullish(),
        error: z.object({ message: z.string().nullish(), responseCode: z.string().nullish() }).nullish(),
      }),
    )
    .default([]),
});
const BUSY_STATUSES = new Set(['busy', 'tentative', 'oof']);

export function createOutlookCalendarSource({
  graphUrl,
  calendars: choices,
  fetch = globalThis.fetch,
  now = Date.now,
}: OutlookCalendarSourceOptions): SourceAdapter {
  // One gate per mailbox, shared by every sync and write of the Account, its mail's too.
  const gateOf = mailboxGate;
  // Per Account, what writes have learnt of its calendars (the Commander calendar's id above all), kept
  // in memory only: a restart finds it again by name.
  const knownCalendars = new Map<string, KnownCalendars>();

  return {
    source: 'outlook-calendar',
    cadence: OUTLOOK_CALENDAR_CADENCE,

    // Guests' free/busy (#132): Graph's getSchedule, which only work and school accounts have, for
    // people in the User's organisation. A refusal, or a guest Graph can't find, is said per guest.
    async freeBusy(request) {
      const api = connect(graphUrl(), fetch, now, gateOf(request.account), request, request.signal);
      const utc = (at: number) => ({ dateTime: new Date(at).toISOString().slice(0, 19), timeZone: 'UTC' });
      let answer: z.infer<typeof scheduleAnswer>;
      try {
        answer = await api.send(
          'POST',
          '/me/calendar/getSchedule',
          {
            schedules: request.emails,
            startTime: utc(request.from),
            endTime: utc(request.to),
            availabilityViewInterval: 30,
          },
          scheduleAnswer,
        );
      } catch (error) {
        if (request.signal.aborted) throw error;
        const problem = 'Microsoft wouldn’t share free/busy.';
        return { calendars: request.emails.map((email) => ({ email, busy: null, problem })), cost: api.cost };
      }
      const byEmail = new Map(answer.value.map((each) => [each.scheduleId.toLowerCase(), each]));
      return {
        calendars: request.emails.map((email) => {
          const schedule = byEmail.get(email.toLowerCase());
          if (!schedule || schedule.error) {
            const problem = schedule?.error?.message?.trim() || 'Microsoft couldn’t say.';
            return { email, busy: null, problem };
          }
          const busy = (schedule.scheduleItems ?? [])
            .filter((item) => BUSY_STATUSES.has(item.status ?? 'busy'))
            .map((item) => ({
              start: zonedInstant(item.start.dateTime, item.start.timeZone),
              end: zonedInstant(item.end.dateTime, item.end.timeZone),
            }))
            .filter(
              (each) => Number.isFinite(each.start) && Number.isFinite(each.end) && each.end > each.start,
            )
            .sort((a, b) => a.start - b.start);
          return { email, busy, problem: null };
        }),
        cost: api.cost,
      };
    },

    async write(request) {
      const { account } = request;
      const api = connect(graphUrl(), fetch, now, gateOf(account), request, request.signal);
      // Answers to invitations (#129) are synced fields of events Commander didn't make.
      if (request.changes.some((change) => RSVP_FIELDS.has(change.field)))
        return answerInvitation(api, request);
      const item = await writeEvent(api, request, {
        get: () => knownCalendars.get(account),
        set: (known) => (known ? knownCalendars.set(account, known) : knownCalendars.delete(account)),
      });
      return { item, superseded: [], cost: api.cost };
    },

    async sync(request) {
      const { account } = request;
      // Stops the other calendars' reads once one fails, or when the sync is no longer wanted.
      const stop = new AbortController();
      const onAbort = () => stop.abort(request.signal.reason);
      if (request.signal.aborted) onAbort();
      request.signal.addEventListener('abort', onAbort, { once: true });
      const api = connect(graphUrl(), fetch, now, gateOf(account), request, stop.signal);
      const started = now();
      const previous = outlookCalendarCursor.safeParse(request.cursor);
      const marks = previous.success ? previous.data.calendars : {};

      try {
        // Every calendar the Account lists.
        const found: GraphCalendar[] = [];
        for (let link: string | null = CALENDARS_PATH; link; ) {
          const page: z.infer<typeof calendarsPage> = await api.get(link, calendarsPage);
          found.push(...page.value);
          link = page['@odata.nextLink'] ?? null;
        }
        if (request.signal.aborted) throw new Error('The sync was stopped');
        const me = found.find((calendar) => calendar.isDefaultCalendar)?.owner?.address?.trim() || null;
        const listed = found.map((calendar) => toListedCalendar(calendar, me));
        const on = choices.listed(account, listed);

        // Each calendar on, side by side (the gate keeps the requests to 4 at a time).
        const read = new Map<string, CalendarMark>();
        let failure: unknown = null;
        await Promise.all(
          listed
            .filter((calendar) => on.has(calendar.id))
            .map(async (calendar) => {
              try {
                read.set(calendar.id, await syncCalendar(calendar, marks[calendar.id] ?? null));
              } catch (error) {
                if (error instanceof CalendarUnreadable) return;
                failure ??= error;
                stop.abort(error);
              }
            }),
        );
        if (failure) throw failure;
        const next: OutlookCalendarCursor = { calendars: {} };
        for (const calendar of listed) {
          const mark = read.get(calendar.id);
          if (mark) next.calendars[calendar.id] = mark;
        }

        // Calendars switched off, or gone from the list: their events go.
        const gone = Object.keys(marks).filter((id) => !next.calendars[id] && !on.has(id));
        for (const calendarId of gone) {
          const held = choices.held(account, calendarId).map((item) => item.externalId);
          if (held.length) request.save({ items: [], deleted: held });
        }
        return { cursor: next, cost: api.cost };

        // Reads one calendar: from its delta link, or in full over a fresh window. Returns its mark.
        async function syncCalendar(
          listing: ListedCalendar,
          mark: CalendarMark | null,
        ): Promise<CalendarMark> {
          const calendar: EventCalendar = { id: listing.id, name: listing.name, colour: listing.colour };
          // A link from another Graph (the tests' fakes) can't be followed: read in full.
          const usable = mark?.deltaLink?.startsWith(`${api.base}/`) ? mark.deltaLink : null;
          const fresh = !mark || !usable || started - mark.since > RESTART_AFTER_DAYS * DAY_MS;
          const since = fresh || !mark ? started : mark.since;
          const window: Window = {
            min: since - WINDOW_BACK_DAYS * DAY_MS,
            max: since + WINDOW_AHEAD_DAYS * DAY_MS,
          };
          const heldNow = () => choices.held(account, listing.id);
          // A full read saves only what changed since Commander last saved it.
          const before = fresh ? new Map(heldNow().map((each) => [each.externalId, each])) : null;
          const seen = new Set<string>();
          let link: string | null = fresh
            ? `/me/calendars/${encodeURIComponent(listing.id)}/calendarView/delta?startDateTime=${encodeURIComponent(iso(window.min))}&endDateTime=${encodeURIComponent(iso(window.max))}`
            : usable;
          let deltaLink: string | null = null;
          while (link) {
            const page: z.infer<typeof eventsPage> = await api.get(link, eventsPage, { calendar: true });
            stop.signal.throwIfAborted();
            const items: SourceItem[] = [];
            const deleted: string[] = [];
            // What this calendar holds now: an event another calendar has just saved (it moved there)
            // isn't this calendar's to remove.
            let here: StoredItem[] | null = null;
            const holds = () => {
              here ??= heldNow();
              return here;
            };
            for (const event of page.value) {
              seen.add(event.id);
              if (isGone(event)) {
                deleted.push(...removals(event, holds()));
                continue;
              }
              if (event.type === 'seriesMaster') continue;
              const item = toEventItem(event, calendar, me);
              if (before && unchanged(item, before.get(item.externalId))) continue;
              items.push(item);
            }
            if (items.length || deleted.length) request.save({ items, deleted });
            link = page['@odata.nextLink'] ?? null;
            deltaLink = page['@odata.deltaLink'] ?? deltaLink;
          }
          if (fresh) {
            // A full read returns every live event in the window: held ones it didn't are gone.
            const missing = heldNow()
              .filter((each) => !seen.has(each.externalId) && overlaps(each, window))
              .map((each) => each.externalId);
            if (missing.length) request.save({ items: [], deleted: missing });
          }
          return { deltaLink, since };
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

// The synced fields of an invitation's answer (#129): this event's, and its whole series'.
const RSVP_FIELDS = new Set(['response', 'seriesResponse']);

// Answers an invitation (#129): the series through its series master first, then the instance only if
// it didn't follow; each judged against the event as Graph has it now.
async function answerInvitation(api: Api, request: WriteRequest): Promise<WriteResult> {
  const pathOf = (id: string) => `/me/events/${encodeURIComponent(id)}`;
  const read = (id: string) => api.event(pathOf(id), graphEvent);
  const answer = (id: string, value: unknown) =>
    api.event(`${pathOf(id)}/${GRAPH_ANSWERS[String(value)]}`, z.unknown(), { sendResponse: true });

  const superseded: Superseded[] = [];
  const seriesChange = request.changes.find((change) => change.field === 'seriesResponse');
  const instanceChange = request.changes.find((change) => change.field === 'response');
  let event = await read(request.externalId);
  if (seriesChange && event.seriesMasterId) {
    const series = await read(event.seriesMasterId);
    const judged = judge(series, seriesChange);
    if (judged === 'send') {
      await answer(event.seriesMasterId, seriesChange.value);
      event = await read(request.externalId);
    } else if (judged !== 'has') superseded.push(judged);
  }
  if (instanceChange) {
    const judged = judge(event, instanceChange);
    if (judged === 'send') {
      await answer(request.externalId, instanceChange.value);
      event = await read(request.externalId);
    } else if (judged !== 'has') superseded.push(judged);
  }

  const [stored] = request.stored?.([request.externalId]) ?? [];
  const held = stored?.detail?.kind === 'event' ? stored.detail : null;
  const item = held && !isGone(event) ? toEventItem(event, held.calendar, held.accountEmail) : null;
  return { item, superseded, cost: api.cost };
}

// Graph's answer to each of Commander's, by the action that sends it.
const GRAPH_ANSWERS: Record<string, string> = {
  accepted: 'accept',
  tentative: 'tentativelyAccept',
  declined: 'decline',
};

// Graph writes 0001-01-01 for "never"; anything before 1971 is taken as no time at all.
const graphInstant = (value: string | null | undefined) => {
  const at = value
    ? Date.parse(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
    : Number.NaN;
  return Number.isFinite(at) && at > 365 * DAY_MS ? at : null;
};

// What to do with an answer, given the event as Graph has it now: nothing when Outlook already has
// it, nothing (reporting it) when Outlook's answer was given after the User's, otherwise send it.
function judge(event: GraphEvent, change: FieldChange): 'send' | 'has' | Superseded {
  if (event.isOrganizer === true)
    throw new WriteRejected('You organise this event in Outlook: there is nothing to answer.');
  const now = responseOf(event.responseStatus?.response);
  if (now === change.value) return 'has';
  const changedAt = graphInstant(event.responseStatus?.time) ?? graphInstant(event.lastModifiedDateTime);
  if (now !== (change.synced ?? null) && changedAt !== null && changedAt > change.madeAt) {
    return { field: change.field, by: null, at: changedAt };
  }
  if (!(String(change.value) in GRAPH_ANSWERS)) {
    throw new WriteRejected(
      'Outlook can’t take an answer back to “not answered”. Choose Accept, Maybe or Decline instead.',
    );
  }
  return 'send';
}

// The external ids a removed or cancelled event takes with it: itself (a cancelled one wherever it is,
// a removed one only while this calendar holds it) and, for a whole series, every held instance.
function removals(event: GraphEvent, held: readonly StoredItem[]): string[] {
  const ids = new Set<string>();
  if (event.isCancelled === true || held.some((each) => each.externalId === event.id)) ids.add(event.id);
  for (const each of held) {
    if (each.detail?.kind === 'event' && each.detail.seriesId === event.id) ids.add(each.externalId);
  }
  return [...ids];
}
