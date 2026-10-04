import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { BLOCK_TIME_ACROSS_ACCOUNTS, type BusyCopying, setUpBusyCopies } from '.';

// Block time across Accounts (#131), on an injectable clock: with a pair switched on, each busy event in
// the first Account gets a private copy titled Busy on the second Account's main calendar, which moves
// and goes with it. Commander's own events are never copied, so copies never come back as copies.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 5, 7);
const PERSONAL = 'google:104512345678901234567';
const WORK = 'outlook:fake-tenant:sam';
const ALEX = 'alex@gmail.test';
const SAM_DEFAULT = 'AAMk-cal-default=';

let dir: string;
let store: ItemStore;
let gate: Gate;
let copying: BusyCopying;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-busy-copies-'));
  clock = NOW;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  store.calendars.listed(PERSONAL, 'google-calendar', [
    { id: ALEX, name: ALEX, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.calendars.listed(WORK, 'outlook-calendar', [
    { id: SAM_DEFAULT, name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
  ]);
  gate = openGate({ itemStore: store });
  copying = setUpBusyCopies({ store, gate, now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function event(id: string, title: string, start: number, extra: Partial<EventDetail> = {}): SourceItem {
  return {
    externalId: `${ALEX}/${id}`,
    kind: 'event',
    title,
    people: ['dana@example.test'],
    detail: {
      kind: 'event',
      calendar: { id: ALEX, name: ALEX, colour: '#9fe1e7' },
      accountEmail: ALEX,
      start: { at: start, timeZone: 'Europe/London', date: null },
      end: { at: start + HOUR, timeZone: 'Europe/London', date: null },
      allDay: false,
      location: 'High Street',
      description: 'Bring the forms',
      organiser: { email: 'dana@example.test', name: 'Dana', self: false },
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

const personal = (items: SourceItem[], deleted: string[] = []) =>
  store.saveFromSource({ source: 'google-calendar', account: PERSONAL, items, deleted });
const idOf = (externalId: string, account = PERSONAL) =>
  store.query({ account, includeDeleted: true }).find((item) => item.externalId === externalId)?.id as string;

function switchOn(from = PERSONAL, to = WORK) {
  const before = store.focusSettings.read();
  const after = store.focusSettings.save({
    ...before,
    blockPairs: [...before.blockPairs, { from, to, on: true }],
  });
  copying.settingsSaved(before, after);
}

const liveCopies = () =>
  store.busyCopies
    .list()
    .map((copy) => ({ ...copy, item: store.get(copy.copyId)?.item }))
    .filter((copy) => copy.item?.deletedAt === null);

describe('with a pair switched on', () => {
  it('sets the action to Auto in the Autonomy grid, where the User can change it', () => {
    expect(gate.actions()).toContainEqual(
      expect.objectContaining({ action: BLOCK_TIME_ACROSS_ACCOUNTS, actionKind: 'tidy-sources' }),
    );
    switchOn();
    expect(gate.settings().actions[BLOCK_TIME_ACROSS_ACCOUNTS]).toBe('auto');
  });

  it('copies a personal event to the work calendar as a private Busy with nothing else of it', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    switchOn();
    const dentist = idOf(`${ALEX}/dentist`);
    const [copy] = liveCopies();
    expect(copy).toMatchObject({ eventId: dentist, targetAccount: WORK });
    expect(copy?.item).toMatchObject({
      source: 'outlook-calendar',
      account: WORK,
      title: 'Busy',
      people: [],
    });
    expect(copy?.item?.detail).toMatchObject({
      calendar: { id: SAM_DEFAULT },
      start: { at: NOW + DAY },
      end: { at: NOW + DAY + HOUR },
      location: null,
      description: null,
      organiser: null,
      attendees: [],
      busy: true,
      private: true,
      createdByCommander: 'busy-block',
    });
    expect(store.outgoing.forItem(copy?.copyId as string)).toMatchObject([
      {
        field: 'create',
        account: WORK,
        value: { kind: 'busy-block', title: 'Busy', calendarId: SAM_DEFAULT },
      },
    ]);
    // Done by Ares, logged and undoable, as an automatic Tidy your Sources action.
    expect(gate.activity({ action: BLOCK_TIME_ACROSS_ACCOUNTS })).toMatchObject([
      { status: 'done', itemId: dentist, undoable: true },
    ]);
  });

  it('copies each event once, however often it runs', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    switchOn();
    copying.reconcile();
    copying.reconcile();
    expect(store.busyCopies.list()).toHaveLength(1);
    expect(gate.activity({ action: BLOCK_TIME_ACROSS_ACCOUNTS })).toHaveLength(1);
  });

  it('moves the copy when its event moves, and removes it when the event goes', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    switchOn();
    const [copy] = liveCopies();
    const copyId = copy?.copyId as string;

    personal([event('dentist', 'Dentist', NOW + DAY + 3 * HOUR)]);
    copying.reconcile();
    expect(store.get(copyId)?.item.detail).toMatchObject({
      start: { at: NOW + DAY + 3 * HOUR },
      end: { at: NOW + DAY + 4 * HOUR },
    });
    expect(store.outgoing.forItem(copyId).map((row) => row.field)).toEqual(['create', 'time']);

    personal([], [`${ALEX}/dentist`]);
    copying.reconcile();
    expect(store.get(copyId)?.item.deletedAt).not.toBeNull();
    expect(store.outgoing.forItem(copyId).map((row) => row.field)).toEqual(['create', 'time', 'delete']);
  });

  it('leaves out free and declined events, and removes the copy once the event is declined', () => {
    personal([
      event('lunch', 'Lunch', NOW + DAY, { busy: false }),
      event('offsite', 'Offsite', NOW + 2 * DAY, { myResponse: 'declined' }),
      event('review', 'Review', NOW + 3 * DAY, { myResponse: 'accepted' }),
    ]);
    switchOn();
    expect(liveCopies().map((copy) => copy.eventId)).toEqual([idOf(`${ALEX}/review`)]);
    personal([event('review', 'Review', NOW + 3 * DAY, { myResponse: 'declined' })]);
    copying.reconcile();
    expect(liveCopies()).toEqual([]);
  });

  it('copies only what is still to come, within the weeks ahead', () => {
    personal([
      event('yesterday', 'Yesterday', NOW - DAY),
      event('soon', 'Soon', NOW + 7 * DAY),
      event('next-year', 'Next year', NOW + 300 * DAY),
    ]);
    switchOn();
    expect(liveCopies().map((copy) => copy.eventId)).toEqual([idOf(`${ALEX}/soon`)]);
  });

  it('copies a meeting the User set up through Commander (#132), as it holds their time', () => {
    personal([event('call', 'Call with Leo', NOW + DAY, { createdByCommander: 'meeting' })]);
    switchOn();
    expect(liveCopies().map((copy) => copy.eventId)).toEqual([idOf(`${ALEX}/call`)]);
  });

  it('never copies a copy back, nor Commander’s own focus blocks', () => {
    personal([
      event('dentist', 'Dentist', NOW + DAY),
      event('focus', 'Focus: Fix the login bug', NOW + 2 * DAY, { createdByCommander: 'focus-block' }),
    ]);
    switchOn(PERSONAL, WORK);
    switchOn(WORK, PERSONAL);
    // The work calendar's next sync brings the copy (its marker lost on the way, even).
    const [copy] = liveCopies();
    store.saveFromSource({
      source: 'outlook-calendar',
      account: WORK,
      items: [
        {
          externalId: 'AAMk-evt-busy=',
          kind: 'event',
          title: 'Busy',
          detail: { ...(copy?.item?.detail as EventDetail), createdByCommander: null },
          commanderItemId: copy?.copyId,
        },
      ],
    });
    copying.reconcile();
    copying.reconcile();
    expect(liveCopies().map((each) => [each.eventId, each.targetAccount])).toEqual([
      [idOf(`${ALEX}/dentist`), WORK],
    ]);
  });

  it('removes the copies when the pair is switched off', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    switchOn();
    const before = store.focusSettings.read();
    const after = store.focusSettings.save({
      ...before,
      blockPairs: [{ from: PERSONAL, to: WORK, on: false }],
    });
    copying.settingsSaved(before, after);
    expect(liveCopies()).toEqual([]);
  });

  it('doesn’t put back a copy the User deleted in the work calendar', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    switchOn();
    const [copy] = liveCopies();
    store.saveFromSource({
      source: 'outlook-calendar',
      account: WORK,
      items: [
        {
          externalId: 'AAMk-evt-busy=',
          kind: 'event',
          title: 'Busy',
          detail: copy?.item?.detail as EventDetail,
          commanderItemId: copy?.copyId,
        },
      ],
    });
    store.saveFromSource({ source: 'outlook-calendar', account: WORK, deleted: ['AAMk-evt-busy='] });
    copying.reconcile();
    expect(liveCopies()).toEqual([]);
    expect(store.busyCopies.list()).toHaveLength(1);
  });

  it('asks instead when the User sets the action to Ask, and doesn’t ask again once dismissed', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    switchOn();
    // The copy made at Auto is undone, and the User wants to be asked from now on.
    const [done] = gate.activity({ action: BLOCK_TIME_ACROSS_ACCOUNTS });
    gate.undo(done?.id as number);
    gate.setLevel({ scope: 'action', action: BLOCK_TIME_ACROSS_ACCOUNTS }, 'ask');
    personal([event('review', 'Review', NOW + 2 * DAY)]);
    copying.reconcile();
    const waiting = gate.activity({ action: BLOCK_TIME_ACROSS_ACCOUNTS, statuses: ['pending'] });
    expect(waiting.map((each) => each.itemId)).toEqual([idOf(`${ALEX}/review`)]);
    gate.dismiss(waiting[0]?.id as number);
    copying.reconcile();
    expect(gate.activity({ action: BLOCK_TIME_ACROSS_ACCOUNTS, statuses: ['pending'] })).toEqual([]);
    // The undone copy isn't made again either.
    expect(liveCopies()).toEqual([]);
  });

  it('does nothing with no pairs switched on', () => {
    personal([event('dentist', 'Dentist', NOW + DAY)]);
    copying.reconcile();
    expect(store.busyCopies.list()).toEqual([]);
  });
});
