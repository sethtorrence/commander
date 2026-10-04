// Ares's scheduler in the Core (#132, decision #17): Find time, where new events go, and who the
// attendees Ares names are. Free time is worked out in code (the domain's focus-time.ts and
// scheduling.ts), never by the model:
//
// - The User's free time: every event they are busy in, across every Account and calendar, inside their
//   working hours (Settings → Calendar), in the machine's time zone.
// - Narrowed by guests' free/busy where a provider shares it: Google `freeBusy.query` for guests in a
//   Google Workspace domain the User has an Account in, Graph `getSchedule` for guests in a Microsoft
//   work organisation they have an Account in. Everyone else (outsiders, personal addresses) can't be
//   checked, and the answer says so for each. A provider that is slow or refuses costs only its guests'
//   check: Find time still answers within a few seconds.
// - Up to 5 slots, the earliest of each day first.
//
// Find time arrives as an Item store request (`find-time`) and is answered here, asynchronously, once
// the providers have.
import {
  type AttendeeDirectory,
  bestSlots,
  type CalendarSource,
  domainOf,
  FIND_TIME_MAX_SLOTS,
  type FindTimeRequest,
  type FindTimeResult,
  type FreeTimeEvent,
  findTimeRequest,
  freeBusyRoute,
  freeSlots,
  isOutsideGuest,
  isPersonalDomain,
  isWorkMicrosoftAccount,
  type KnownAddress,
  newEventsCalendar,
  type SchedulingAccount,
  type TimeSlot,
  withoutBusy,
} from '@commander/domain';
import type { FreeBusyRequest, FreeBusyResult } from '@commander/sources';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { KnownAccount } from '../sync';

// How long Find time waits for the providers before answering without them.
const FREE_BUSY_TIMEOUT_MS = 6_000;
// The furthest ahead Find time looks.
const MAX_RANGE_MS = 62 * 24 * 60 * 60_000;
// How many recent events and emails names are looked up in.
const DIRECTORY_ITEMS = 1000;

/** The User's calendar Accounts as scheduling sees them: each with their address and whether it is work. */
export function schedulingAccounts(
  store: Pick<ItemStore, 'calendars'>,
  known: readonly KnownAccount[],
): SchedulingAccount[] {
  const byAccount = new Map<string, { source: CalendarSource; primary: string | null }>();
  for (const calendar of store.calendars.list()) {
    const was = byAccount.get(calendar.account);
    // Google names an Account's main calendar after its address.
    const primary = calendar.primary && calendar.source === 'google-calendar' ? calendar.id : null;
    byAccount.set(calendar.account, { source: calendar.source, primary: was?.primary ?? primary });
  }
  return [...byAccount].map(([account, { source, primary }]) => {
    const listed = known.find((each) => each.account === account)?.addresses?.[0] ?? null;
    const address = (primary ?? listed)?.toLowerCase() ?? null;
    const work =
      source === 'google-calendar'
        ? !!address && !isPersonalDomain(domainOf(address))
        : isWorkMicrosoftAccount(account, address);
    return { account, source, address, work };
  });
}

/**
 * Where new events go: the Account and calendar chosen in Settings → Calendar while it still lists
 * them; else that Account's (or the focus blocks' Account's, or the first calendar Account's) main
 * calendar. null without a calendar Account to write to.
 */
export function newEventsTarget(
  store: Pick<ItemStore, 'calendars' | 'schedulingSettings' | 'focusSettings'>,
): { account: string; calendarId: string } | null {
  return newEventsCalendar(
    store.calendars.list(),
    store.schedulingSettings.read(),
    store.focusSettings.read().focusAccount,
  );
}

/**
 * Where attendee names are looked up: the names and addresses on the User's recent events and emails
 * (not the User's own), then People (not the User), each with an email address.
 */
export function attendeeDirectory(store: Pick<ItemStore, 'query' | 'people'>): AttendeeDirectory {
  const people = store.people.list();
  const mine = new Set(
    people
      .filter((person) => person.isUser)
      .flatMap((person) => person.handles.map((handle) => handle.handle.toLowerCase())),
  );
  const seen: KnownAddress[] = [];
  const add = (email: string | null | undefined, name: string | null | undefined, self = false) => {
    const address = email?.trim().toLowerCase();
    if (!address || self || mine.has(address) || !name?.trim() || name.includes('@')) return;
    seen.push({ email: address, name: name.trim() });
  };
  for (const item of store.query({ kinds: ['event'], limit: DIRECTORY_ITEMS })) {
    if (item.detail?.kind !== 'event') continue;
    const { organiser, attendees } = item.detail;
    if (organiser) add(organiser.email, organiser.name, organiser.self);
    for (const each of attendees) if (!each.resource) add(each.email, each.name, each.self);
  }
  for (const item of store.query({ kinds: ['email'], limit: DIRECTORY_ITEMS })) {
    if (item.detail?.kind !== 'email') continue;
    const { from, to, cc } = item.detail;
    for (const each of [from, ...to, ...cc]) add(each?.address, each?.name);
  }
  const fromPeople = people
    .filter((person) => !person.isUser)
    .flatMap((person) => {
      const email = person.handles.find((handle) => handle.source === 'email')?.handle;
      return email ? [{ email: email.toLowerCase(), name: person.name }] : [];
    });
  return { seen, people: fromPeople };
}

export type SchedulerOptions = {
  store: ItemStore;
  // The Accounts the main process listed, with the User's addresses in them.
  accounts: () => readonly KnownAccount[];
  // Asks a calendar Source for guests' free/busy through one of the User's Accounts (sync's).
  freeBusy: (
    account: string,
    source: CalendarSource,
    request: Omit<FreeBusyRequest, 'account' | 'accessToken'>,
  ) => Promise<FreeBusyResult>;
  now?: () => number;
  timeZone?: () => string;
  timeoutMs?: number;
  log?: (message: string) => void;
};

const envelope = z.object({
  type: z.literal('item-store-request'),
  id: z.number().int().positive(),
  request: z.object({ op: z.literal('find-time') }).passthrough(),
});

export type Scheduler = ReturnType<typeof setUpScheduler>;

export function setUpScheduler({
  store,
  accounts,
  freeBusy,
  now = Date.now,
  timeZone = machineZone,
  timeoutMs = FREE_BUSY_TIMEOUT_MS,
  log = (message) => console.warn(message),
}: SchedulerOptions) {
  // Each guest's busy times, from the Account that can see them; or why there are none.
  async function guestsBusy(
    guests: readonly string[],
    range: TimeSlot,
    known: readonly SchedulingAccount[],
  ): Promise<Map<string, { busy: TimeSlot[] | null; why: string | null }>> {
    const found = new Map<string, { busy: TimeSlot[] | null; why: string | null }>();
    const byRoute = new Map<string, { source: CalendarSource; emails: string[] }>();
    for (const guest of guests) {
      const route = freeBusyRoute(guest, known);
      if (!route) {
        const why = isPersonalDomain(domainOf(guest))
          ? 'A personal address: only your calendars were checked.'
          : isOutsideGuest(guest, known)
            ? 'Outside your organisations: only your calendars were checked.'
            : `Commander can’t see calendars at ${domainOf(guest)}: only yours were checked.`;
        found.set(guest, { busy: null, why });
        continue;
      }
      const entry = byRoute.get(route.account) ?? { source: route.source, emails: [] };
      entry.emails.push(guest);
      byRoute.set(route.account, entry);
    }
    await Promise.all(
      [...byRoute].map(async ([account, { source, emails }]) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, timeoutMs);
        });
        try {
          const answer = await Promise.race([
            freeBusy(account, source, {
              emails,
              from: range.start,
              to: range.end,
              signal: controller.signal,
            }),
            timeout,
          ]);
          for (const email of emails) {
            const calendar = answer?.calendars.find((each) => each.email === email);
            if (!answer) found.set(email, { busy: null, why: 'Their calendar took too long to answer.' });
            else if (!calendar?.busy) {
              found.set(email, {
                busy: null,
                why: calendar?.problem ?? 'Their calendar couldn’t be checked.',
              });
            } else found.set(email, { busy: calendar.busy, why: null });
          }
        } catch (error) {
          log(
            `Couldn’t check free/busy through ${account}: ${error instanceof Error ? error.message : error}`,
          );
          for (const email of emails) {
            found.set(email, { busy: null, why: 'Their calendar couldn’t be checked just now.' });
          }
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return found;
  }

  async function findTime(input: FindTimeRequest): Promise<FindTimeResult> {
    const request = findTimeRequest.parse(input);
    const zone = timeZone();
    const at = now();
    const range = { start: Math.max(request.from, at), end: Math.min(request.to, at + MAX_RANGE_MS) };
    const known = schedulingAccounts(store, accounts());
    const mine = new Set(known.flatMap((each) => (each.address ? [each.address] : [])));
    const guests = [...new Set(request.attendees)].filter((guest) => !mine.has(guest));
    const settings = store.focusSettings.read();
    const events =
      range.end > range.start
        ? store
            .events({ from: range.start, to: range.end })
            .flatMap((event): FreeTimeEvent[] =>
              event.detail?.kind === 'event'
                ? [{ id: event.id, account: event.account, detail: event.detail }]
                : [],
            )
        : [];
    const mineFree =
      range.end > range.start
        ? freeSlots({
            events,
            from: range.start,
            to: range.end,
            workingHours: settings.workingHours,
            timeZone: zone,
            minMinutes: request.durationMinutes,
          })
        : [];
    const busy = guests.length ? await guestsBusy(guests, range, known) : new Map();
    const free = withoutBusy(
      mineFree,
      [...busy.values()].flatMap((each) => each.busy ?? []),
    );
    return {
      slots: bestSlots({
        free,
        durationMinutes: request.durationMinutes,
        count: FIND_TIME_MAX_SLOTS,
        timeZone: zone,
      }),
      timeZone: zone,
      guests: guests.map((email) => {
        const each = busy.get(email);
        return {
          email,
          checked: !!each?.busy,
          why: each?.why ?? null,
          outside: isOutsideGuest(email, known),
        };
      }),
      bookingLink: store.schedulingSettings.read().bookingLink,
    };
  }

  return {
    findTime,

    // An Item store request for Find time, answered once the providers have. Returns true when it was one.
    handle(raw: unknown, send: (reply: unknown) => void): boolean {
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) return false;
      const { id, request } = parsed.data;
      const reply = (response: { ok: true; result: FindTimeResult } | { ok: false; error: string }) =>
        send({ type: 'item-store-reply', id, response });
      const checked = z.object({ request: findTimeRequest }).safeParse(request);
      if (!checked.success) {
        reply({ ok: false, error: `Malformed Find time request: ${checked.error.message}` });
        return true;
      }
      findTime(checked.data.request).then(
        (result) => reply({ ok: true, result }),
        (error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    },
  };
}

// The machine's time zone, which working hours are in.
function machineZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
