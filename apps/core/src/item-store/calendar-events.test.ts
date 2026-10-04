import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, EventDetail, Project, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Calendar events in the Item store: each event (each instance of a recurring one) is an `event`
// Item saved from calendar sync like any Source Item (ADR 0001), found by time range for the Agenda,
// filed by Rules as it arrives, and hidden with its calendar when the User switches that off.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ALEX = 'google:104512345678901234567';
const SAM = 'google:209876543210987654321';
const PRIMARY = 'alex@gmail.test';
const STANDUPS = 'c_tl_standups@group.calendar.google.com';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 3, 12);
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-events-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const calendarOf = (id: string) =>
  id === STANDUPS
    ? { id, name: 'Titanlink Standups', colour: '#33b679' }
    : { id, name: PRIMARY, colour: '#9fe1e7' };

function event(
  id: string,
  title: string,
  start: number,
  end: number,
  extra: Partial<EventDetail> = {},
  calendarId = PRIMARY,
): SourceItem {
  const detail: EventDetail = {
    kind: 'event',
    calendar: calendarOf(calendarId),
    accountEmail: PRIMARY,
    start: { at: start, timeZone: 'Europe/London', date: null },
    end: { at: end, timeZone: 'Europe/London', date: null },
    allDay: false,
    location: null,
    description: null,
    organiser: { email: PRIMARY, name: null, self: true },
    attendees: [],
    myResponse: null,
    meetingUrl: null,
    busy: true,
    private: false,
    seriesId: null,
    webUrl: `https://www.google.com/calendar/event?eid=${id}`,
    createdByCommander: null,
    ...extra,
  };
  return { externalId: `${calendarId}/${id}`, kind: 'event', title, people: [PRIMARY], detail };
}

function allDay(id: string, title: string, from: string, until: string): SourceItem {
  const base = event(id, title, Date.parse(`${from}T00:00:00Z`), Date.parse(`${until}T00:00:00Z`));
  const detail = base.detail as EventDetail;
  return {
    ...base,
    detail: {
      ...detail,
      allDay: true,
      start: { at: detail.start.at, timeZone: null, date: from },
      end: { at: detail.end.at, timeZone: null, date: until },
    },
  };
}

const save = (items: SourceItem[], deleted: string[] = [], account = ALEX) =>
  store.saveFromSource({ source: 'google-calendar', account, items, deleted });

const titles = (items: { title: string }[]) => items.map((item) => item.title);

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

describe('events from calendar sync', () => {
  it('are Items with their detail, and saving them again unchanged records nothing', () => {
    const items = [event('dentist', 'Dentist', T + 2 * HOUR, T + 3 * HOUR)];
    const [id] = save(items).created;
    const activity = store.activity();

    const again = save(items);
    expect(again).toMatchObject({ created: [], updated: [], unchanged: [id] });
    expect(store.activity()).toEqual(activity);
    expect(store.get(id ?? '')?.item).toMatchObject({
      kind: 'event',
      source: 'google-calendar',
      account: ALEX,
      title: 'Dentist',
      detail: items[0]?.detail,
    });
  });

  it('keeps filing and Links made in Commander through later syncs', () => {
    const [id] = save([event('review', 'Design review', T + HOUR, T + 2 * HOUR)]).created;
    const tl = project('Titanlink', 'TL');
    store.record(
      { type: 'update', itemId: id ?? '', changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Prepare the review' } }, user);
    store.link({ from: todo.itemId, linkType: 'about', to: id ?? '' }, user);

    save([event('review', 'Design review (moved)', T + 3 * HOUR, T + 4 * HOUR)]);

    expect(store.get(id ?? '')).toMatchObject({
      item: { title: 'Design review (moved)', filing: { projectId: tl.id, filedBy: 'user' } },
      backlinks: [{ type: 'about', from: { id: todo.itemId } }],
    });
  });

  it('become tombstones when cancelled, keeping their Links', () => {
    const [id] = save([event('review', 'Design review', T + HOUR, T + 2 * HOUR)]).created;
    expect(save([], [`${PRIMARY}/review`]).tombstoned).toEqual([id]);
    expect(store.events({ from: T, to: T + 24 * HOUR })).toEqual([]);
    expect(store.get(id ?? '')?.item.deletedAt).toBe(T);
  });

  it('are filed by a calendar Rule as they arrive', () => {
    const tl = project('Titanlink', 'TL');
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tl.id },
        when: {
          join: 'and',
          terms: [
            { field: 'google-calendar.calendar', op: 'is', value: STANDUPS, label: 'Titanlink Standups' },
          ],
        },
      },
    });

    const { created } = save([
      event('standup_1', 'TL standup', T + HOUR, T + 2 * HOUR, { seriesId: 'standup' }, STANDUPS),
      event('dentist', 'Dentist', T + HOUR, T + 2 * HOUR),
    ]);

    expect(created.map((id) => store.get(id)?.item.filing)).toEqual([
      { projectId: tl.id, filedBy: 'rule' },
      null,
    ]);
  });

  it('are found by search: title, location, attendees and description', () => {
    save([
      event('review', 'Design review', T + HOUR, T + 2 * HOUR, {
        location: 'Room 4',
        description: 'Walk through the onboarding flow',
        attendees: [
          {
            email: 'dana@titanlink.test',
            name: 'Dana Ruiz',
            self: false,
            response: 'accepted',
            organiser: true,
            optional: false,
            resource: false,
          },
        ],
      }),
    ]);
    for (const text of ['design', 'room 4', 'dana', 'onboarding']) {
      expect(titles(store.search.query({ text }).hits.map((hit) => hit.item))).toEqual(['Design review']);
    }
  });
});

describe('the events in a time range', () => {
  it('lists live events overlapping it, earliest first, all-day ones by their days anywhere', () => {
    save([
      event('late', 'Late call', T + 8 * HOUR, T + 9 * HOUR),
      event('early', 'Early run', T - 4 * HOUR, T - 3 * HOUR),
      event('spanning', 'Offsite', T - 30 * HOUR, T + 2 * HOUR),
      event('tomorrow', 'Tomorrow', T + 30 * HOUR, T + 31 * HOUR),
      allDay('conf', 'Conference', '2026-10-03', '2026-10-04'),
      allDay('next', 'Next week', '2026-10-10', '2026-10-11'),
    ]);
    const today = { from: Date.UTC(2026, 9, 3), to: Date.UTC(2026, 9, 4) };

    // Ordered by the stored range: an all-day event as from the earliest midnight on Earth.
    expect(titles(store.events(today))).toEqual(['Offsite', 'Conference', 'Early run', 'Late call']);
    // An all-day event on the 4th still matters to someone at UTC+14 whose 4th starts on our 3rd.
    expect(titles(store.events({ from: Date.UTC(2026, 9, 3, 23), to: Date.UTC(2026, 9, 4) }))).toContain(
      'Conference',
    );
  });

  it('narrows to the Accounts asked for', () => {
    save([event('a', 'Alex’s', T, T + HOUR)]);
    save([event('s', 'Sam’s', T, T + HOUR)], [], SAM);
    expect(titles(store.events({ from: T - HOUR, to: T + 2 * HOUR, accounts: [SAM] }))).toEqual(['Sam’s']);
  });
});

describe('calendars on and off', () => {
  const listed = [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
    { id: STANDUPS, name: 'Titanlink Standups', colour: '#33b679', primary: false, accessRole: 'owner' },
    { id: 'holidays', name: 'Holidays', colour: '#16a765', primary: false, accessRole: 'reader' },
  ];

  it('keeps each Account’s calendars as listed, primary and owned ones on, subscribed ones off', () => {
    expect([...store.calendars.listed(ALEX, 'google-calendar', listed)]).toEqual([PRIMARY, STANDUPS]);
    expect(store.calendars.list().map(({ id, on }) => [id, on])).toEqual([
      [PRIMARY, true],
      [STANDUPS, true],
      ['holidays', false],
    ]);

    // A calendar gone from the list goes; the User's switches stay.
    store.setCalendarOn({ account: ALEX, calendarId: 'holidays', on: true }, user);
    store.calendars.listed(ALEX, 'google-calendar', listed.slice(1));
    expect(store.calendars.list().map(({ id, on }) => [id, on])).toEqual([
      [STANDUPS, true],
      ['holidays', true],
    ]);
  });

  it('switching one off hides its events at once; synced again once on, they come back filed as they were', () => {
    store.calendars.listed(ALEX, 'google-calendar', listed);
    const standup = event('standup_1', 'TL standup', T + HOUR, T + 2 * HOUR, {}, STANDUPS);
    const [id] = save([standup, event('dentist', 'Dentist', T + HOUR, T + 2 * HOUR)]).created;
    const tl = project('Titanlink', 'TL');
    store.record(
      { type: 'update', itemId: id ?? '', changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );

    const after = store.setCalendarOn({ account: ALEX, calendarId: STANDUPS, on: false }, user);
    expect(after.find((calendar) => calendar.id === STANDUPS)?.on).toBe(false);
    expect(titles(store.events({ from: T, to: T + 3 * HOUR }))).toEqual(['Dentist']);
    expect(store.search.query({ text: 'standup' }).hits).toEqual([]);
    expect(store.activity({ itemId: id })[0]).toMatchObject({
      action: 'delete',
      by: { kind: 'user' },
      why: 'Calendar “Titanlink Standups” switched off',
    });

    store.setCalendarOn({ account: ALEX, calendarId: STANDUPS, on: true }, user);
    save([standup]);
    expect(store.get(id ?? '')?.item).toMatchObject({ deletedAt: null, filing: { projectId: tl.id } });
  });

  it('refuses a calendar the Account doesn’t list', () => {
    expect(() => store.setCalendarOn({ account: ALEX, calendarId: 'nope', on: false }, user)).toThrow(
      /No calendar/,
    );
  });

  it('forgets an Account’s calendars when it is removed', () => {
    store.calendars.listed(ALEX, 'google-calendar', listed);
    store.syncState.remove(ALEX);
    expect(store.calendars.list()).toEqual([]);
  });
});
