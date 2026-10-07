import { describe, expect, it } from 'vitest';
import { rankingFingerprint } from './ares-ranking';
import type { EventDetail } from './calendar';
import type { EmailDetail, EmailInvitation } from './email';
import {
  carriesInvitation,
  emailCause,
  emailWebUrl,
  fromRealPerson,
  invitationEventOf,
  senderName,
} from './email-calendar';
import type { Item } from './items';

// Email meets Calendar and Todos (#144), the shared rules: which email carries an invitation to
// answer, which event it is about, which mail is from a real person, and how a chained suggestion
// from an email names its cause. Times are local (new Date(y, m, d…)), so they read the same in any
// time zone.

const NOW = new Date(2026, 9, 6, 10, 42).getTime();
const HOUR = 3_600_000;
const THURSDAY_3PM = new Date(2026, 9, 8, 15).getTime();

const emailDetail = (fields: Partial<EmailDetail> = {}): EmailDetail => ({
  kind: 'email',
  messageId: '<m@mail.test>',
  inReplyTo: null,
  references: [],
  threadKey: 'mid:<m@mail.test>',
  sourceThreadId: null,
  from: { name: 'Dana Reyes', address: 'dana@acme.test' },
  to: [{ name: null, address: 'alex@gmail.test' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Invitation: Pricing review',
  sentAt: new Date(2026, 9, 6, 9, 42).getTime(),
  snippet: '',
  read: false,
  starred: false,
  inInbox: true,
  sentByMe: false,
  labels: [],
  attachments: [],
  hasInvitation: false,
  listUnsubscribe: null,
  listId: null,
  ...fields,
});

const invitation = (fields: Partial<EmailInvitation> = {}): EmailInvitation => ({
  method: 'request',
  uid: 'pricing@google.com',
  eventId: null,
  title: 'Pricing review',
  start: THURSDAY_3PM,
  end: THURSDAY_3PM + HOUR,
  allDay: false,
  ...fields,
});

const email = (detail: EmailDetail, account = 'google:alex'): Item => ({
  id: 'email-1',
  kind: 'email',
  source: 'gmail',
  account,
  externalId: '19a6c0f1e2d3b4a5',
  title: detail.subject,
  people: [],
  filing: null,
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  detail,
});

const event = (
  id: string,
  start: number,
  fields: Partial<EventDetail> = {},
  item: Partial<Item> = {},
): Item & { detail: EventDetail } => ({
  id,
  kind: 'event',
  source: 'google-calendar',
  account: 'google:alex',
  externalId: `alex@gmail.test/${id}`,
  title: 'Pricing review',
  people: [],
  filing: null,
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...item,
  detail: {
    kind: 'event',
    calendar: { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7' },
    accountEmail: 'alex@gmail.test',
    start: { at: start, timeZone: null, date: null },
    end: { at: start + HOUR, timeZone: null, date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: null,
    attendees: [],
    myResponse: 'needs-action',
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: null,
    webUrl: null,
    createdByCommander: null,
    ...fields,
  },
});

describe('carriesInvitation', () => {
  it('an invitation to answer: not a cancellation or an answer, not the User’s own', () => {
    expect(carriesInvitation(emailDetail({ hasInvitation: true, invitation: invitation() }))).toBe(true);
    // One Commander couldn't read is still an invitation (its card offers Open in Gmail).
    expect(carriesInvitation(emailDetail({ hasInvitation: true }))).toBe(true);
    expect(
      carriesInvitation(emailDetail({ hasInvitation: true, invitation: invitation({ method: 'cancel' }) })),
    ).toBe(false);
    expect(
      carriesInvitation(emailDetail({ hasInvitation: true, invitation: invitation({ method: 'reply' }) })),
    ).toBe(false);
    expect(carriesInvitation(emailDetail({ hasInvitation: true, sentByMe: true }))).toBe(false);
    expect(carriesInvitation(emailDetail())).toBe(false);
  });
});

describe('invitationEventOf', () => {
  const mail = email(emailDetail({ hasInvitation: true, invitation: invitation() }));

  it('finds the event by its UID, in the email’s own Account only', () => {
    const elsewhere = event(
      'other',
      THURSDAY_3PM,
      { icalUid: 'pricing@google.com' },
      { account: 'google:work' },
    );
    const found = event('pricing', THURSDAY_3PM, { icalUid: 'pricing@google.com' });
    expect(invitationEventOf(mail, [elsewhere, found], NOW)?.id).toBe('pricing');
    expect(invitationEventOf(mail, [elsewhere], NOW)).toBeNull();
  });

  it('picks the instance of a series the invitation names, else the next one not over', () => {
    const series = [0, 7, 14].map((days) =>
      event(`weekly-${days}`, THURSDAY_3PM + days * 24 * HOUR, { icalUid: 'pricing@google.com' }),
    );
    expect(invitationEventOf(mail, series, NOW)?.id).toBe('weekly-0');
    const moved = email(emailDetail({ hasInvitation: true, invitation: invitation({ start: 0 }) }));
    expect(invitationEventOf(moved, series, THURSDAY_3PM + 2 * HOUR)?.id).toBe('weekly-7');
  });

  it('finds an Outlook event by the id its event message names', () => {
    const outlook = email(
      emailDetail({ hasInvitation: true, invitation: invitation({ uid: null, eventId: 'AAMk-evt=' }) }),
      'microsoft:alex',
    );
    const found = event('outlook', THURSDAY_3PM, {}, { account: 'microsoft:alex', externalId: 'AAMk-evt=' });
    expect(invitationEventOf(outlook, [found], NOW)?.id).toBe('outlook');
  });

  it('falls back to the same title and start, and never to a deleted event', () => {
    const plain = email(emailDetail({ hasInvitation: true, invitation: invitation({ uid: null }) }));
    expect(invitationEventOf(plain, [event('by-title', THURSDAY_3PM)], NOW)?.id).toBe('by-title');
    expect(invitationEventOf(plain, [event('later', THURSDAY_3PM + HOUR)], NOW)).toBeNull();
    expect(invitationEventOf(plain, [event('gone', THURSDAY_3PM, {}, { deletedAt: NOW })], NOW)).toBeNull();
  });
});

describe('fromRealPerson', () => {
  it('leaves out mailing lists, unsubscribe links, automated senders and the User’s own', () => {
    expect(fromRealPerson(emailDetail())).toBe(true);
    expect(fromRealPerson(emailDetail({ listId: 'weekly.news.test' }))).toBe(false);
    expect(fromRealPerson(emailDetail({ listUnsubscribe: '<mailto:u@news.test>' }))).toBe(false);
    for (const address of [
      'no-reply@ci.test',
      'noreply@ci.test',
      'notifications@github.com',
      'mailer-daemon@x.test',
    ])
      expect(fromRealPerson(emailDetail({ from: { name: 'Bot', address } }))).toBe(false);
    expect(fromRealPerson(emailDetail({ from: { name: 'Nora', address: 'nora@acme.test' } }))).toBe(true);
    expect(fromRealPerson(emailDetail({ sentByMe: true }))).toBe(false);
  });
});

describe('what caused a suggestion', () => {
  it('names the sender by first name, and when the email came', () => {
    expect(senderName(emailDetail())).toBe('Dana');
    expect(senderName(emailDetail({ from: { name: null, address: 'dana@acme.test' } }))).toBe(
      'dana@acme.test',
    );
    expect(emailCause(emailDetail(), NOW)).toBe('Suggested because of Dana’s email, 09:42');
    expect(emailCause(emailDetail(), NOW + 24 * HOUR)).toBe('Suggested because of Dana’s email, Tue 09:42');
  });
});

describe('emailWebUrl', () => {
  it('opens the email in Gmail or Outlook on the web', () => {
    expect(emailWebUrl({ source: 'gmail', externalId: '19a6' }, { address: 'alex@gmail.test' })).toBe(
      'https://mail.google.com/mail/?authuser=alex%40gmail.test#all/19a6',
    );
    expect(emailWebUrl({ source: 'outlook', externalId: 'AAMk=' }, { address: 'sam@contoso.test' })).toBe(
      'https://outlook.office.com/mail/deeplink/read/AAMk%3D?login_hint=sam%40contoso.test',
    );
    expect(emailWebUrl({ source: 'outlook', externalId: 'AAMk=' }, { address: null, personal: true })).toBe(
      'https://outlook.live.com/mail/0/deeplink/read/AAMk%3D',
    );
  });
});

describe('rankingFingerprint for an email', () => {
  it('changes with its Bucket, a reply or a snooze, so Ares ranks it again', () => {
    const base = email(emailDetail({ bucket: { bucketId: 'needs-reply', sortedBy: 'user' } }));
    const same = rankingFingerprint(base);
    const moved = rankingFingerprint(
      email(emailDetail({ bucket: { bucketId: 'waiting-on-others', sortedBy: 'user' } })),
    );
    const snoozed = rankingFingerprint(
      email(
        emailDetail({
          bucket: { bucketId: 'needs-reply', sortedBy: 'user' },
          snooze: { until: NOW, returned: false },
        }),
      ),
    );
    expect(rankingFingerprint(base)).toBe(same);
    expect(new Set([same, moved, snoozed]).size).toBe(3);
  });
});
