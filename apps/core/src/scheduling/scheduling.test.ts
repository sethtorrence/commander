import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventDetail, type SourceItem, zonedTime } from '@commander/domain';
import type { FreeBusyResult } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import type { KnownAccount } from '../sync';
import { attendeeDirectory, newEventsTarget, type Scheduler, schedulingAccounts, setUpScheduler } from '.';

// Find time and the scheduler's helpers on a real Item store: the User's free time across every Account
// and calendar, narrowed by guests' free/busy where a provider shares it (recorded-style answers from
// Google's freeBusy.query and Graph's getSchedule), with each guest's calendar said to be checked or why
// not; where new events go; and where attendee names are looked up.

const LONDON = 'Europe/London';
const at = (day: string, time: string) => zonedTime(day, time, LONDON);
const PERSONAL = 'google:personal';
const WORK = 'google:work';
const OUTLOOK = 'outlook:72f988bf-0000-0000-0000-000000000000:sam';
const MONDAY_8AM = at('2026-10-05', '08:00');

let dir: string;
let store: ItemStore;
let scheduler: Scheduler;
let asked: { account: string; source: string; emails: string[] }[];
let answers: Record<string, (emails: string[]) => Promise<FreeBusyResult>>;

const known: KnownAccount[] = [
  {
    account: PERSONAL,
    sources: ['google-calendar'],
    name: null,
    addresses: ['alex@gmail.com'],
    needsReconnect: false,
  },
  {
    account: WORK,
    sources: ['google-calendar'],
    name: null,
    addresses: ['alex@titanlink.test'],
    needsReconnect: false,
  },
  {
    account: OUTLOOK,
    sources: ['outlook-calendar'],
    name: null,
    addresses: ['alex@contoso.test'],
    needsReconnect: false,
  },
];

function event(
  calendar: string,
  id: string,
  start: number,
  end: number,
  extra: Partial<EventDetail> = {},
): SourceItem {
  return {
    externalId: `${calendar}/${id}`,
    kind: 'event',
    title: id,
    detail: {
      kind: 'event',
      calendar: { id: calendar, name: calendar, colour: '#9fe1e7' },
      accountEmail: null,
      start: { at: start, timeZone: LONDON, date: null },
      end: { at: end, timeZone: LONDON, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: null,
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
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-scheduling-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => MONDAY_8AM,
  });
  store.calendars.listed(PERSONAL, 'google-calendar', [
    { id: 'alex@gmail.com', name: 'alex@gmail.com', colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.calendars.listed(WORK, 'google-calendar', [
    {
      id: 'alex@titanlink.test',
      name: 'alex@titanlink.test',
      colour: '#33b679',
      primary: true,
      accessRole: 'owner',
    },
    {
      id: 'c_team@group.calendar.google.com',
      name: 'Team',
      colour: '#aaaaaa',
      primary: false,
      accessRole: 'writer',
    },
  ]);
  store.calendars.listed(OUTLOOK, 'outlook-calendar', [
    { id: 'AAMk-default=', name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
  ]);
  // Monday: the personal Account is busy 09:00–12:00, the Outlook one 13:00–17:30. Tuesday: free.
  store.saveFromSource({
    source: 'google-calendar',
    account: PERSONAL,
    items: [event('alex@gmail.com', 'dentist', at('2026-10-05', '09:00'), at('2026-10-05', '12:00'))],
  });
  store.saveFromSource({
    source: 'outlook-calendar',
    account: OUTLOOK,
    items: [event('AAMk-default=', 'workshop', at('2026-10-05', '13:00'), at('2026-10-05', '17:30'))],
  });
  asked = [];
  answers = {};
  scheduler = setUpScheduler({
    store,
    accounts: () => known,
    freeBusy: (account, source, request) => {
      asked.push({ account, source, emails: request.emails });
      const answer = answers[account];
      return answer ? answer(request.emails) : Promise.reject(new Error('no answer recorded'));
    },
    now: () => MONDAY_8AM,
    timeZone: () => LONDON,
    timeoutMs: 50,
    log: () => {},
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const monday = (time: string) => at('2026-10-05', time);
const tuesday = (time: string) => at('2026-10-06', time);
const withinTwoDays = { from: MONDAY_8AM, to: at('2026-10-07', '00:00') };

describe('Find time', () => {
  it('offers up to 5 slots free across every Account, inside working hours, the earliest of each day first', async () => {
    const result = await scheduler.findTime({ attendees: [], durationMinutes: 60, ...withinTwoDays });
    expect(result.slots).toEqual([
      { start: monday('12:00'), end: monday('13:00') },
      { start: tuesday('09:00'), end: tuesday('10:00') },
      { start: tuesday('10:00'), end: tuesday('11:00') },
      { start: tuesday('11:00'), end: tuesday('12:00') },
      { start: tuesday('12:00'), end: tuesday('13:00') },
    ]);
    expect(result.timeZone).toBe(LONDON);
    expect(result.guests).toEqual([]);
  });

  it('narrows them by Google free/busy for a guest in a Workspace domain the User has an Account in', async () => {
    answers[WORK] = async (emails) => ({
      calendars: emails.map((email) => ({
        email,
        busy: [
          { start: monday('12:00'), end: monday('12:30') },
          { start: tuesday('09:00'), end: tuesday('11:00') },
        ],
        problem: null,
      })),
      cost: { requests: 1, complexity: null },
    });
    const result = await scheduler.findTime({
      attendees: ['Priya@Titanlink.test'],
      durationMinutes: 60,
      ...withinTwoDays,
    });
    expect(asked).toEqual([{ account: WORK, source: 'google-calendar', emails: ['priya@titanlink.test'] }]);
    expect(result.slots[0]).toEqual({ start: tuesday('11:00'), end: tuesday('12:00') });
    expect(result.slots).not.toContainEqual({ start: monday('12:00'), end: monday('13:00') });
    expect(result.guests).toEqual([
      { email: 'priya@titanlink.test', checked: true, why: null, outside: false },
    ]);
  });

  it('and by Graph getSchedule for a guest in a Microsoft work organisation', async () => {
    answers[OUTLOOK] = async (emails) => ({
      calendars: emails.map((email) => ({
        email,
        busy: [{ start: tuesday('09:00'), end: tuesday('18:00') }],
        problem: null,
      })),
      cost: { requests: 1, complexity: null },
    });
    const result = await scheduler.findTime({
      attendees: ['dana@contoso.test'],
      durationMinutes: 60,
      ...withinTwoDays,
    });
    expect(asked).toEqual([{ account: OUTLOOK, source: 'outlook-calendar', emails: ['dana@contoso.test'] }]);
    expect(result.slots).toEqual([{ start: monday('12:00'), end: monday('13:00') }]);
    expect(result.guests[0]).toMatchObject({ checked: true, outside: false });
  });

  it('says when a guest’s calendar couldn’t be checked: outsiders, personal addresses, refusals, slowness', async () => {
    answers[WORK] = async (emails) => ({
      calendars: emails.map((email) => ({
        email,
        busy: null,
        problem: 'Google doesn’t share this calendar with you.',
      })),
      cost: { requests: 1, complexity: null },
    });
    answers[OUTLOOK] = () => new Promise(() => {});
    const result = await scheduler.findTime({
      attendees: ['leo@acme.test', 'bob@gmail.com', 'omar@titanlink.test', 'dana@contoso.test'],
      durationMinutes: 30,
      ...withinTwoDays,
    });
    expect(result.guests).toEqual([
      {
        email: 'leo@acme.test',
        checked: false,
        why: 'Outside your organisations: only your calendars were checked.',
        outside: true,
      },
      {
        email: 'bob@gmail.com',
        checked: false,
        why: 'A personal address: only your calendars were checked.',
        outside: true,
      },
      {
        email: 'omar@titanlink.test',
        checked: false,
        why: 'Google doesn’t share this calendar with you.',
        outside: false,
      },
      {
        email: 'dana@contoso.test',
        checked: false,
        why: 'Their calendar took too long to answer.',
        outside: false,
      },
    ]);
    // Only the User's own free time then.
    expect(result.slots[0]).toEqual({ start: monday('12:00'), end: monday('12:30') });
  });

  it('hands back the booking link, for guests outside', async () => {
    store.schedulingSettings.save({ bookingLink: 'https://calendar.app.google/abc123' });
    const result = await scheduler.findTime({
      attendees: ['leo@acme.test'],
      durationMinutes: 30,
      ...withinTwoDays,
    });
    expect(result.bookingLink).toBe('https://calendar.app.google/abc123');
  });

  it('answers an Item store request once the providers have', async () => {
    const replies: unknown[] = [];
    const handled = scheduler.handle(
      {
        type: 'item-store-request',
        id: 7,
        request: { op: 'find-time', request: { attendees: [], durationMinutes: 30, ...withinTwoDays } },
      },
      (reply) => replies.push(reply),
    );
    expect(handled).toBe(true);
    expect(scheduler.handle({ type: 'item-store-request', id: 8, request: { op: 'query' } }, () => {})).toBe(
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replies).toMatchObject([
      { type: 'item-store-reply', id: 7, response: { ok: true, result: { slots: [{}, {}, {}, {}, {}] } } },
    ]);
  });
});

describe('the scheduler’s helpers', () => {
  it('knows each calendar Account’s address and whether it belongs to an organisation', () => {
    expect(schedulingAccounts(store, known)).toEqual([
      { account: PERSONAL, source: 'google-calendar', address: 'alex@gmail.com', work: false },
      { account: WORK, source: 'google-calendar', address: 'alex@titanlink.test', work: true },
      { account: OUTLOOK, source: 'outlook-calendar', address: 'alex@contoso.test', work: true },
    ]);
  });

  it('puts new events where Settings → Calendar says, else on a main calendar', () => {
    expect(newEventsTarget(store)).toEqual({ account: PERSONAL, calendarId: 'alex@gmail.com' });
    store.focusSettings.save({ ...store.focusSettings.read(), focusAccount: OUTLOOK });
    expect(newEventsTarget(store)).toEqual({ account: OUTLOOK, calendarId: 'AAMk-default=' });
    store.schedulingSettings.save({
      newEventsAccount: WORK,
      newEventsCalendar: 'c_team@group.calendar.google.com',
    });
    expect(newEventsTarget(store)).toEqual({ account: WORK, calendarId: 'c_team@group.calendar.google.com' });
    // A calendar the Account no longer lists: its main calendar.
    store.schedulingSettings.save({ newEventsAccount: WORK, newEventsCalendar: 'c_gone' });
    expect(newEventsTarget(store)).toEqual({ account: WORK, calendarId: 'alex@titanlink.test' });
  });

  it('looks names up on events and emails (not the User’s own), then People', () => {
    store.saveFromSource({
      source: 'google-calendar',
      account: PERSONAL,
      items: [
        event('alex@gmail.com', 'renewal', tuesday('15:00'), tuesday('16:00'), {
          organiser: { email: 'alex@gmail.com', name: 'Alex Kim', self: true },
          attendees: [
            {
              email: 'alex@gmail.com',
              name: 'Alex Kim',
              self: true,
              response: 'accepted',
              organiser: true,
              optional: false,
              resource: false,
            },
            {
              email: 'Leo.Park@acme.test',
              name: 'Leo Park',
              self: false,
              response: 'accepted',
              organiser: false,
              optional: false,
              resource: false,
            },
            {
              email: 'room-1@titanlink.test',
              name: 'Room 1',
              self: false,
              response: 'accepted',
              organiser: false,
              optional: false,
              resource: true,
            },
          ],
        }),
      ],
    });
    const directory = attendeeDirectory(store);
    expect(directory.seen).toEqual([{ email: 'leo.park@acme.test', name: 'Leo Park' }]);
  });
});
