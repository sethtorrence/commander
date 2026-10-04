import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreMessage, EventDetail, PresenceState, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { setUpMeetings } from '.';

// Today's meetings in the Core (#128), on an injectable clock: the chips follow each calendar sync and
// today's Daily Note being made, and the opt-in heads-up comes 2 minutes before a meeting, once.

const at = (hour: number, minute = 0, second = 0) => new Date(2026, 9, 3, hour, minute, second).getTime();
const ACCOUNT = 'google:1';

let dir: string;
let store: ItemStore;
let clock: number;
let sent: CoreMessage[];
let presence: PresenceState;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-meetings-'));
  clock = at(8);
  sent = [];
  presence = 'active';
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const meetings = () =>
  setUpMeetings({
    store,
    now: () => clock,
    send: (message) => sent.push(message),
    presence: () => presence,
    timers: false,
  });

function event(id: string, title: string, start: number, extra: Partial<EventDetail> = {}): SourceItem {
  return {
    externalId: id,
    kind: 'event',
    title,
    detail: {
      kind: 'event',
      calendar: { id: 'primary', name: 'Primary', colour: '#9fe1e7' },
      accountEmail: 'alex@gmail.test',
      start: { at: start, timeZone: null, date: null },
      end: { at: start + 30 * 60_000, timeZone: null, date: null },
      allDay: false,
      location: null,
      description: null,
      organiser: null,
      attendees: [],
      myResponse: null,
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      busy: true,
      private: false,
      seriesId: null,
      webUrl: null,
      createdByCommander: null,
      ...extra,
    },
  };
}

const sync = (items: SourceItem[]) =>
  store.saveFromSource({ source: 'google-calendar', account: ACCOUNT, items });

describe('the meeting chips', () => {
  it('are filled after a sync and when today’s Daily Note is made, and the window hears of it', () => {
    const service = meetings();
    sync([event('sync', 'Weekly sync', at(10))]);
    service.refresh();
    expect(sent).toEqual([]);

    const note = store.ensureDailyNote('2026-10-03', { by: { kind: 'user' } }, { fromTemplate: true });
    const chipIds = service.refresh();
    expect(chipIds).toHaveLength(1);
    expect(sent).toEqual([
      { type: 'items-changed', itemIds: chipIds },
      { type: 'meeting-chips', dailyNoteId: note.id },
    ]);
    sent = [];
    service.refresh();
    expect(sent).toEqual([]);
  });
});

describe('the heads-up', () => {
  it('is off by default', () => {
    expect(store.calendarSettings.read()).toEqual({ headsUp: false });
    sync([event('sync', 'Weekly sync', at(10))]);
    clock = at(9, 58, 30);
    meetings().tick();
    expect(sent).toEqual([]);
  });

  it('when on, comes 2 minutes before a meeting, once, with its title and time', () => {
    store.calendarSettings.save({ headsUp: true });
    sync([event('sync', 'Weekly sync', at(10)), event('later', 'Design review', at(14))]);
    const service = meetings();
    clock = at(9, 57, 50);
    service.tick();
    expect(sent).toEqual([]);

    clock = at(9, 58);
    service.tick();
    clock = at(9, 58, 10);
    service.tick();
    const id = store.query({ kinds: ['event'] }).find((item) => item.title === 'Weekly sync')?.id;
    expect(sent).toEqual([
      { type: 'meeting-heads-up', itemId: id, title: 'Weekly sync', times: '10:00–10:30', startsAt: at(10) },
    ]);
  });

  it('a meeting moved later gets its heads-up at its new time', () => {
    store.calendarSettings.save({ headsUp: true });
    sync([event('sync', 'Weekly sync', at(10))]);
    const service = meetings();
    clock = at(9, 58, 30);
    service.tick();
    sync([event('sync', 'Weekly sync', at(11))]);
    clock = at(10, 58, 30);
    service.tick();
    expect(sent.map((message) => message.type === 'meeting-heads-up' && message.startsAt)).toEqual([
      at(10),
      at(11),
    ]);
  });

  it('skips meetings without a chip (declined, all-day, free) and those already started', () => {
    store.calendarSettings.save({ headsUp: true });
    sync([
      event('declined', 'Offsite', at(10), { myResponse: 'declined' }),
      event('free', 'Lunch walk', at(10), { busy: false }),
      event('started', 'Standup', at(9, 55)),
    ]);
    clock = at(9, 58, 30);
    meetings().tick();
    expect(sent).toEqual([]);
  });

  it('isn’t sent while the screen is locked or the User is away: no one would see it', () => {
    store.calendarSettings.save({ headsUp: true });
    sync([event('sync', 'Weekly sync', at(10))]);
    clock = at(9, 58, 30);
    presence = 'locked';
    meetings().tick();
    presence = 'away';
    meetings().tick();
    expect(sent).toEqual([]);
    presence = 'idle';
    meetings().tick();
    expect(sent).toHaveLength(1);
  });
});
