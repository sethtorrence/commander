import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, CommanderEventDraft, EventDetail } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Meetings Commander makes (#132): an event with guests from Ares's proposal or Find time, made at once
// as an `event` Item on the calendar chosen and queued for the Source like a focus block (ADR 0003), but
// an ordinary meeting: busy, not private, the guests on it, the User its organiser. And Settings →
// Calendar's scheduling settings: where new events go, and the booking link.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ALEX = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const WORK = 'c_work@group.calendar.google.com';
const SHARED = 'c_shared@group.calendar.google.com';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 5, 7);
const START = Date.UTC(2026, 9, 6, 13);
const HALF = 30 * 60_000;

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-meetings-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
  store.calendars.listed(ALEX, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
    { id: WORK, name: 'Work', colour: '#33b679', primary: false, accessRole: 'writer' },
    { id: SHARED, name: 'Holidays', colour: '#aaaaaa', primary: false, accessRole: 'reader' },
  ]);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const time = (at: number) => ({ at, timeZone: 'Europe/London', date: null });

function meeting(extra: Partial<CommanderEventDraft> = {}): CommanderEventDraft {
  return {
    kind: 'meeting',
    account: ALEX,
    title: 'Call with Leo',
    start: time(START),
    end: time(START + HALF),
    attendees: [{ email: 'Leo.Park@acme.test', name: 'Leo Park' }],
    ...extra,
  };
}

function detailOf(itemId: string): EventDetail {
  const detail = store.get(itemId)?.item.detail;
  if (detail?.kind !== 'event') throw new Error(`${itemId} is not an event`);
  return detail;
}

describe('a meeting Commander makes', () => {
  it('is an event at once on the main calendar: busy, not private, the guests on it, the User organising', () => {
    const entry = store.createEvent(meeting(), user);
    const item = store.get(entry.itemId)?.item;
    expect(item).toMatchObject({
      kind: 'event',
      source: 'google-calendar',
      account: ALEX,
      externalId: `commander:${entry.itemId}`,
      title: 'Call with Leo',
      people: ['leo.park@acme.test'],
    });
    expect(detailOf(entry.itemId)).toMatchObject({
      calendar: { id: PRIMARY, name: PRIMARY },
      busy: true,
      private: false,
      organiser: { email: PRIMARY, self: true },
      attendees: [
        {
          email: 'leo.park@acme.test',
          name: 'Leo Park',
          response: 'needs-action',
          organiser: false,
          self: false,
          optional: false,
          resource: false,
        },
      ],
      myResponse: null,
      createdByCommander: 'meeting',
    });
  });

  it('queues its creation on its calendar, with its guests to invite', () => {
    const entry = store.createEvent(meeting({ calendarId: WORK }), user);
    expect(detailOf(entry.itemId).calendar).toEqual({ id: WORK, name: 'Work', colour: '#33b679' });
    expect(store.outgoing.forItem(entry.itemId)).toMatchObject([
      {
        field: 'create',
        value: {
          kind: 'meeting',
          calendarId: WORK,
          commanderId: entry.itemId,
          title: 'Call with Leo',
          attendees: [{ email: 'leo.park@acme.test', name: 'Leo Park' }],
        },
      },
    ]);
  });

  it('won’t go on a calendar the User can’t write to, or one the Account doesn’t have', () => {
    expect(() => store.createEvent(meeting({ calendarId: SHARED }), user)).toThrow(/can’t add events/);
    expect(() => store.createEvent(meeting({ calendarId: 'c_nope' }), user)).toThrow(/doesn’t have/);
  });

  it('is undone by deleting it at the Source', () => {
    const entry = store.createEvent(meeting(), user);
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(store.get(entry.itemId)?.item.deletedAt).not.toBeNull();
  });
});

describe('scheduling settings', () => {
  it('start with nothing chosen and no booking link, and keep what the User saves', () => {
    expect(store.schedulingSettings.read()).toEqual({
      newEventsAccount: null,
      newEventsCalendar: null,
      bookingLink: null,
    });
    const saved = store.schedulingSettings.save({
      newEventsAccount: ALEX,
      newEventsCalendar: WORK,
      bookingLink: 'https://calendar.app.google/abc123',
    });
    expect(saved.bookingLink).toBe('https://calendar.app.google/abc123');
    expect(store.schedulingSettings.read()).toEqual(saved);
    expect(() => store.schedulingSettings.save({ bookingLink: 'ftp://nope' })).toThrow();
  });
});
