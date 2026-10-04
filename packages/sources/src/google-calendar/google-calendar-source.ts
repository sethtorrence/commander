import type { EventCalendar, SourceItem } from '@commander/domain';
import { z } from 'zod';
import {
  type AccessToken,
  type Cadence,
  CursorExpired,
  RateLimited,
  retryAfterMs,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  type StoredItem,
  type SyncCost,
  type SyncRequest,
} from '../source';
import {
  calendarListPage,
  eventExternalId,
  eventsPage,
  type GoogleEvent,
  type ListedCalendar,
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

function connect(baseUrl: string, fetch: typeof globalThis.fetch, now: () => number, request: SyncRequest) {
  const cost: SyncCost = { requests: 0, complexity: null };
  const base = baseUrl.replace(/\/$/, '');

  // GETs a path under the API's base. `calendar`: the request reads one calendar's events, so a
  // refusal is that calendar's alone; `withToken`: it carries a sync token, so a 410 means expired.
  async function get<T>(
    path: string,
    shape: z.ZodType<T>,
    about: { calendar?: boolean; withToken?: boolean } = {},
  ): Promise<T> {
    const token: AccessToken = await request.accessToken();
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token.token}`, accept: 'application/json' },
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new SourceUnavailable('Commander couldn’t reach Google Calendar.', cost);
    }
    cost.requests += 1;
    if (response.ok) {
      const parsed = shape.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new SourceUnavailable('Google Calendar sent an answer Commander didn’t understand.', cost);
      }
      return parsed.data;
    }
    const body = googleError.safeParse(await response.json().catch(() => null));
    const problem = body.success ? body.data?.error : null;
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
    if ((response.status === 403 || response.status === 404) && about.calendar) {
      throw new CalendarUnreadable(`Google Calendar wouldn’t share a calendar (HTTP ${response.status}).`);
    }
    if (response.status === 403) {
      throw new SignInRefused('Google no longer lets Commander read this Account’s calendars.');
    }
    throw new SourceUnavailable(`Google Calendar couldn’t answer just now (HTTP ${response.status}).`, cost);
  }

  return { get, cost };
}

export function createGoogleCalendarSource({
  apiUrl,
  calendars: choices,
  fetch = globalThis.fetch,
  now = Date.now,
}: GoogleCalendarSourceOptions): SourceAdapter {
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
      const listed: ListedCalendar[] = [];
      for (let pageToken: string | null = null, first = true; first || pageToken; first = false) {
        const page: z.infer<typeof calendarListPage> = await api.get(
          `/users/me/calendarList?maxResults=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
          calendarListPage,
        );
        for (const entry of page.items ?? []) if (!entry.deleted) listed.push(toListedCalendar(entry));
        pageToken = page.nextPageToken ?? null;
      }
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
  };
}

// A cancelled recurring event (the series itself, not one instance) takes every held instance with it.
function instancesOf(event: GoogleEvent, held: readonly StoredItem[]): string[] {
  if (event.recurringEventId) return [];
  return held.filter((each) => detailOf(each)?.seriesId === event.id).map((each) => each.externalId);
}
