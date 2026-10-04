import {
  COMMANDER_CALENDAR_NAME,
  type CommanderEventCreate,
  type CommanderEventKind,
  type CommanderEventMove,
  CREATE_FIELD,
  commanderEventCreate,
  commanderEventMove,
  DELETE_FIELD,
  type EventCalendar,
  type EventTime,
  isPendingEventExternalId,
  MOVE_FIELD,
  pendingEventExternalId,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
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
  type CalendarListEntry,
  COMMANDER_ID_PROPERTY,
  COMMANDER_KIND_PROPERTY,
  calendarListPage,
  commanderKind,
  DEFAULT_COLOUR,
  eventExternalId,
  eventsPage,
  type GoogleEvent,
  googleCalendar,
  googleEvent,
  type ListedCalendar,
  RESPONSES,
  toEventItem,
  toListedCalendar,
} from './shapes';

// Google Calendar as a Source: the events on each calendar of a Google Account the User has on,
// through the Calendar API v3 over fetch (decisions #2, #17, #30). Push needs a public webhook, so
// Commander polls, every 15 minutes, with sync tokens:
//
// - Every sync lists the Account's calendars (`calendarList`), which the Item store keeps for
//   Settings → Accounts and answers which are on.
// - A calendar with no sync token yet (its first sync, switched back on, or after a 410) is read in
//   full with `events.list?singleEvents=true` (recurring events arrive as their instances) from 30
//   days back to 12 months ahead. Google's sync guide restricts a full sync with `timeMin` and still
//   issues `nextSyncToken` on its last page; a later request with that token may not repeat
//   `timeMin`/`timeMax` and returns every change, wherever it falls. So changes outside the window
//   are dropped when saving, unless Commander already holds the event (kept current). Events
//   Commander holds in the window that a full read no longer returns are gone: tombstones.
// - Otherwise only what changed since the calendar's token. Cancelled events (and every held
//   instance of a cancelled series) become tombstones.
// - A 410 Gone (the token expired) raises CursorExpired, and the engine syncs the Account's
//   calendars again from scratch. Quota answers (403 rateLimitExceeded / userRateLimitExceeded,
//   and 429) raise RateLimited.
// - Calendars switched off, or no longer listed, drop out of the cursor (their held events go too).
//
// It writes the events Commander makes (#131, commander-events.ts): focus blocks, in the
// Account's own calendar named "Commander", and busy copies on the calendar the Core names.
//
// - `create` makes the event. The Commander calendar is found among the Account's calendars (one it
//   owns, named exactly "Commander") or made on first use (`calendars.insert`, which the
//   `calendar.app.created` scope allows), and remembered per Account while Commander runs; if
//   Google answers 404 for the remembered one (the User deleted it) it is found or made again, once.
//   The event goes in with Google event id = Commander's id for it without the dashes, so a retried
//   insert whose first answer was lost gets 409 and Commander reads the event it made rather than
//   making a second. It is busy, private and bare (no description, guests or reminders), marked with
//   private extended properties naming its kind and Commander's id, which sync reads back.
// - `time` moves it (`events.patch`, start and end). A move queued before the event reached Google
//   travels with its `create`: the event is made at its new time in one request (patched instead if
//   Google answers 409, having it from an earlier attempt at the old time).
// - `delete` (true; null is a delete taken back) deletes it if Google has it; 404 and 410 mean it's
//   gone already. When its creation was never confirmed the event id comes from Commander's id, and
//   it is looked for in the Commander calendar (a focus block) and, with no `create` to say which
//   kind it was, on the main calendar too (a busy copy). A write carrying
//   both `create` and `delete` never makes the event, only makes sure it's gone.
// - The answer is the event as Google has it, naming its Item (`commanderItemId`), so the Item store
//   gives the Item its real external id; null after a delete.
//
// Answering invitations (#129, Two-way sync): the synced fields `response` (this event) and
// `seriesResponse` (the whole series an instance belongs to). Each is judged against the event as
// Google has it now: an answer Google already has is skipped (a retry whose reply was lost), and one
// changed in Google Calendar since Commander last saw it, later than the User answered, wins (by the
// event's `updated` time). The rest are sent as a patch of the User's own attendee line only
// (`attendeesOmitted`), with `sendUpdates=all` so the organiser hears. The series goes first, through
// its recurring event; the instance is then read again and only sent if it didn't follow.

export const GOOGLE_CALENDAR_CADENCE: Cadence = { defaultMinutes: 15, choices: [15, 30, 60] };

// The Item store's side of the Account's calendars: the adapter never touches the database itself.
export type CalendarChoices = {
  // The calendars the Account lists now, kept for Settings → Accounts; answers the ids of those on
  // (new calendars start on when they are primary or owned).
  listed(account: string, calendars: ListedCalendar[]): ReadonlySet<string>;
  // The Account's live events on a calendar, as last saved.
  held(account: string, calendarId: string): StoredItem[];
};

export type GoogleCalendarSourceOptions = {
  // The Calendar API's base (https://www.googleapis.com/calendar/v3); read per sync, so the
  // end-to-end tests can point it at a fake.
  apiUrl: () => string;
  calendars: CalendarChoices;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const DAY_MS = 24 * 60 * 60_000;
export const WINDOW_BACK_DAYS = 30;
export const WINDOW_AHEAD_DAYS = 365;
const PAGE_SIZE = 250;

const calendarMark = z.object({ syncToken: z.string().nullable() });
const googleCalendarCursor = z.object({ calendars: z.record(z.string(), calendarMark) });
export type GoogleCalendarCursor = z.infer<typeof googleCalendarCursor>;

// Google's error body: `{ error: { code, message, errors: [{ reason }], status } }`.
const googleError = z
  .object({
    error: z
      .object({
        message: z.string().nullish(),
        status: z.string().nullish(),
        errors: z.array(z.object({ reason: z.string().nullish() })).nullish(),
        details: z.array(z.object({ reason: z.string().nullish() }).loose()).nullish(),
      })
      .nullish(),
  })
  .nullish();

const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
  'quotaExceeded',
]);

// One calendar Google won't let Commander read (404 gone, 403 not allowed): skipped this sync.
class CalendarUnreadable extends Error {
  override name = 'CalendarUnreadable';
}

const iso = (time: number) => new Date(time).toISOString();

type Window = { min: number; max: number };

const detailOf = (item: Pick<SourceItem, 'detail'> | StoredItem) =>
  item.detail?.kind === 'event' ? item.detail : null;

const overlaps = (item: Pick<SourceItem, 'detail'> | StoredItem, window: Window) => {
  const detail = detailOf(item);
  return !!detail && detail.end.at > window.min && detail.start.at < window.max;
};

// What `call` knows about a request. `calendar`: it reads one calendar's events, so a refusal is that
// calendar's alone; `withToken`: it carries a sync token, so a 410 means expired; `write`: it is made
// for a write, so a 400 refuses the change itself; `event`: it reads or answers one event the User is
// invited to (#129), so a 404 or 410 means the event is gone and a refusal is final (both
// WriteRejected); `tolerate`: statuses the caller handles.
type About = {
  calendar?: boolean;
  withToken?: boolean;
  write?: boolean;
  event?: boolean;
  tolerate?: readonly number[];
};

// Google's answer to one request: what it sent, or a status the caller said it would handle.
type Answer<T> = { ok: true; data: T } | { ok: false; status: number };

function connect(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
  now: () => number,
  request: Pick<SyncRequest, 'accessToken' | 'signal'>,
) {
  const cost: SyncCost = { requests: 0, complexity: null };
  const base = baseUrl.replace(/\/$/, '');

  // Sends one request to a path under the API's base, as the User, and reads Google's answer.
  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    shape: z.ZodType<T>,
    about: About,
  ): Promise<Answer<T>> {
    const token: AccessToken = await request.accessToken();
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token.token}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach Google Calendar.', cost);
    }
    cost.requests += 1;
    if (response.ok) {
      // A delete answers 204, with no body at all.
      const raw = response.status === 204 ? null : await response.json().catch(() => null);
      const parsed = shape.safeParse(raw);
      if (!parsed.success) {
        throw new SourceUnavailable('Google Calendar sent an answer Commander didn’t understand.', cost);
      }
      return { ok: true, data: parsed.data };
    }
    if (about.tolerate?.includes(response.status)) return { ok: false, status: response.status };
    const answer = googleError.safeParse(await response.json().catch(() => null));
    const problem = answer.success ? answer.data?.error : null;
    const reasons = [...(problem?.errors ?? []), ...(problem?.details ?? [])].map(
      (each) => each.reason ?? '',
    );
    const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
    if (response.status === 429 || (response.status === 403 && reasons.some((r) => RATE_REASONS.has(r)))) {
      throw new RateLimited('Google asked Commander to check Google Calendar less often.', retryAfter, cost);
    }
    if (response.status === 410 && about.withToken) {
      throw new CursorExpired('Google Calendar no longer accepts this calendar’s sync token.');
    }
    if (response.status === 401) throw new SignInRefused('Google refused this Account’s sign-in.');
    if ((response.status === 404 || response.status === 410) && about.event) {
      throw new WriteRejected('This event is no longer in Google Calendar.');
    }
    if ((response.status === 400 || response.status === 403) && about.event) {
      throw new WriteRejected(
        `Google Calendar wouldn’t take this answer${problem?.message ? `: ${problem.message}` : '.'}`,
      );
    }
    if ((response.status === 403 || response.status === 404) && about.calendar) {
      throw new CalendarUnreadable(`Google Calendar wouldn’t share a calendar (HTTP ${response.status}).`);
    }
    if (response.status === 403) {
      throw new SignInRefused(
        about.write
          ? 'Google no longer lets Commander change this Account’s calendars.'
          : 'Google no longer lets Commander read this Account’s calendars.',
      );
    }
    if (response.status === 400 && about.write) {
      throw new WriteRejected('Google Calendar wouldn’t take this change to the event.');
    }
    throw new SourceUnavailable(`Google Calendar couldn’t answer just now (HTTP ${response.status}).`, cost);
  }

  // GETs a path under the API's base, for a sync.
  async function get<T>(
    path: string,
    shape: z.ZodType<T>,
    about: Pick<About, 'calendar' | 'withToken'> = {},
  ): Promise<T> {
    const answer = await call('GET', path, undefined, shape, about);
    // Never: a read for a sync tolerates no refusal.
    if (!answer.ok) throw new SourceUnavailable('Google Calendar couldn’t answer just now.', cost);
    return answer.data;
  }

  // Sends a request for a write (`body` undefined: none). `tolerate`: statuses the caller handles.
  function send<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    shape: z.ZodType<T>,
    tolerate: readonly number[] = [],
  ): Promise<Answer<T>> {
    return call(method, path, body, shape, { write: true, tolerate });
  }

  // Reads (or, with `patch`, patches) one event the User is invited to, for answering it (#129).
  async function event<T>(path: string, shape: z.ZodType<T>, patch?: unknown): Promise<T> {
    const answer = await call(patch === undefined ? 'GET' : 'PATCH', path, patch, shape, { event: true });
    // Never: an event's call tolerates no refusal.
    if (!answer.ok) throw new SourceUnavailable('Google Calendar couldn’t answer just now.', cost);
    return answer.data;
  }

  return { get, send, event, cost };
}

type Api = ReturnType<typeof connect>;

// Every calendar the Account lists, page by page (deleted ones left out).
async function listCalendars(api: Api): Promise<CalendarListEntry[]> {
  const entries: CalendarListEntry[] = [];
  for (let pageToken: string | null = null, first = true; first || pageToken; first = false) {
    const page: z.infer<typeof calendarListPage> = await api.get(
      `/users/me/calendarList?maxResults=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      calendarListPage,
    );
    for (const entry of page.items ?? []) if (!entry.deleted) entries.push(entry);
    pageToken = page.nextPageToken ?? null;
  }
  return entries;
}

// The Commander calendar among an Account's calendars: one the Account owns, named exactly so (a
// calendar of that name someone else shared with the User isn't it).
const isCommanderCalendar = (entry: CalendarListEntry) =>
  entry.summary === COMMANDER_CALENDAR_NAME && entry.accessRole === 'owner';

const eventsPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}/events`;
const eventPath = (calendarId: string, eventId: string) =>
  `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`;

// The Google event id of a Commander event: its Item's id (a UUID) without the dashes. Lowercase hex
// is valid base32hex, which Google takes as a client-supplied id.
const googleEventId = (commanderId: string) => commanderId.replaceAll('-', '').toLowerCase();

// One end of an event as Google writes it. A patch names the fields it doesn't use as null, so a
// move between all-day and timed clears the other kind of time.
function googleTime(time: EventTime, allDay: boolean, patch: boolean) {
  if (allDay && time.date) {
    return patch ? { date: time.date, dateTime: null, timeZone: null } : { date: time.date };
  }
  const zone = time.timeZone ? { timeZone: time.timeZone } : patch ? { timeZone: null } : {};
  return { dateTime: iso(time.at), ...zone, ...(patch && { date: null }) };
}

const PENDING_PREFIX_LENGTH = pendingEventExternalId('').length;
// What Google answers for an event that isn't there (any more).
const GONE = [404, 410];

// Where an event is at Google: its calendar and its id there.
type Place = { calendarId: string; eventId: string };

export function createGoogleCalendarSource({
  apiUrl,
  calendars: choices,
  fetch = globalThis.fetch,
  now = Date.now,
}: GoogleCalendarSourceOptions): SourceAdapter {
  // Remembered per Account while Commander runs, for writes: the calendars it last listed (the name
  // and colour of the calendar an event goes on), its address, and its Commander calendar.
  const listedCalendars = new Map<string, Map<string, ListedCalendar>>();
  const addresses = new Map<string, string>();
  const commanderCalendars = new Map<string, ListedCalendar>();
  // Finding or making an Account's Commander calendar, one at a time, so two writes at once can't
  // both make one.
  const finding = new Map<string, Promise<unknown>>();

  function remember(account: string, entries: CalendarListEntry[]) {
    const listed = entries.map(toListedCalendar);
    listedCalendars.set(account, new Map(listed.map((calendar) => [calendar.id, calendar])));
    const primary = listed.find((calendar) => calendar.primary);
    if (primary) addresses.set(account, primary.id);
    // Only ever replaced when found: a list just after Commander made the calendar may not show it yet.
    const commander = entries.find(isCommanderCalendar);
    if (commander) commanderCalendars.set(account, toListedCalendar(commander));
    return listed;
  }

  // The Account's Commander calendar: remembered, else found among its calendars, else (`make`) made.
  // `remembered`: it came from memory, so Google may have deleted it since. null: there is none.
  function commanderCalendar(
    api: Api,
    account: string,
    make: boolean,
  ): Promise<{ calendar: ListedCalendar; remembered: boolean } | null> {
    const run = (finding.get(account) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const known = commanderCalendars.get(account);
        if (known) return { calendar: known, remembered: true };
        remember(account, await listCalendars(api));
        const found = commanderCalendars.get(account);
        if (found) return { calendar: found, remembered: false };
        if (!make) return null;
        const answer = await api.send(
          'POST',
          '/calendars',
          { summary: COMMANDER_CALENDAR_NAME, description: 'Focus blocks Commander puts in your calendar.' },
          googleCalendar,
        );
        if (!answer.ok) throw new SourceUnavailable('Google Calendar couldn’t make the Commander calendar.');
        const made: ListedCalendar = {
          id: answer.data.id,
          name: COMMANDER_CALENDAR_NAME,
          colour: DEFAULT_COLOUR,
          primary: false,
          accessRole: 'owner',
        };
        commanderCalendars.set(account, made);
        return { calendar: made, remembered: false };
      });
    finding.set(
      account,
      run.catch(() => {}),
    );
    return run;
  }

  // The calendar an event Commander wrote is on, as the Account last listed it; else a focus block's
  // is the Commander calendar, and any other's is named by its id (as an unnamed listing would be).
  function calendarFor(account: string, calendarId: string, kind: CommanderEventKind | null): EventCalendar {
    const commander = commanderCalendars.get(account);
    const listing = commander?.id === calendarId ? commander : listedCalendars.get(account)?.get(calendarId);
    if (listing) return { id: listing.id, name: listing.name, colour: listing.colour };
    return {
      id: calendarId,
      name: kind === 'focus-block' ? COMMANDER_CALENDAR_NAME : calendarId,
      colour: DEFAULT_COLOUR,
    };
  }

  return {
    source: 'google-calendar',
    cadence: GOOGLE_CALENDAR_CADENCE,

    async sync(request) {
      const api = connect(apiUrl(), fetch, now, request);
      const { account } = request;
      const started = now();
      const window: Window = {
        min: started - WINDOW_BACK_DAYS * DAY_MS,
        max: started + WINDOW_AHEAD_DAYS * DAY_MS,
      };
      const previous = googleCalendarCursor.safeParse(request.cursor);
      const marks = previous.success ? previous.data.calendars : {};

      // Every calendar the Account lists.
      const listed = remember(account, await listCalendars(api));
      if (request.signal.aborted) throw new Error('The sync was stopped');
      const on = choices.listed(account, listed);
      const accountEmail = listed.find((calendar) => calendar.primary)?.id ?? null;

      const next: GoogleCalendarCursor = { calendars: {} };
      for (const calendar of listed) {
        if (!on.has(calendar.id)) continue;
        try {
          const syncToken = await syncCalendar(calendar, marks[calendar.id]?.syncToken ?? null);
          next.calendars[calendar.id] = { syncToken };
        } catch (error) {
          if (!(error instanceof CalendarUnreadable)) throw error;
        }
      }

      // Calendars switched off, or gone from the list: their events go.
      const gone = Object.keys(marks).filter((id) => !next.calendars[id] && !on.has(id));
      for (const calendarId of gone) {
        const held = choices.held(account, calendarId).map((item) => item.externalId);
        if (held.length) request.save({ items: [], deleted: held });
      }

      return { cursor: next, cost: api.cost };

      // Reads one calendar's events (all of the window, or what changed since `syncToken`), saving
      // page by page. Returns the token for next time (null: read it in full again).
      async function syncCalendar(listing: ListedCalendar, syncToken: string | null): Promise<string | null> {
        const calendar: EventCalendar = { id: listing.id, name: listing.name, colour: listing.colour };
        const path = `/calendars/${encodeURIComponent(listing.id)}/events?singleEvents=true&maxResults=${PAGE_SIZE}`;
        const query = syncToken
          ? `&syncToken=${encodeURIComponent(syncToken)}`
          : `&timeMin=${encodeURIComponent(iso(window.min))}&timeMax=${encodeURIComponent(iso(window.max))}`;
        let heldCache: StoredItem[] | null = null;
        const held = () => {
          heldCache ??= choices.held(account, listing.id);
          return heldCache;
        };
        const seen = new Set<string>();
        let token: string | null = null;
        for (let pageToken: string | null = null, first = true; first || pageToken; first = false) {
          const page: z.infer<typeof eventsPage> = await api.get(
            `${path}${query}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
            eventsPage,
            { calendar: true, withToken: syncToken !== null },
          );
          const items: SourceItem[] = [];
          const deleted: string[] = [];
          for (const event of page.items ?? []) {
            const externalId = eventExternalId(listing.id, event.id);
            seen.add(externalId);
            if (event.status === 'cancelled') {
              deleted.push(externalId, ...instancesOf(event, held()));
              continue;
            }
            const item = toEventItem(event, calendar, page.timeZone?.trim() || null, accountEmail);
            // Changes outside the window are kept only for events Commander already holds.
            if (overlaps(item, window) || held().some((each) => each.externalId === externalId)) {
              items.push(item);
            }
          }
          if (items.length || deleted.length) request.save({ items, deleted });
          pageToken = page.nextPageToken ?? null;
          token = page.nextSyncToken ?? null;
        }
        if (!syncToken) {
          // A full read returns every live event in the window: held ones it didn't are gone.
          const missing = held()
            .filter((each) => !seen.has(each.externalId) && overlaps(each, window))
            .map((each) => each.externalId);
          if (missing.length) request.save({ items: [], deleted: missing });
        }
        return token;
      }
    },

    async write(request): Promise<WriteResult> {
      const api = connect(apiUrl(), fetch, now, request);
      // Answers to invitations (#129) are synced fields of events Commander didn't make.
      if (request.changes.some((change) => RSVP_FIELDS.has(change.field)))
        return answerInvitation(api, request);
      const { account, externalId, changes } = request;
      const creating = changes.find((change) => change.field === CREATE_FIELD && change.value);
      const deleting = changes.some((change) => change.field === DELETE_FIELD && change.value === true);
      const moving = changes.findLast((change) => change.field === MOVE_FIELD && change.value);
      const parsedCreate = creating ? commanderEventCreate.safeParse(creating.value) : null;
      const create = parsedCreate?.success ? parsedCreate.data : null;
      const placeholder = isPendingEventExternalId(externalId);
      // Commander's id for the event, when this write knows it.
      const itemId = create?.commanderId ?? (placeholder ? externalId.slice(PENDING_PREFIX_LENGTH) : null);
      const done = (item: SourceItem | null): WriteResult => ({ item, superseded: [], cost: api.cost });

      if (deleting) {
        const place = await placeOf();
        const places = place ? [place] : [];
        // Not knowing which kind it was (its create couldn't sync), a busy copy is on the main calendar.
        if (placeholder && !create)
          places.push({ calendarId: 'primary', eventId: googleEventId(itemId ?? '') });
        for (const each of places) {
          await api.send('DELETE', eventPath(each.calendarId, each.eventId), undefined, z.unknown(), GONE);
        }
        return done(null);
      }
      if (creating && !create) throw new WriteRejected('Commander couldn’t make sense of this new event.');
      const parsedMove = moving ? commanderEventMove.safeParse(moving.value) : null;
      if (parsedMove && !parsedMove.success) {
        throw new WriteRejected('Commander couldn’t make sense of this event’s new time.');
      }
      const move = parsedMove?.data ?? null;

      let written: { calendarId: string; event: GoogleEvent };
      if (create) {
        written = await insert(create, move);
      } else if (move) {
        const place = await placeOf();
        if (!place) throw new WriteRejected('Google Calendar doesn’t have this event.');
        written = { calendarId: place.calendarId, event: await patch(place, move) };
      } else {
        // Nothing to send: a delete taken back on its own.
        return done(null);
      }

      const { calendarId, event } = written;
      if (event.status === 'cancelled') {
        throw new WriteRejected('This event was deleted in Google Calendar.');
      }
      const kind = create?.kind ?? commanderKind(event);
      // The User made the event, so its creator is them, whose address the Account is.
      const accountEmail =
        (event.creator?.self && event.creator.email?.trim()) || addresses.get(account) || null;
      const item = toEventItem(event, calendarFor(account, calendarId, kind), null, accountEmail);
      return done(itemId && !item.commanderItemId ? { ...item, commanderItemId: itemId } : item);

      // Where the event is (or would be) at Google: its real external id says; for one not yet
      // confirmed, the create change's calendar (or the Commander calendar, if the Account has one)
      // and Commander's id. null: it can't be there.
      async function placeOf(): Promise<Place | null> {
        if (!placeholder) {
          const cut = externalId.lastIndexOf('/');
          return { calendarId: externalId.slice(0, cut), eventId: externalId.slice(cut + 1) };
        }
        const eventId = googleEventId(itemId ?? '');
        if (create?.calendarId) return { calendarId: create.calendarId, eventId };
        const commander = await commanderCalendar(api, account, false);
        return commander ? { calendarId: commander.calendar.id, eventId } : null;
      }

      // Makes the event (at a queued move's time, when there is one). A 409 means Google has it from
      // an earlier attempt: Commander reads it (or patches it to the move's time) instead.
      async function insert(draft: CommanderEventCreate, movedTo: CommanderEventMove | null) {
        const eventId = googleEventId(draft.commanderId);
        const times = movedTo ?? draft;
        const body = {
          id: eventId,
          summary: draft.title,
          start: googleTime(times.start, times.allDay, false),
          end: googleTime(times.end, times.allDay, false),
          transparency: 'opaque',
          visibility: 'private',
          reminders: { useDefault: false, overrides: [] },
          extendedProperties: {
            private: { [COMMANDER_KIND_PROPERTY]: draft.kind, [COMMANDER_ID_PROPERTY]: draft.commanderId },
          },
        };
        const target = async () => {
          if (draft.calendarId) return { id: draft.calendarId, remembered: false };
          const found = await commanderCalendar(api, account, true);
          if (!found) throw new SourceUnavailable('Google Calendar couldn’t make the Commander calendar.');
          return { id: found.calendar.id, remembered: found.remembered };
        };
        let calendar = await target();
        let answer = await api.send('POST', eventsPath(calendar.id), body, googleEvent, [404, 409]);
        if (!answer.ok && answer.status === 404 && calendar.remembered) {
          // The Commander calendar Commander remembered has gone (the User deleted it): find or make
          // it again, once.
          if (commanderCalendars.get(account)?.id === calendar.id) commanderCalendars.delete(account);
          calendar = await target();
          answer = await api.send('POST', eventsPath(calendar.id), body, googleEvent, [404, 409]);
        }
        if (answer.ok) return { calendarId: calendar.id, event: answer.data };
        if (answer.status === 404) {
          // A calendar the Core named that Google doesn't have won't appear by trying again; the
          // Commander calendar just found or made might, once Google has caught up.
          if (draft.calendarId) {
            throw new WriteRejected('Google Calendar no longer has the calendar this event goes on.');
          }
          throw new SourceUnavailable(
            'Google Calendar couldn’t find the Commander calendar just now.',
            api.cost,
          );
        }
        const place = { calendarId: calendar.id, eventId };
        return { calendarId: calendar.id, event: movedTo ? await patch(place, movedTo) : await read(place) };
      }

      async function patch(place: Place, to: CommanderEventMove): Promise<GoogleEvent> {
        const answer = await api.send(
          'PATCH',
          eventPath(place.calendarId, place.eventId),
          { start: googleTime(to.start, to.allDay, true), end: googleTime(to.end, to.allDay, true) },
          googleEvent,
          GONE,
        );
        if (!answer.ok) throw new WriteRejected('Google Calendar no longer has this event.');
        return answer.data;
      }

      async function read(place: Place): Promise<GoogleEvent> {
        const answer = await api.send(
          'GET',
          eventPath(place.calendarId, place.eventId),
          undefined,
          googleEvent,
          GONE,
        );
        if (!answer.ok) throw new WriteRejected('Google Calendar no longer has this event.');
        return answer.data;
      }
    },
  };
}

const GOOGLE_RESPONSES: Record<string, string> = {
  accepted: 'accepted',
  tentative: 'tentative',
  declined: 'declined',
  'needs-action': 'needsAction',
};

// The User's own line among the event's guests.
function selfOf(event: GoogleEvent) {
  const self = event.attendees?.find((each) => each.self === true && each.email?.trim());
  if (!self?.email) throw new WriteRejected('You’re no longer among this event’s guests in Google Calendar.');
  return { email: self.email.trim(), response: RESPONSES[self.responseStatus ?? ''] ?? 'needs-action' };
}

// What to do with an answer, given the event as Google has it now: nothing when Google already has it,
// nothing (reporting it) when Google's answer changed after the User's, otherwise send it.
function judge(event: GoogleEvent, change: FieldChange): 'send' | 'has' | Superseded {
  if (!(String(change.value) in GOOGLE_RESPONSES))
    throw new WriteRejected('That isn’t an answer Google Calendar takes.');
  const now = selfOf(event).response;
  if (now === change.value) return 'has';
  const changedAt = event.updated ? Date.parse(event.updated) : Number.NaN;
  if (now !== (change.synced ?? null) && Number.isFinite(changedAt) && changedAt > change.madeAt) {
    return { field: change.field, by: null, at: changedAt };
  }
  return 'send';
}

// The synced fields of an invitation's answer (#129): this event's, and its whole series'.
const RSVP_FIELDS = new Set(['response', 'seriesResponse']);

// Answers an invitation (#129): the series first, through its recurring event, then the instance if it
// didn't follow; each judged against the event as Google has it now.
async function answerInvitation(api: Api, request: WriteRequest): Promise<WriteResult> {
  const slash = request.externalId.lastIndexOf('/');
  const calendarId = request.externalId.slice(0, slash);
  const eventId = request.externalId.slice(slash + 1);
  if (slash <= 0 || !eventId)
    throw new WriteRejected('Commander doesn’t know this event in Google Calendar.');
  const pathOf = (id: string) =>
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`;
  const read = (id: string) => api.event(pathOf(id), googleEvent);
  const answer = (id: string, event: GoogleEvent, value: unknown) =>
    api.event(`${pathOf(id)}?sendUpdates=all`, googleEvent, {
      attendeesOmitted: true,
      attendees: [{ email: selfOf(event).email, responseStatus: GOOGLE_RESPONSES[String(value)] }],
    });

  const superseded: Superseded[] = [];
  const seriesChange = request.changes.find((change) => change.field === 'seriesResponse');
  const instanceChange = request.changes.find((change) => change.field === 'response');
  let event = await read(eventId);
  if (seriesChange && event.recurringEventId) {
    const series = await read(event.recurringEventId);
    const judged = judge(series, seriesChange);
    if (judged === 'send') {
      await answer(event.recurringEventId, series, seriesChange.value);
      // The instance follows its series unless it was answered on its own.
      event = await read(eventId);
    } else if (judged !== 'has') superseded.push(judged);
  }
  if (instanceChange) {
    const judged = judge(event, instanceChange);
    if (judged === 'send') event = await answer(eventId, event, instanceChange.value);
    else if (judged !== 'has') superseded.push(judged);
  }

  const [stored] = request.stored?.([request.externalId]) ?? [];
  const held = stored?.detail?.kind === 'event' ? stored.detail : null;
  const item = held ? toEventItem(event, held.calendar, held.start.timeZone, held.accountEmail) : null;
  return { item, superseded, cost: api.cost };
}

// A cancelled recurring event (the series itself, not one instance) takes every held instance with it.
function instancesOf(event: GoogleEvent, held: readonly StoredItem[]): string[] {
  if (event.recurringEventId) return [];
  return held.filter((each) => detailOf(each)?.seriesId === event.id).map((each) => each.externalId);
}
