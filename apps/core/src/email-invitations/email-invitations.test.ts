import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  answerFields,
  type EmailInvitation,
  type EventDetail,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliver, GMAIL, OUTLOOK } from '../agent/fixtures/emails';
import { type ItemStore, openItemStore } from '../item-store';
import type { KnownAccount } from '../sync';
import { type EmailInvitations, setUpEmailInvitations } from '.';

// Invitations in the thread (#144): an invitation email's card finds its event in the email's own
// Account (by the event's id at the Source, its UID, or its title and start), refreshing the Account's
// calendar first when the event isn't synced yet; the email and the event are linked; and Accept
// answers the event exactly as from Calendar (#129), queued for the calendar Source. The invitations
// are what the recorded Gmail and Outlook fixtures read into (packages/sources: gmail/recorded/
// invitation.json, outlook/recorded/first-sync.json). Tuesday 6 October 2026, 10:42 in London.

const NOW = Date.UTC(2026, 9, 6, 9, 42);
const user: ActionContext = { by: { kind: 'user' } };
const GOOGLE_PRIMARY = 'alex@gmail.test';
const OUTLOOK_DEFAULT = 'AAMkAGI2-cal-default=';
const PRICING_UID = '5k2m8q1v7c3n9b0x4r6t2p8s1d@google.com';
const THURSDAY_3PM = Date.parse('2026-10-08T14:00:00Z');
const HOUR = 3_600_000;

let dir: string;
let store: ItemStore;
let invitations: EmailInvitations;
let refreshed: { account: string; source: string }[];
let onRefresh: (account: string) => void;
let changed: string[][];
let accounts: KnownAccount[];

const event = (
  externalId: string,
  title: string,
  calendarId: string,
  detail: Partial<EventDetail> = {},
): SourceItem => ({
  externalId,
  kind: 'event',
  title,
  detail: {
    kind: 'event',
    calendar: { id: calendarId, name: 'Calendar', colour: '#9fe1e7' },
    accountEmail: null,
    start: { at: THURSDAY_3PM, timeZone: 'Europe/London', date: null },
    end: { at: THURSDAY_3PM + HOUR, timeZone: 'Europe/London', date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: { email: 'dana@acme.test', name: 'Dana Reyes', self: false },
    attendees: [
      {
        email: 'alex@gmail.test',
        name: null,
        self: true,
        response: 'needs-action',
        organiser: false,
        optional: false,
        resource: false,
      },
    ],
    myResponse: 'needs-action',
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: null,
    webUrl: null,
    createdByCommander: null,
    ...detail,
  },
});

// The Gmail invitation as the recorded fixture reads.
const GMAIL_INVITATION: EmailInvitation = {
  method: 'request',
  uid: PRICING_UID,
  eventId: null,
  title: 'Pricing review',
  start: THURSDAY_3PM,
  end: THURSDAY_3PM + HOUR,
  allDay: false,
};

const pricingEvent = () =>
  event(`${GOOGLE_PRIMARY}/pricingreview`, 'Pricing review', GOOGLE_PRIMARY, { icalUid: PRICING_UID });

function syncCalendar(account: string, source: 'google-calendar' | 'outlook-calendar', items: SourceItem[]) {
  store.saveFromSource({ source, account, items });
  return store
    .fromSource(
      { source, account },
      items.map((item) => item.externalId),
    )
    .map((item) => item.id);
}

function invitationEmail(invitation: EmailInvitation | null, { account = GMAIL, id = 'invite' } = {}) {
  const ids = deliver(
    store,
    NOW,
    [
      {
        id,
        subject: 'Invitation: Pricing review @ Thu 8 Oct 2026 15:00 - 16:00 (BST)',
        from: { name: 'Dana Reyes', address: 'dana@acme.test' },
        hasInvitation: true,
        ...(invitation ? { invitation } : {}),
      },
    ],
    { account, source: account === GMAIL ? 'gmail' : 'outlook' },
  );
  return ids[id] as string;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'commander-email-invitations-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => NOW,
  });
  refreshed = [];
  onRefresh = () => {};
  changed = [];
  accounts = [
    { account: GMAIL, sources: ['gmail', 'google-calendar'], name: null, needsReconnect: false },
    { account: OUTLOOK, sources: ['outlook', 'outlook-calendar'], name: null, needsReconnect: false },
  ];
  store.calendars.listed(GMAIL, 'google-calendar', [
    { id: GOOGLE_PRIMARY, name: GOOGLE_PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.calendars.listed(OUTLOOK, 'outlook-calendar', [
    { id: OUTLOOK_DEFAULT, name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
  ]);
  invitations = setUpEmailInvitations({
    store,
    accounts: () => accounts,
    refresh: async (account, source) => {
      refreshed.push({ account, source });
      onRefresh(account);
    },
    now: () => NOW,
    onItemsChanged: (itemIds) => changed.push(itemIds),
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('the invitation card', () => {
  it('finds a Gmail invitation’s event by its UID, links them, and Accept answers it as from Calendar', async () => {
    const [pricing] = syncCalendar(GMAIL, 'google-calendar', [pricingEvent()]);
    const email = invitationEmail(GMAIL_INVITATION);

    const card = await invitations.card(email);
    expect(card).toMatchObject({
      state: 'event',
      event: { id: pricing, title: 'Pricing review' },
      clashes: [],
    });
    expect(refreshed).toEqual([]);
    // The email refers to the event, shown from both ends.
    expect(store.get(email)?.links).toEqual([
      expect.objectContaining({ type: 'refers-to', to: expect.objectContaining({ id: pricing }) }),
    ]);
    expect(store.get(pricing as string)?.backlinks.map((link) => link.from.id)).toEqual([email]);
    expect(changed).toEqual([[email, pricing]]);
    // Opened again: linked once.
    await invitations.card(email);
    expect(store.get(email)?.links).toHaveLength(1);

    // Accept, as the card's button does: the event's synced field, queued for Google Calendar.
    const detail = store.get(pricing as string)?.item.detail as EventDetail;
    store.record(
      { type: 'edit-fields', itemId: pricing as string, fields: answerFields(detail, 'accepted') },
      user,
    );
    expect((store.get(pricing as string)?.item.detail as EventDetail | undefined)?.myResponse).toBe(
      'accepted',
    );
    expect(store.outgoing.list().map(({ field, itemId }) => ({ field, itemId }))).toEqual([
      { field: 'response', itemId: pricing },
    ]);
  });

  it('finds an Outlook invitation’s event by the event id its event message names', async () => {
    const [review] = syncCalendar(OUTLOOK, 'outlook-calendar', [
      event('AAMkAGI2-evt-design-review=', 'Design review: onboarding', OUTLOOK_DEFAULT, {
        start: { at: Date.parse('2026-10-07T13:00:00Z'), timeZone: 'UTC', date: null },
        end: { at: Date.parse('2026-10-07T14:00:00Z'), timeZone: 'UTC', date: null },
      }),
    ]);
    const email = invitationEmail(
      {
        method: 'request',
        uid: '040000008200E00074C5B7101A82E00800000000D3B2C4DC9A1F0D01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90',
        eventId: 'AAMkAGI2-evt-design-review=',
        title: 'Design review: onboarding',
        start: Date.parse('2026-10-07T13:00:00Z'),
        end: Date.parse('2026-10-07T14:00:00Z'),
        allDay: false,
      },
      { account: OUTLOOK },
    );
    expect(await invitations.card(email)).toMatchObject({ state: 'event', event: { id: review } });
  });

  it('marks what the event overlaps in the User’s other Accounts, not in its own', async () => {
    syncCalendar(GMAIL, 'google-calendar', [
      pricingEvent(),
      event(`${GOOGLE_PRIMARY}/focus`, 'Focus', GOOGLE_PRIMARY, {
        myResponse: null,
        attendees: [],
        organiser: null,
      }),
    ]);
    const [board] = syncCalendar(OUTLOOK, 'outlook-calendar', [
      event('AAMkAGI2-evt-board=', 'Board prep', OUTLOOK_DEFAULT, {
        start: { at: THURSDAY_3PM + HOUR / 2, timeZone: 'UTC', date: null },
        end: { at: THURSDAY_3PM + 2 * HOUR, timeZone: 'UTC', date: null },
        myResponse: 'accepted',
      }),
    ]);
    const card = await invitations.card(invitationEmail(GMAIL_INVITATION));
    expect(card.state === 'event' && card.clashes).toEqual([
      { id: board, title: 'Board prep', account: OUTLOOK },
    ]);
  });

  it('not synced yet: refreshes that Account’s calendar first, then finds it', async () => {
    const email = invitationEmail(GMAIL_INVITATION);
    let pricing: string | undefined;
    onRefresh = () => {
      [pricing] = syncCalendar(GMAIL, 'google-calendar', [pricingEvent()]);
    };
    const card = await invitations.card(email);
    expect(refreshed).toEqual([{ account: GMAIL, source: 'google-calendar' }]);
    expect(card).toMatchObject({ state: 'event', event: { id: pricing } });
  });

  it('still not there after the refresh: says so, with what the email says', async () => {
    const card = await invitations.card(invitationEmail(GMAIL_INVITATION));
    expect(refreshed).toHaveLength(1);
    expect(card).toEqual({
      state: 'unsynced',
      why: 'not-found',
      title: 'Pricing review',
      start: THURSDAY_3PM,
      end: THURSDAY_3PM + HOUR,
      allDay: false,
    });
  });

  it('a calendar Commander doesn’t sync: says so at once, refreshing nothing', async () => {
    accounts = [{ account: GMAIL, sources: ['gmail'], name: null, needsReconnect: false }];
    const card = await invitations.card(invitationEmail(GMAIL_INVITATION));
    expect(card).toMatchObject({ state: 'unsynced', why: 'no-calendar' });
    expect(refreshed).toEqual([]);
  });

  it('no card for a cancellation, someone’s answer, or mail with no invitation', async () => {
    syncCalendar(GMAIL, 'google-calendar', [pricingEvent()]);
    const cancelled = invitationEmail({ ...GMAIL_INVITATION, method: 'cancel' }, { id: 'cancel' });
    const answered = invitationEmail({ ...GMAIL_INVITATION, method: 'reply' }, { id: 'reply' });
    const plain = deliver(store, NOW, [{ id: 'plain' }]).plain as string;
    for (const email of [cancelled, answered, plain]) {
      expect(await invitations.card(email)).toEqual({ state: 'none' });
    }
  });

  it('answers the window’s request once found', async () => {
    syncCalendar(GMAIL, 'google-calendar', [pricingEvent()]);
    const email = invitationEmail(GMAIL_INVITATION);
    const replies: unknown[] = [];
    const handled = invitations.handle(
      { type: 'item-store-request', id: 7, request: { op: 'email-invitation', itemId: email } },
      (reply) => replies.push(reply),
    );
    expect(handled).toBe(true);
    expect(
      invitations.handle({ type: 'item-store-request', id: 8, request: { op: 'events' } }, () => {}),
    ).toBe(false);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({
      type: 'item-store-reply',
      id: 7,
      response: { ok: true, result: { state: 'event' } },
    });
  });
});

describe('linking after a sync', () => {
  it('links an invitation that arrived to its event, and one whose event came in with a calendar sync', () => {
    const [pricing] = syncCalendar(GMAIL, 'google-calendar', [pricingEvent()]);
    const arrived = invitationEmail(GMAIL_INVITATION);
    expect(invitations.linkAfterSync({ source: 'gmail', account: GMAIL, itemIds: [arrived] })).toEqual([
      arrived,
      pricing,
    ]);

    const outlookEmail = invitationEmail(
      { ...GMAIL_INVITATION, uid: null, eventId: 'AAMkAGI2-evt-later=' },
      { account: OUTLOOK, id: 'later' },
    );
    expect(
      invitations.linkAfterSync({ source: 'outlook', account: OUTLOOK, itemIds: [outlookEmail] }),
    ).toEqual([]);
    const [later] = syncCalendar(OUTLOOK, 'outlook-calendar', [
      event('AAMkAGI2-evt-later=', 'Pricing review', OUTLOOK_DEFAULT),
    ]);
    expect(
      invitations.linkAfterSync({ source: 'outlook-calendar', account: OUTLOOK, itemIds: [later as string] }),
    ).toEqual([outlookEmail, later]);
  });
});
