import type { EventCalendar, SourceItem } from '@commander/domain';
import { z } from 'zod';
import {
  type CalendarChoices,
  WINDOW_AHEAD_DAYS,
  WINDOW_BACK_DAYS,
} from '../google-calendar/google-calendar-source';
import type { ListedCalendar } from '../google-calendar/shapes';
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
} from '../source';
import {
  calendarsPage,
  eventsPage,
  type GraphCalendar,
  type GraphEvent,
  graphEvent,
  isGone,
  responseOf,
  toEventItem,
  toListedCalendar,
} from './shapes';

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
//   limit), shared by every sync of the Account.
//
// Answering invitations (#129, Two-way sync): the synced fields `response` (this event) and
// `seriesResponse` (the whole series an instance belongs to), judged against the event as Graph has it
// now: an answer Outlook already has is skipped, and one given in Outlook since Commander last saw it,
// later than the User answered (by `responseStatus.time`), wins. The rest go as `accept`,
// `tentativelyAccept` or `decline` with `sendResponse: true`, so the organiser hears; the series
// through its series master first, then the instance only if it didn't follow. Graph has no way to
// take an answer back to "not answered", so that one is refused (Couldn't sync).

export const OUTLOOK_CALENDAR_CADENCE: Cadence = { defaultMinutes: 15, choices: [15, 30, 60] };
export const MAX_CONCURRENT_REQUESTS = 4;
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

// Lets no more than `size` tasks run at once; the rest wait their turn.
function gate(size: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running < size) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next in line, or give it back.
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}
type Gate = ReturnType<typeof gate>;

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

  // GETs a path under Graph's base, or a link Graph gave (or POSTs `send`, whose answer is ignored).
  // `calendar`: the request reads one calendar's events, so a refusal is that calendar's alone;
  // `event`: it reads or answers one event, so a 404 means it is gone and a refusal is final (both
  // WriteRejected).
  async function get<T>(
    pathOrLink: string,
    shape: z.ZodType<T>,
    about: { calendar?: boolean; event?: boolean } = {},
    send?: { method: 'POST'; body: unknown },
  ): Promise<T> {
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
          ...(send && { method: send.method, body: JSON.stringify(send.body) }),
          headers: {
            authorization: `Bearer ${token.token}`,
            accept: 'application/json',
            prefer: PREFER,
            ...(send && { 'content-type': 'application/json' }),
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SourceUnavailable('Commander couldn’t reach Outlook Calendar.', cost);
      }
      cost.requests += 1;
      if (response.ok && send) return undefined as T;
      if (response.ok) {
        const parsed = shape.safeParse(await response.json().catch(() => null));
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
      if (response.status === 410 || RESYNC_CODES.has(code)) {
        throw new CursorExpired('Outlook Calendar no longer accepts this calendar’s delta link.');
      }
      if (response.status === 401)
        throw new SignInRefused('Microsoft refused this Outlook Account’s sign-in.');
      if ((response.status === 403 || response.status === 404) && about.calendar) {
        throw new CalendarUnreadable(`Outlook wouldn’t share a calendar (HTTP ${response.status}).`);
      }
      if (response.status === 403) {
        throw new SignInRefused('Microsoft no longer lets Commander read this Account’s calendars.');
      }
      throw new SourceUnavailable(
        `Outlook Calendar couldn’t answer just now (HTTP ${response.status}).`,
        cost,
      );
    });
  }

  return { get, cost, base };
}

export function createOutlookCalendarSource({
  graphUrl,
  calendars: choices,
  fetch = globalThis.fetch,
  now = Date.now,
}: OutlookCalendarSourceOptions): SourceAdapter {
  // One gate per mailbox, shared by every sync of the Account.
  const gates = new Map<string, Gate>();
  const gateOf = (account: string) => {
    let found = gates.get(account);
    if (!found) {
      found = gate(MAX_CONCURRENT_REQUESTS);
      gates.set(account, found);
    }
    return found;
  };

  return {
    source: 'outlook-calendar',
    cadence: OUTLOOK_CALENDAR_CADENCE,

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

    async write(request) {
      const api = connect(graphUrl(), fetch, now, gateOf(request.account), request, request.signal);
      const pathOf = (id: string) => `/me/events/${encodeURIComponent(id)}`;
      const read = (id: string) => api.get(pathOf(id), graphEvent, { event: true });
      const answer = (id: string, value: unknown) =>
        api.get(
          `${pathOf(id)}/${GRAPH_ANSWERS[String(value)]}`,
          z.unknown(),
          { event: true },
          {
            method: 'POST',
            body: { sendResponse: true },
          },
        );

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
    },
  };
}

// Graph's answer to each of Commander's, by the action that sends it.
const GRAPH_ANSWERS: Record<string, string> = {
  accepted: 'accept',
  tentative: 'tentativelyAccept',
  declined: 'decline',
};

// Graph writes 0001-01-01 for "never"; anything before 1971 is taken as no time at all.
const graphTime = (value: string | null | undefined) => {
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
  const changedAt = graphTime(event.responseStatus?.time) ?? graphTime(event.lastModifiedDateTime);
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
