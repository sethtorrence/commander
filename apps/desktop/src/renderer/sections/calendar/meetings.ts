import {
  type AcceptChanges,
  type AresActivity,
  bookingLinkText,
  type CalendarSummary,
  type CommanderEventDraft,
  googleEventEditUrl,
  isOutsideGuest,
  type MeetingGuest,
  outlookComposeUrl,
} from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutonomyClient } from '../ares/activity';
import { dayKey, clock as timeOf } from './agenda';
import { addressOf, type CalendarAccount, calendarSourceOf } from './calendar-events';

/*
  Ares's scheduler in the window (#132): a meeting as the card shows and changes it, whether Ares
  proposed it from a Daily Note (a suggestion on its Block, Act for you / "Create events with guests",
  always Ask; or Tidy your Sources / "Hold time for yourself" with nobody else) or the User found the
  time themself with Find time. Create makes the event (accepting Ares's suggestion with the card's
  changes, or as the User); Edit in Google Calendar / Outlook hands it to the Account's own editor,
  pre-filled, for anything the card can't express; Send your booking link instead copies the User's
  Google booking link for a guest outside their organisations.
*/

// The actions Ares's proposals carry (apps/core/src/agent/propose-events.ts).
export const CREATE_EVENTS_WITH_GUESTS = 'create-events-with-guests';
export const HOLD_TIME = 'hold-time-for-yourself';

/** A meeting as the card holds it while the User shapes it. */
export interface MeetingDraft {
  title: string;
  start: number;
  end: number;
  account: string;
  /** null: the Account's main calendar. */
  calendarId: string | null;
  guests: MeetingGuest[];
  /** Names Ares couldn't find an address for, waiting for one. */
  toFill: string[];
  /** The time zone it was proposed in. */
  timeZone: string;
}

/** Ares's proposed meeting for a Block. */
export interface MeetingProposal {
  /** The suggestion (the gate's proposal) id. */
  id: number;
  blockId: string;
  draft: MeetingDraft;
  reason: string;
  /** The Block's text: what Ares's words may link to (AresText). */
  source: string;
}

/** A pending suggestion as the meeting it would make; null for any other. */
export function meetingProposalOf(row: AresActivity): MeetingProposal | null {
  if (row.status !== 'pending') return null;
  if (row.action !== CREATE_EVENTS_WITH_GUESTS && row.action !== HOLD_TIME) return null;
  const step = row.itemActions.find((action) => action.type === 'create-event');
  if (step?.type !== 'create-event' || step.event.kind !== 'meeting') return null;
  const { event } = step;
  return {
    id: row.id,
    blockId: row.itemId,
    draft: {
      title: event.title,
      start: event.start.at,
      end: event.end.at,
      account: event.account,
      calendarId: event.calendarId ?? null,
      guests: (event.attendees ?? []).map((guest) => ({ email: guest.email, name: guest.name ?? null })),
      toFill: event.guestsToFill ?? [],
      timeZone: event.start.timeZone ?? systemTimeZone(),
    },
    reason: row.reason,
    source: row.item?.title ?? '',
  };
}

const time = (at: number, timeZone: string) => ({ at, timeZone, date: null });

/** What the User changed on the card, as the gate takes it when accepting. */
export function changesFrom(original: MeetingDraft, draft: MeetingDraft): AcceptChanges {
  const event: NonNullable<AcceptChanges['event']> = {};
  if (draft.title.trim() !== original.title) event.title = draft.title.trim();
  if (draft.start !== original.start || draft.end !== original.end) {
    event.start = time(draft.start, draft.timeZone);
    event.end = time(draft.end, draft.timeZone);
  }
  if (draft.account !== original.account || draft.calendarId !== original.calendarId) {
    event.account = draft.account;
    event.calendarId = draft.calendarId;
  }
  const emails = (guests: MeetingGuest[]) => guests.map((guest) => guest.email).join(',');
  if (emails(draft.guests) !== emails(original.guests) || original.toFill.length)
    event.attendees = draft.guests;
  return Object.keys(event).length ? { event } : {};
}

/** The meeting as the Item store makes it, when the User found the time themself. */
export function draftToCreate(draft: MeetingDraft): CommanderEventDraft {
  return {
    kind: 'meeting',
    account: draft.account,
    ...(draft.calendarId ? { calendarId: draft.calendarId } : {}),
    title: draft.title.trim(),
    start: time(draft.start, draft.timeZone),
    end: time(draft.end, draft.timeZone),
    attendees: draft.guests,
  };
}

/** "30 min", "1 h", "1 h 30 min" */
export function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 6 Oct 14:00", in a time zone. */
export function whenLabel(at: number, timeZone: string): string {
  const [year, month, day] = dayKey(at, timeZone).split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]} ${timeOf(at, timeZone)}`;
}

/** "Call with Leo · 30 min · Tue 6 Oct 14:00" */
export function headline(draft: MeetingDraft, timeZone: string): string {
  const minutes = Math.round((draft.end - draft.start) / 60_000);
  return `${draft.title} · ${lengthLabel(minutes)} · ${whenLabel(draft.start, timeZone)}`;
}

/** The scheduling view of the User's Accounts, for telling guests outside their organisations. */
const asScheduling = (accounts: readonly CalendarAccount[]) =>
  accounts.map((account) => ({
    account: account.id,
    source: calendarSourceOf(account),
    address: addressOf(account),
    work: false,
  }));

/** The guests whose domain matches none of the User's Accounts. */
export const outsideGuests = (draft: MeetingDraft, accounts: readonly CalendarAccount[]) =>
  draft.guests.filter((guest) => isOutsideGuest(guest.email, asScheduling(accounts)));

/** Where Edit in… opens the meeting: that Account's own event editor, pre-filled. */
export function editorFor(
  draft: MeetingDraft,
  account: CalendarAccount | undefined,
  details?: string,
): { url: string; where: string } {
  const prefill = {
    title: draft.title,
    start: draft.start,
    end: draft.end,
    guests: draft.guests.map((guest) => guest.email),
    details,
  };
  if (account?.source === 'outlook') {
    return {
      url: outlookComposeUrl({
        ...prefill,
        personal: account.personal === true,
        address: addressOf(account),
      }),
      where: 'Outlook',
    };
  }
  return {
    url: googleEventEditUrl({ ...prefill, accountEmail: account ? addressOf(account) : null }),
    where: 'Google Calendar',
  };
}

/** The calendars a meeting can go on in an Account: those the User can add events to. */
export const writableCalendars = (calendars: readonly CalendarSummary[], account: string) =>
  calendars.filter(
    (calendar) =>
      calendar.account === account && (calendar.accessRole === 'owner' || calendar.accessRole === 'writer'),
  );

/** Copies "Book a time here: <link>" for the User to send. */
export async function copyBookingLink(link: string): Promise<void> {
  const text = bookingLinkText(link);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied “${text}”`);
  } catch {
    toast(`Couldn’t copy. Your booking link: ${link}`);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface MeetingProposals {
  /** Oldest first, by the Block they are for. */
  byBlock: ReadonlyMap<string, MeetingProposal[]>;
  /** Accepts the suggestion with the card's changes: the event is made, guests invited. */
  create(proposal: MeetingProposal, draft: MeetingDraft): Promise<void>;
  dismiss(id: number): Promise<void>;
}

/** Ares's proposed meetings waiting in the Calendar Section's Autonomy (shown beside their Blocks). */
export function useMeetingProposals(
  client: AutonomyClient,
  onAresActivity: (listener: () => void) => () => void,
  shown: boolean,
): MeetingProposals {
  const [rows, setRows] = useState<MeetingProposal[]>([]);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onAresActivity(reload), [onAresActivity, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload
  useEffect(() => {
    if (!shown) return;
    let current = true;
    client({ op: 'activity', query: { section: 'calendar', statuses: ['pending'], limit: 500 } }).then(
      (activity) => {
        if (!current) return;
        const found = activity.map(meetingProposalOf).filter((row): row is MeetingProposal => row !== null);
        setRows(found.reverse());
      },
      (error) => toast(message(error)),
    );
    return () => {
      current = false;
    };
  }, [client, shown, version]);

  const byBlock = useMemo(() => {
    const map = new Map<string, MeetingProposal[]>();
    for (const row of rows) map.set(row.blockId, [...(map.get(row.blockId) ?? []), row]);
    return map;
  }, [rows]);

  const settle = useCallback(
    async (id: number, run: () => Promise<unknown>, done?: string) => {
      // The card goes at once; a failure brings it back with the reason.
      setRows((was) => was.filter((row) => row.id !== id));
      try {
        await run();
        if (done) toast(done);
      } catch (error) {
        toast(message(error));
      }
      reload();
    },
    [reload],
  );

  return {
    byBlock,
    create: (proposal, draft) =>
      settle(
        proposal.id,
        () => client({ op: 'accept', proposalId: proposal.id, changes: changesFrom(proposal.draft, draft) }),
        draft.guests.length
          ? `“${draft.title}” is in your calendar, and the invitations are on their way`
          : undefined,
      ),
    dismiss: (id) => settle(id, () => client({ op: 'dismiss', proposalId: id })),
  };
}
