import { z } from 'zod';
import type { EventDetail } from './calendar';
import { addressName, type EmailDetail } from './email';
import { type Item, item } from './items';

/*
  Email meets Calendar and Todos (#144): an invitation answered from its email, Todos suggested from
  what people ask in their mail, events proposed from "Dana suggested Thursday at 3", and the mail that
  needs the User ranked on the Dashboard. Shared by the Core (finding an invitation's event, Ares's
  jobs) and the window (the invitation card, the thread's suggestions). Pure: the clock is always given.

  - An invitation's event is found in the email's own Account (a Google Account carries Gmail and
    Google Calendar; an Outlook Account its mail and calendar): by the event's id at the Source when
    the Source names it (Outlook), else its iCalendar UID, else its title and start. Several instances
    of a series share one UID: the one starting when the invitation says, else the next one not over.
  - Mail from a real person: not a mailing list, nothing to unsubscribe from, not sent from an
    automated address ("no-reply@…", "notifications@…"), and not the User's own.
*/

/** Ares's job that suggests Todos from email, under the Organise action "Suggest Todos" (#144). */
export const SUGGEST_TODOS_FROM_EMAIL = 'suggest-email-todos';
/** Ares's job that proposes events from email, under the Calendar Section's event actions (#144). */
export const PROPOSE_EVENTS_FROM_EMAIL = 'propose-email-events';

type Email = Item & { detail: EmailDetail };
type Event = Item & { detail: EventDetail };

const emailOf = (candidate: Item | null | undefined): EmailDetail | null =>
  candidate?.detail?.kind === 'email' ? candidate.detail : null;

/**
 * Whether an email carries an invitation the User can answer: a calendar invitation that isn't a
 * cancellation or someone's answer, and isn't the User's own (sent from their Account).
 */
export function carriesInvitation(detail: EmailDetail): boolean {
  if (!detail.hasInvitation || detail.sentByMe || detail.draft) return false;
  const method = detail.invitation?.method ?? 'request';
  return method === 'request';
}

const sameTitle = (a: string | null, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether an event's id at its Source is `eventId`: Outlook's is the id itself, Google's `calendar/id`. */
const isSourceEvent = (event: Item, eventId: string) =>
  event.externalId === eventId || !!event.externalId?.endsWith(`/${eventId}`);

/**
 * The event an invitation email is about, among `events` (any, of any Account): live, in the email's
 * Account, by the event's id at the Source, else its UID (the instance starting when the invitation
 * says, else the next one not over at `now`, else the last), else its title and start. null when none.
 */
export function invitationEventOf<E extends Item>(email: Item, events: readonly E[], now: number): E | null {
  const detail = emailOf(email);
  const invitation = detail?.invitation;
  if (!detail || !invitation || !email.account) return null;
  const mine = events.filter(
    (each): each is E & Event =>
      each.account === email.account && each.deletedAt === null && each.detail?.kind === 'event',
  );
  if (invitation.eventId) {
    const found = mine.find((each) => isSourceEvent(each, invitation.eventId as string));
    if (found) return found;
  }
  if (invitation.uid) {
    const uid = invitation.uid.trim();
    const instances = mine
      .filter((each) => each.detail.icalUid?.trim() === uid)
      .sort((a, b) => a.detail.start.at - b.detail.start.at);
    const found =
      instances.find((each) => invitation.start !== null && each.detail.start.at === invitation.start) ??
      instances.find((each) => each.detail.end.at > now) ??
      instances.at(-1);
    if (found) return found;
  }
  if (invitation.start === null) return null;
  return (
    mine.find(
      (each) => each.detail.start.at === invitation.start && sameTitle(invitation.title, each.title),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Mail from a real person

// The start of an address that machines send from.
const AUTOMATED =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|automated|auto-?confirm|calendar-notification)(?:[+._-]|@|$)/i;

/** Whether an email is from a real person: no mailing list, no unsubscribe link, no automated sender. */
export function fromRealPerson(detail: EmailDetail): boolean {
  if (detail.sentByMe || detail.listId || detail.listUnsubscribe || detail.draft) return false;
  const address = detail.from?.address.trim().toLowerCase() ?? '';
  if (!address.includes('@')) return false;
  return !AUTOMATED.test(address);
}

// ---------------------------------------------------------------------------------------------
// What caused a suggestion

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// When an email came, as a cause names it: "10:42" today, else "Tue 10:42".
function arrivedAt(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? time : `${WEEKDAYS[date.getDay()]} ${time}`;
}

/** Who sent an email, as a cause names them: their first name, or their address. */
export function senderName(detail: EmailDetail): string {
  const name = detail.from?.name?.trim();
  return name ? (name.split(/\s+/)[0] as string) : addressName(detail.from) || 'Someone';
}

/** "Suggested because of Dana's email, 10:42": what a chained suggestion from an email says caused it. */
export function emailCause(detail: EmailDetail, now: number): string {
  return `Suggested because of ${senderName(detail)}’s email, ${arrivedAt(detail.sentAt, now)}`;
}

// ---------------------------------------------------------------------------------------------
// Opening the email at its Source

/**
 * The email in Gmail or Outlook on the web, for "Open in Gmail / Outlook": Gmail by its message id in
 * the Account (signed in as its address), Outlook by its id (outlook.live.com for a personal account).
 */
export function emailWebUrl(
  email: Pick<Item, 'source' | 'externalId'>,
  { address, personal = false }: { address: string | null; personal?: boolean },
): string | null {
  if (!email.externalId) return null;
  const id = encodeURIComponent(email.externalId);
  if (email.source === 'gmail')
    return `https://mail.google.com/mail/${address ? `?authuser=${encodeURIComponent(address)}` : ''}#all/${id}`;
  if (email.source === 'outlook') {
    const host = personal ? 'outlook.live.com/mail/0' : 'outlook.office.com/mail';
    return `https://${host}/deeplink/read/${id}${address ? `?login_hint=${encodeURIComponent(address)}` : ''}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The invitation card (the window asks the Core: `email-invitation`)

export const invitationClash = z.object({ id: z.string().min(1), title: z.string(), account: z.string() });
export type InvitationClash = z.infer<typeof invitationClash>;

/**
 * What an invitation email's card shows: its event (with what it overlaps in the User's other
 * Accounts), or why it can't (its calendar isn't synced, or the event isn't there even after a fresh
 * sync), with what the email itself says; `none` for an email that carries no invitation to answer.
 */
export const emailInvitationCard = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('event'), event: item, clashes: z.array(invitationClash) }),
  z.object({
    state: z.literal('unsynced'),
    // `no-calendar`: the Account's calendar isn't synced in Commander; `not-found`: the calendar is
    // synced, and even a fresh sync didn't bring the event (a calendar switched off, someone else's).
    why: z.enum(['no-calendar', 'not-found']),
    title: z.string().nullable(),
    start: z.number().int().nonnegative().nullable(),
    end: z.number().int().nonnegative().nullable(),
    allDay: z.boolean(),
  }),
]);
export type EmailInvitationCard = z.infer<typeof emailInvitationCard>;

/** Whether an Item is a live email. */
export const isEmail = (candidate: Item | null | undefined): candidate is Email =>
  !!emailOf(candidate) && candidate?.deletedAt === null;
