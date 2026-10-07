// Invitations in the thread (#144, decision #17): an email carrying a calendar invitation shows a card
// above its messages, answered with Accept, Maybe and Decline exactly as from Calendar (#129: the
// event's synced field `response`, written back by its calendar Source). This finds the card's event:
//
// - In the email's own Account (a Google Account carries Gmail and Google Calendar), by the event's id
//   at the Source, its iCalendar UID, or its title and start (the domain's `invitationEventOf`).
// - Not synced yet (the invitation often arrives before the calendar's next sync): that Account's
//   calendar is refreshed first, for a few seconds at most, and looked in again. Still not there, or
//   the Account's calendar isn't synced in Commander at all: the card says so, and offers Open in
//   Gmail / Outlook.
// - Found, the email and the event are linked (refers-to, shown from both ends), by the Source: an
//   invitation is about its event whoever reads it. The same happens after a mail sync for invitations
//   that arrived, and after a calendar sync for recent invitations whose event has come in since.
// - The card also names what the event overlaps in the User's other Accounts (clashes.ts).
//
// The card arrives as an Item store request (`email-invitation`) and is answered here, asynchronously,
// once any refresh is done.
import {
  type CalendarSource,
  calendarSources,
  carriesInvitation,
  type EmailDetail,
  type EmailInvitationCard,
  type EventDetail,
  type Item,
  invitationEventOf,
  isEmail,
  overlapping,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { KnownAccount } from '../sync';

// How long the card waits for a calendar refresh before saying the event isn't there.
const REFRESH_TIMEOUT_MS = 6_000;
const DAY_MS = 24 * 60 * 60_000;
// How far back a calendar sync looks for invitations whose event has come in since.
const RECENT_MS = 30 * DAY_MS;
const MOST = 1000;

type Event = Item & { detail: EventDetail };

const envelope = z.object({
  type: z.literal('item-store-request'),
  id: z.number().int().positive(),
  request: z.object({ op: z.literal('email-invitation'), itemId: z.string().min(1) }),
});

export type EmailInvitations = {
  // The card for an email: its event (refreshing the Account's calendar first when it isn't there).
  card(itemId: string): Promise<EmailInvitationCard>;
  // After a sync: links the invitations among these Items (emails that arrived) or, for a calendar
  // Account's sync, the Account's recent invitations, to their events. Returns the Items linked.
  linkAfterSync(event: { source: string; account: string; itemIds: readonly string[] }): string[];
  // An Item store request for a card, answered once found. Returns true when it was one.
  handle(raw: unknown, send: (reply: unknown) => void): boolean;
};

export function setUpEmailInvitations({
  store,
  accounts,
  refresh,
  now = Date.now,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
  onItemsChanged,
}: {
  store: ItemStore;
  accounts: () => readonly KnownAccount[];
  // Syncs one Account's calendar Source now.
  refresh: (account: string, source: CalendarSource) => Promise<void>;
  now?: () => number;
  refreshTimeoutMs?: number;
  // The email and event a card linked, so open views show the Link.
  onItemsChanged?: (itemIds: string[]) => void;
}): EmailInvitations {
  // The events an invitation may be about: around the time it names, else (or failing that) all of
  // its Account's events Commander holds.
  function eventFor(email: Item & { detail: EmailDetail }): Event | null {
    const { invitation } = email.detail;
    if (!invitation || !email.account) return null;
    const at = now();
    if (invitation.start !== null) {
      const near = store.events({
        from: Math.max(0, invitation.start - DAY_MS),
        to: (invitation.end ?? invitation.start) + DAY_MS,
        accounts: [email.account],
        limit: MOST,
      });
      const found = invitationEventOf(email, near, at);
      if (found) return found as Event;
    }
    if (!invitation.uid && !invitation.eventId) return null;
    const all = store.query({ kinds: ['event'], account: email.account, limit: MOST });
    return invitationEventOf(email, all, at) as Event | null;
  }

  // The email refers to its event (once), as the Source's: shown from both ends.
  function link(email: Item, event: Item): boolean {
    const view = store.get(email.id);
    if (!view || !email.account || !email.source) return false;
    const linked = [...view.links, ...view.backlinks].some(
      (each) =>
        each.type === 'refers-to' &&
        ((each.from.id === email.id && each.to.id === event.id) ||
          (each.from.id === event.id && each.to.id === email.id)),
    );
    if (linked) return false;
    store.record(
      { type: 'link', from: email.id, linkType: 'refers-to', to: event.id },
      {
        by: { kind: 'source', source: email.source, account: email.account },
        why: 'The invitation in this email is for this event',
      },
    );
    return true;
  }

  // What the event overlaps in the User's other Accounts.
  function clashesOf(event: Event) {
    const around = store.events({ from: event.detail.start.at, to: event.detail.end.at, limit: MOST });
    return overlapping(event, around as Event[])
      .filter((each) => each.account !== event.account)
      .map((each) => ({ id: each.id, title: each.title, account: each.account ?? '' }));
  }

  // The Account's calendar Source, when Commander syncs its calendar.
  function calendarOf(account: string): CalendarSource | null {
    const known = accounts().find((each) => each.account === account);
    const source = (calendarSources as readonly string[]).find((each) =>
      known?.sources.includes(each as CalendarSource),
    ) as CalendarSource | undefined;
    if (!source || known?.needsReconnect) return null;
    return store.calendars.list().some((calendar) => calendar.account === account && calendar.on)
      ? source
      : null;
  }

  const shown = (event: Event): EmailInvitationCard => ({
    state: 'event',
    event,
    clashes: clashesOf(event),
  });

  async function card(itemId: string): Promise<EmailInvitationCard> {
    const email = store.get(itemId)?.item;
    if (!isEmail(email) || !email.account || !carriesInvitation(email.detail)) return { state: 'none' };
    const unsynced = (why: 'no-calendar' | 'not-found'): EmailInvitationCard => ({
      state: 'unsynced',
      why,
      title: email.detail.invitation?.title ?? null,
      start: email.detail.invitation?.start ?? null,
      end: email.detail.invitation?.end ?? null,
      allDay: email.detail.invitation?.allDay ?? false,
    });
    const found = eventFor(email);
    if (found) {
      if (link(email, found)) onItemsChanged?.([email.id, found.id]);
      return shown(found);
    }
    const source = calendarOf(email.account);
    if (!source) return unsynced('no-calendar');
    // Not synced yet: the Account's calendar first, for a few seconds at most.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      refresh(email.account, source).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, refreshTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const fresh = store.get(itemId)?.item;
    const after = isEmail(fresh) ? eventFor(fresh) : null;
    if (!after) return unsynced('not-found');
    if (link(email, after)) onItemsChanged?.([email.id, after.id]);
    return shown(after);
  }

  function linkAfterSync({
    source,
    account,
    itemIds,
  }: {
    source: string;
    account: string;
    itemIds: readonly string[];
  }): string[] {
    let emails: Item[];
    if (source === 'gmail' || source === 'outlook') {
      emails = itemIds.length ? store.query({ kinds: ['email'], ids: [...itemIds].slice(0, MOST) }) : [];
    } else if ((calendarSources as readonly string[]).includes(source)) {
      const since = now() - RECENT_MS;
      emails = store
        .query({ kinds: ['email'], account, limit: MOST })
        .filter((item) => item.detail?.kind === 'email' && item.detail.sentAt >= since);
    } else return [];
    const linked: string[] = [];
    for (const email of emails) {
      if (!isEmail(email) || !email.detail.invitation || !carriesInvitation(email.detail)) continue;
      const event = eventFor(email);
      if (event && link(email, event)) linked.push(email.id, event.id);
    }
    return linked;
  }

  return {
    card,
    linkAfterSync,

    handle(raw, send) {
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) return false;
      const { id, request } = parsed.data;
      card(request.itemId).then(
        (result) => send({ type: 'item-store-reply', id, response: { ok: true, result } }),
        (error) =>
          send({
            type: 'item-store-reply',
            id,
            response: { ok: false, error: error instanceof Error ? error.message : String(error) },
          }),
      );
      return true;
    },
  };
}
