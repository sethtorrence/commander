import { z } from 'zod';
import type { CalendarSource, CalendarSummary, EventDetail } from './calendar';
import { dayInZone, holdsTime, type TimeSlot } from './focus-time';

/*
  Ares's scheduler (#132, decision #17): proposing events from what the User writes, finding time with
  anyone, and the User's booking link. Pure: the clock and the time zone are always given.

  - Free time is the focus time module's (focus-time.ts): the User's busy events across every Account
    and calendar, inside their working hours. Guests' calendars narrow it where a provider lets the User
    see them (Google `freeBusy.query` inside a Google Workspace domain the User has an Account in, Graph
    `getSchedule` inside a Microsoft work organisation they have an Account in); personal accounts and
    outsiders can't be checked, and Commander says so (decision #3: Microsoft's free-time APIs don't
    take personal accounts).
  - Attendee names become addresses in code, never by the model: an address as written, then names seen
    on the User's events and emails, then People. A name that matches nobody, or more than one person,
    leaves the guest blank for the User to fill in.
  - Commander builds no event editor of its own: "Edit in Google Calendar / Outlook" opens the Account's
    own editor pre-filled, and the booking link is the User's Google appointment schedule, which
    Commander only copies (it never hosts booking pages).
*/

const id = z.string().min(1);
const MINUTE = 60_000;

// ---------------------------------------------------------------------------------------------
// Settings → Calendar: where new events go, and the booking link

// Only an https link to a page someone else can open (Google's appointment schedules are).
const bookingLink = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url({ protocol: /^https$/, error: 'A booking link starts with https://' }));

export const schedulingSettings = z.object({
  // The Account and calendar new events go in; null until the User chooses (then the only calendar
  // Account, on its main calendar).
  newEventsAccount: id.nullable().default(null),
  newEventsCalendar: id.nullable().default(null),
  // The User's Google booking page (an appointment schedule), offered to guests outside their
  // organisation instead of a time.
  bookingLink: bookingLink.nullable().default(null),
});
export type SchedulingSettings = z.infer<typeof schedulingSettings>;
export type SchedulingSettingsInput = z.input<typeof schedulingSettings>;
export const defaultSchedulingSettings = (): SchedulingSettings => schedulingSettings.parse({});

/**
 * Where new events go: the Account and calendar chosen while the Account still lists that calendar
 * (else that Account's main calendar); else `fallback`'s (the focus blocks' Account), else the first
 * calendar Account's, main calendar. Only calendars the User can add events to. null with none.
 */
export function newEventsCalendar(
  calendars: readonly CalendarSummary[],
  settings: Pick<SchedulingSettings, 'newEventsAccount' | 'newEventsCalendar'>,
  fallback: string | null = null,
): { account: string; calendarId: string } | null {
  const accounts = [...new Set(calendars.map((calendar) => calendar.account))];
  const account = [settings.newEventsAccount, fallback, accounts[0]].find(
    (each): each is string => !!each && accounts.includes(each),
  );
  if (!account) return null;
  const own = calendars.filter(
    (calendar) =>
      calendar.account === account && (calendar.accessRole === 'owner' || calendar.accessRole === 'writer'),
  );
  const chosen =
    (settings.newEventsAccount === account &&
      own.find((calendar) => calendar.id === settings.newEventsCalendar)) ||
    own.find((calendar) => calendar.primary) ||
    own[0];
  return chosen ? { account, calendarId: chosen.id } : null;
}

/** What "Send your booking link instead" copies. */
export const bookingLinkText = (link: string) => `Book a time here: ${link}`;

// ---------------------------------------------------------------------------------------------
// The cheap pre-filter: which changed Blocks are worth asking Ares about

const MEETING_WORDS =
  /\b(calls?|meet|meets|meeting|meetings|catch[\s-]?ups?|sync|syncs|lunch|coffee|dinner|breakfast|demo|interview|standup|stand-up|one[\s-]on[\s-]one)\b|(^|\s)1:1(\s|$)/i;
const DAY_WORDS =
  /\b(mon|tues?|wed|weds|thu|thur|thurs|fri|sat|sun)(day)?\b|\b(today|tonight|tomorrow|next week|this week|next month)\b/i;
const TIMES = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b|\bat \d{1,2}\b|\bnoon\b/i;
const MONTHS = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATES = new RegExp(
  `\\b\\d{1,2}[/.]\\d{1,2}\\b|\\b${MONTHS}\\s+\\d{1,2}\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+${MONTHS}\\b`,
  'i',
);

/** Whether a Block's text has a date, time or weekday, or a word like call, meet or lunch. */
export function mightBeAboutMeeting(text: string): boolean {
  // `[[` links (a day, a Project, a meeting chip's event) say nothing of their own.
  const words = text.replace(/\[\[[^\]]*\]\]/g, ' ').trim();
  if (!words) return false;
  return MEETING_WORDS.test(words) || DAY_WORDS.test(words) || TIMES.test(words) || DATES.test(words);
}

// ---------------------------------------------------------------------------------------------
// Attendees

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isEmailAddress = (text: string) => EMAIL.test(text.trim());

// A guest's address, lower-cased.
export const guestAddress = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isEmailAddress, 'That isn’t an email address');

// Someone the User has met: an address with the name it went by.
export type KnownAddress = { email: string; name: string | null };
// Where names are looked up, in order: names seen on the User's events and emails, then People.
export type AttendeeDirectory = { seen: readonly KnownAddress[]; people: readonly KnownAddress[] };
export type ResolvedAttendee = {
  name: string;
  email: string | null;
  how: 'address' | 'seen' | 'person' | null;
};

const normalName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

// The single address the name points at among these, or null (none, or more than one).
function matchName(name: string, known: readonly KnownAddress[]): KnownAddress | null | 'ambiguous' {
  const wanted = normalName(name);
  const oneWord = !wanted.includes(' ');
  const matches = new Map<string, KnownAddress>();
  for (const each of known) {
    const full = normalName(each.name ?? '');
    if (!full) continue;
    const first = full.split(' ')[0];
    if (full === wanted || (oneWord && first === wanted)) matches.set(each.email.toLowerCase(), each);
  }
  if (matches.size > 1) return 'ambiguous';
  return [...matches.values()][0] ?? null;
}

/**
 * An attendee as the model named them, as an address: an address as written, else the one person of
 * that name seen on the User's events and emails, else among People; else blank (email null).
 */
export function resolveAttendee(raw: string, directory: AttendeeDirectory): ResolvedAttendee {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { name: '', email: null, how: null };
  if (isEmailAddress(name)) return { name: name.toLowerCase(), email: name.toLowerCase(), how: 'address' };
  const tiers: [readonly KnownAddress[], 'seen' | 'person'][] = [
    [directory.seen, 'seen'],
    [directory.people, 'person'],
  ];
  for (const [known, how] of tiers) {
    const found = matchName(name, known);
    if (found === 'ambiguous') return { name, email: null, how: null };
    if (found) return { name: found.name?.trim() || name, email: found.email.toLowerCase(), how };
  }
  return { name, email: null, how: null };
}

// ---------------------------------------------------------------------------------------------
// Finding time

/** Free time less the busy times given (guests' free/busy), in order. */
export function withoutBusy(free: readonly TimeSlot[], busy: readonly TimeSlot[]): TimeSlot[] {
  const taken = [...busy].filter((each) => each.end > each.start).sort((a, b) => a.start - b.start);
  const out: TimeSlot[] = [];
  for (const each of free) {
    let cursor = each.start;
    for (const block of taken) {
      if (block.end <= cursor || block.start >= each.end) continue;
      if (block.start > cursor) out.push({ start: cursor, end: block.start });
      cursor = Math.max(cursor, block.end);
      if (cursor >= each.end) break;
    }
    if (cursor < each.end) out.push({ start: cursor, end: each.end });
  }
  return out;
}

/**
 * Up to `count` times for a meeting of `durationMinutes` in the free time, starting on `alignMinutes`
 * boundaries: the earliest of each day first (spreading the choice over the days), then later ones on
 * the same days, never overlapping each other; in that order.
 */
export function bestSlots({
  free,
  durationMinutes,
  count,
  timeZone,
  alignMinutes = 30,
}: {
  free: readonly TimeSlot[];
  durationMinutes: number;
  count: number;
  timeZone: string;
  alignMinutes?: number;
}): TimeSlot[] {
  const length = durationMinutes * MINUTE;
  const align = alignMinutes * MINUTE;
  if (length <= 0 || count <= 0) return [];
  // Every start that fits, by day.
  const byDay = new Map<string, number[]>();
  for (const each of [...free].sort((a, b) => a.start - b.start)) {
    for (let start = Math.ceil(each.start / align) * align; start + length <= each.end; start += align) {
      const day = dayInZone(start, timeZone);
      byDay.set(day, [...(byDay.get(day) ?? []), start]);
    }
  }
  const days = [...byDay.keys()].sort();
  const picked: TimeSlot[] = [];
  const clear = (start: number) => picked.every((each) => start >= each.end || start + length <= each.start);
  for (let added = true; picked.length < count && added; ) {
    added = false;
    for (const day of days) {
      if (picked.length >= count) break;
      const start = byDay.get(day)?.find(clear);
      if (start === undefined) continue;
      picked.push({ start, end: start + length });
      added = true;
    }
  }
  return picked;
}

/** The events holding the User's time that overlap a slot (back to back doesn't), in start order. */
export function clashesAt<Event extends { detail: EventDetail }>(
  slot: TimeSlot,
  events: readonly Event[],
): Event[] {
  return events
    .filter(
      (event) =>
        holdsTime(event.detail) &&
        !event.detail.allDay &&
        event.detail.start.at < slot.end &&
        event.detail.end.at > slot.start,
    )
    .sort((a, b) => a.detail.start.at - b.detail.start.at);
}

// The most Find time offers.
export const FIND_TIME_MAX_SLOTS = 5;

// Find time (the palette's Find time…, the Calendar Section's button, a proposal's Other times).
export const findTimeRequest = z.object({
  attendees: z.array(guestAddress).max(20),
  durationMinutes: z
    .number()
    .int()
    .min(15)
    .max(8 * 60),
  // Within when: epoch ms.
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});
export type FindTimeRequest = z.input<typeof findTimeRequest>;

export const timeSlot = z.object({ start: z.number().int(), end: z.number().int() });

export const findTimeResult = z.object({
  slots: z.array(timeSlot).max(FIND_TIME_MAX_SLOTS),
  timeZone: z.string(),
  // Each guest: whether their calendar narrowed the slots, why not when it didn't, and whether they're
  // outside the User's organisation (then the booking link is offered).
  guests: z.array(
    z.object({
      email: z.string(),
      checked: z.boolean(),
      why: z.string().nullable(),
      outside: z.boolean(),
    }),
  ),
  bookingLink: z.string().nullable(),
});
export type FindTimeResult = z.infer<typeof findTimeResult>;

// ---------------------------------------------------------------------------------------------
// Whose calendars can be checked

// Mail anyone can sign up for: never one organisation, so never checked and always outside.
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
]);
const PERSONAL_FAMILIES = /^(hotmail|outlook|live|yahoo)\.[a-z.]+$/;

export const domainOf = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';
export const isPersonalDomain = (domain: string) =>
  PERSONAL_DOMAINS.has(domain) || PERSONAL_FAMILIES.test(domain);

// The tenant personal Microsoft accounts sign in through.
const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Whether an Outlook Account (`outlook:<tenant>:<user>`) is a work or school one, not personal. */
export function isWorkMicrosoftAccount(account: string, address: string | null): boolean {
  const tenant = account.split(':')[1] ?? '';
  if (!tenant || tenant === MICROSOFT_CONSUMER_TENANT) return false;
  return !!address && !isPersonalDomain(domainOf(address));
}

// One of the User's calendar Accounts, as scheduling sees it: its address, and whether it belongs to
// an organisation (Google Workspace, a Microsoft work tenant) rather than a person.
export type SchedulingAccount = {
  account: string;
  source: CalendarSource;
  address: string | null;
  work: boolean;
};

/**
 * The Account that can see a guest's free/busy: one of the User's work Accounts in the guest's own
 * domain (Google for a Workspace domain, Graph for a Microsoft organisation). null: nobody can.
 */
export function freeBusyRoute(
  guest: string,
  accounts: readonly SchedulingAccount[],
): { account: string; source: CalendarSource } | null {
  const domain = domainOf(guest);
  if (!domain || isPersonalDomain(domain)) return null;
  const found = accounts.find((each) => each.work && !!each.address && domainOf(each.address) === domain);
  return found ? { account: found.account, source: found.source } : null;
}

/** Whether a guest is outside the User's organisations: their domain matches none of the Accounts'. */
export function isOutsideGuest(guest: string, accounts: readonly SchedulingAccount[]): boolean {
  const domain = domainOf(guest);
  if (!domain || isPersonalDomain(domain)) return true;
  return !accounts.some((each) => !!each.address && domainOf(each.address) === domain);
}

// ---------------------------------------------------------------------------------------------
// The provider's own event editor

export type EditorPrefill = {
  title: string;
  start: number;
  end: number;
  guests: readonly string[];
  details?: string;
};

// 20261006T130000Z
// A query string, as URLSearchParams writes it (this package's ES-only lib settings leave that out).
const query = (params: [string, string][]) =>
  params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');

const googleStamp = (at: number) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** Google Calendar's own event editor, pre-filled, in the Google account given. */
export function googleEventEditUrl({
  title,
  start,
  end,
  guests,
  details,
  accountEmail,
}: EditorPrefill & { accountEmail: string | null }): string {
  const params: [string, string][] = [
    ['text', title],
    ['dates', `${googleStamp(start)}/${googleStamp(end)}`],
  ];
  if (guests.length) params.push(['add', guests.join(',')]);
  if (details) params.push(['details', details]);
  if (accountEmail) params.push(['authuser', accountEmail]);
  return `https://calendar.google.com/calendar/r/eventedit?${query(params)}`;
}

/**
 * Outlook on the web's compose deep link, pre-filled: work and school accounts at outlook.office.com,
 * personal ones at outlook.live.com, signed in as the Account's address when known.
 */
export function outlookComposeUrl({
  title,
  start,
  end,
  guests,
  details,
  personal,
  address,
}: EditorPrefill & { personal: boolean; address?: string | null }): string {
  const params: [string, string][] = [
    ['subject', title],
    ['startdt', new Date(start).toISOString()],
    ['enddt', new Date(end).toISOString()],
  ];
  if (guests.length) params.push(['to', guests.join(',')]);
  if (details) params.push(['body', details]);
  if (address) params.push(['login_hint', address]);
  const compose = personal
    ? 'https://outlook.live.com/calendar/0/deeplink/compose'
    : 'https://outlook.office.com/calendar/deeplink/compose';
  return `${compose}?${query(params)}`;
}
