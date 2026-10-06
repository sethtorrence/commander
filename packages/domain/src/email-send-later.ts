import { z } from 'zod';
import { addressName, type EmailAddress, emailAddress } from './email';

/*
  Send later (#139, decisions #15 and #20): the User picks a time in the composer and the message goes
  then. Who holds it until then depends on the Account:

  - **Held by Microsoft:** an Outlook work Account (Exchange Online). The message is handed to Outlook at
    once with the deferred-send property (`PidTagDeferredSendTime`), so Exchange keeps it in the
    Outbox and sends it at its time whether Commander is running or not. Cancel takes it back out of
    the Outbox before then.
  - **Sends from Commander:** a Gmail Account (Gmail has no scheduled-send API), and a personal
    Outlook.com Account until Microsoft's hold is tested there. The message waits in the Core with its
    time and goes into the outgoing queue then, as an ordinary send with no Undo hold (the User already
    chose when). Every time a send time is picked, the composer says Ares has to be running then. A time
    that passed while Commander was closed or the machine asleep is **missed**: never sent on the next
    start or wake by surprise, but asked about in the next Update (Needs you now). Running but offline
    at its time is not missed: it goes when the connection returns.

  Work and personal Microsoft accounts are told apart by the Account's tenant: personal accounts sign
  in through Microsoft's consumer tenant. An Outlook Account's id is `outlook:<tenant>:<user>`.
*/

const id = z.string().min(1).max(200);
const timestamp = z.number().int().nonnegative();

/** The tenant every personal Microsoft account (Outlook.com, Hotmail, Live) signs in through. */
export const PERSONAL_MICROSOFT_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export const SEND_LATER_HELD_BY = ['microsoft', 'commander'] as const;
export const sendLaterHeldBy = z.enum(SEND_LATER_HELD_BY);
export type SendLaterHeldBy = z.infer<typeof sendLaterHeldBy>;

/** Who holds an Account's scheduled mail until its time: Microsoft for an Outlook work Account, else Commander. */
export function heldByFor(account: string): SendLaterHeldBy {
  const [source, tenant] = account.split(':');
  return source === 'outlook' && tenant && tenant !== PERSONAL_MICROSOFT_TENANT ? 'microsoft' : 'commander';
}

/** What the composer says every time a send time is picked on an Account Commander sends from. */
export const SEND_LATER_NOTICE = 'Ares has to be running (the window or the tray) at that time to send this.';

/** What it says instead for an Outlook work Account. */
export const HELD_BY_MICROSOFT_NOTE =
  'Microsoft holds it and sends it at that time, even with Commander closed.';

// Where the Email Section is asked to show a scheduled message (Open on a missed send's Update line),
// and to open one in the composer (its Edit).
export const SCHEDULED_FOCUS = 'scheduled';
export const SEND_LATER_EDIT_FOCUS = 'edit-scheduled';

export const HELD_BY_NAMES: Record<SendLaterHeldBy, string> = {
  microsoft: 'Held by Microsoft',
  commander: 'Sends from Commander',
};

// The furthest ahead a message may be scheduled (a typo in the year shouldn't park it for decades).
export const SEND_LATER_MAX_MS = 366 * 24 * 60 * 60_000;

/** Why a send time can't be used, or null when it can: it must be later than now and within a year. */
export function sendLaterProblem(sendAt: number, now: number): string | null {
  if (!Number.isFinite(sendAt) || sendAt <= now) return 'Pick a time later than now.';
  if (sendAt - now > SEND_LATER_MAX_MS) return 'Pick a time within the next year.';
  return null;
}

// ---------------------------------------------------------------------------------------------
// The Send later menu

export type SendLaterChoice = { label: string; at: number };

const at = (date: Date, days: number, hour: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour).getTime();

/**
 * The Send later menu's quick times, in local time: Later today (18:00, offered until 17:00), Tomorrow
 * morning (08:00) and Monday morning (08:00 next Monday, left out on a Sunday, when it is tomorrow).
 */
export function sendLaterChoices(now: number): SendLaterChoice[] {
  const date = new Date(now);
  const weekday = date.getDay();
  const choices: SendLaterChoice[] = [];
  if (date.getHours() < 17) choices.push({ label: 'Later today', at: at(date, 0, 18) });
  choices.push({ label: 'Tomorrow morning', at: at(date, 1, 8) });
  if (weekday !== 0) choices.push({ label: 'Monday morning', at: at(date, 8 - weekday, 8) });
  return choices;
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const startOfDay = (time: number) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** "09:00", in local time. */
export const sendLaterClock = (time: number) => {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** A moment's day, in local time: "today", "tomorrow", "yesterday", "Mon 12 Oct" (with the year when it isn't this one). */
export function sendLaterDay(time: number, now: number): string {
  const days = Math.round((startOfDay(time) - startOfDay(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const date = new Date(time);
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

/** When a scheduled message goes, as the composer and Scheduled say it: "today 18:00", "Mon 12 Oct 08:00". */
export const sendLaterTime = (time: number, now: number) =>
  `${sendLaterDay(time, now)} ${sendLaterClock(time)}`;

/** A moment as a `datetime-local` input holds it (local time, to the minute). */
export function localDateTime(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------------------------
// The Scheduled view

// How a scheduled message stands. From Commander: `waiting` for its time, or `missed` (its time passed
// while Commander was closed or the machine asleep, and the User hasn't said what to do). By Microsoft:
// `handing` it to Outlook (waiting for the connection, or on its way), `held` in Exchange's Outbox, or
// `failed` (Outlook refused it, with the reason and Retry).
export const SCHEDULED_STATES = ['waiting', 'missed', 'handing', 'held', 'failed'] as const;
export const scheduledState = z.enum(SCHEDULED_STATES);
export type ScheduledState = z.infer<typeof scheduledState>;

export const scheduledEntry = z.object({
  itemId: id,
  account: id,
  subject: z.string(),
  to: z.array(emailAddress),
  // When it goes (or was due, once missed).
  sendAt: timestamp,
  heldBy: sendLaterHeldBy,
  state: scheduledState,
  // Why Outlook refused it, in plain words.
  error: z.string().nullable(),
});
export type ScheduledEntry = z.infer<typeof scheduledEntry>;

/** How a scheduled message stands, in a few words: "Sends from Commander", "Missed: was due today 09:00". */
export function scheduledLine(
  entry: Pick<ScheduledEntry, 'state' | 'sendAt' | 'error'>,
  now: number,
): string {
  switch (entry.state) {
    case 'waiting':
      return HELD_BY_NAMES.commander;
    case 'missed':
      return `Missed: it was due ${sendLaterTime(entry.sendAt, now)}, while Commander wasn’t running`;
    case 'handing':
      return 'Handing it to Microsoft: it goes when Commander is back online';
    case 'held':
      return HELD_BY_NAMES.microsoft;
    case 'failed':
      return `Microsoft didn’t take it${entry.error ? `: ${entry.error}` : ''}`;
  }
}

/** Who a message is to, as a missed send names them: "Dana", "Dana and Sam", "Dana and 2 others". */
export function recipientsWord(to: readonly EmailAddress[]): string {
  const names = to.map((each) => {
    const name = each.name?.trim();
    return name ? (name.split(/\s+/)[0] as string) : addressName(each);
  });
  if (!names.length) return 'no one';
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** The missed send's question, as the Update asks it: "Your email to Dana was due at 09:00. Send it now?" */
export function missedSendText(
  missed: { to: readonly EmailAddress[]; subject: string; dueAt: number },
  now: number,
): string {
  const day = sendLaterDay(missed.dueAt, now);
  const subject = missed.subject.trim() ? ` (“${missed.subject.trim()}”)` : '';
  return `Your email to ${recipientsWord(missed.to)}${subject} was due ${day === 'today' ? '' : `${day} `}at ${sendLaterClock(missed.dueAt)}. Send it now?`;
}
