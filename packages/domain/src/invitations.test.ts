import { describe, expect, it } from 'vitest';
import type { EventDetail } from './calendar';
import { overlapping } from './clashes';
import { answerFields, awaitingAnswer, invitationReason, isInvitation, seriesAnswerOf } from './invitations';
import type { Item } from './items';
import { rankByBandRules } from './ranking';

// Invitations (#129): what the User can answer, what waits for an answer, and what double-books them.

const WORK = 'outlook:tenant:sam';
const HOME = 'google:alex';
// Monday 5 October 2026, 09:00 local.
const NOW = new Date(2026, 9, 5, 9).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

let next = 0;
function event(
  title: string,
  start: number,
  end: number,
  extra: Partial<EventDetail> = {},
  item: Partial<Item> = {},
): Item & { detail: EventDetail } {
  next += 1;
  return {
    id: `event-${next}`,
    kind: 'event',
    source: 'google-calendar',
    account: HOME,
    externalId: `primary/e${next}`,
    title,
    people: [],
    status: 'open',
    filing: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...item,
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Calendar', colour: '#0078d4' },
      accountEmail: 'alex@gmail.test',
      start: { at: start, timeZone: 'Europe/London', date: null },
      end: { at: end, timeZone: 'Europe/London', date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: { email: 'alex@gmail.test', name: null, self: true },
      attendees: [],
      myResponse: null,
      meetingUrl: null,
      busy: true,
      private: false,
      seriesId: null,
      webUrl: null,
      createdByCommander: null,
      ...extra,
    },
  } as Item & { detail: EventDetail };
}

const dana = { email: 'dana@acme.test', name: 'Dana Reyes', self: false };
const invite = (title: string, start: number, end: number, extra: Partial<EventDetail> = {}, item = {}) =>
  event(title, start, end, { organiser: dana, myResponse: 'needs-action', ...extra }, item);

describe('invitations', () => {
  it('are events someone else organised that the User is a guest of', () => {
    expect(isInvitation(invite('Pricing review', at(8, 15), at(8, 16)))).toBe(true);
    expect(isInvitation(event('My own', at(8, 15), at(8, 16), { myResponse: 'accepted' }))).toBe(false);
    expect(isInvitation(event('Holiday', at(8, 15), at(8, 16)))).toBe(false);
    expect(isInvitation(invite('Gone', at(8, 15), at(8, 16), {}, { deletedAt: NOW }))).toBe(false);
  });

  it('wait for an answer until answered, or over', () => {
    expect(awaitingAnswer(invite('Pricing review', at(8, 15), at(8, 16)), NOW)).toBe(true);
    expect(awaitingAnswer(invite('Answered', at(8, 15), at(8, 16), { myResponse: 'tentative' }), NOW)).toBe(
      false,
    );
    expect(awaitingAnswer(invite('Past', at(2, 15), at(2, 16)), NOW)).toBe(false);
  });

  it('answer one instance, or the whole series', () => {
    const instance = invite('Weekly', at(8, 15), at(8, 16), { seriesId: 'series-1' });
    expect(answerFields(instance.detail, 'declined')).toEqual({ response: 'declined' });
    expect(answerFields(instance.detail, 'accepted', true)).toEqual({
      response: 'accepted',
      seriesResponse: 'accepted',
    });
    // A one-off has no series to answer.
    expect(answerFields(invite('Once', at(8, 15), at(8, 16)).detail, 'accepted', true)).toEqual({
      response: 'accepted',
    });
    expect(seriesAnswerOf({ ...instance.detail, seriesResponse: 'accepted' })).toBe('accepted');
    expect(seriesAnswerOf(instance.detail)).toBe('needs-action');
  });
});

describe('double-bookings', () => {
  const pricing = invite('Pricing review', at(8, 15), at(8, 16));

  it('are the busy events sharing some of its time, from every Account and calendar', () => {
    const board = event(
      'Board prep',
      at(8, 15, 30),
      at(8, 16, 30),
      { myResponse: 'accepted' },
      { account: WORK },
    );
    const dentist = event('Dentist', at(8, 14, 30), at(8, 15, 15));
    const sameAccount = event('Focus', at(8, 15), at(8, 15, 30), {}, { account: HOME });
    expect(overlapping(pricing, [board, dentist, sameAccount, pricing]).map((each) => each.title)).toEqual([
      'Dentist',
      'Focus',
      'Board prep',
    ]);
  });

  it('leave out what doesn’t keep the User busy, back-to-back events and the same meeting seen twice', () => {
    const others = [
      event('Before', at(8, 14), at(8, 15)),
      event('After', at(8, 16), at(8, 17)),
      event('Free', at(8, 15), at(8, 16), { busy: false }),
      event('Declined', at(8, 15), at(8, 16), { myResponse: 'declined' }),
      event('All day', at(8, 0), at(9, 0), { allDay: true }),
      event('Cancelled', at(8, 15), at(8, 16), {}, { deletedAt: NOW }),
      event('Pricing review', at(8, 15), at(8, 16), {}, { account: WORK }),
    ];
    expect(overlapping(pricing, others)).toEqual([]);
  });
});

describe('the Dashboard', () => {
  it('puts invitations awaiting an answer in Today, saying who invited the User and when', () => {
    const pricing = invite('Pricing review', at(8, 15), at(8, 16));
    expect(invitationReason(pricing, NOW)).toBe('Dana invited you to Pricing review, Thu 15:00');
    const answered = invite('Answered', at(8, 15), at(8, 16), { myResponse: 'accepted' });
    const ranked = rankByBandRules([pricing, answered], { now: NOW, users: {} });
    expect(ranked).toEqual([
      {
        itemId: pricing.id,
        band: 'today',
        reason: 'Dana invited you to Pricing review, Thu 15:00',
        rank: 1,
      },
    ]);
  });
});
