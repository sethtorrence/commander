import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type CommanderEventDraft,
  DEFAULT_WORKING_HOURS,
  type EventDetail,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Events Commander writes (#131) in the Item store: a focus block or busy copy is an `event` Item made
// at once, under a placeholder external id, with its creation queued for the Source in the same
// transaction (ADR 0003, the create-row pattern of Send to Linear). The Source's answer, or a sync that
// gets there first, gives the same Item its real external id; moves and deletes queue as changes.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ALEX = 'google:104512345678901234567';
const SAM = 'outlook:fake-tenant:sam';
const PRIMARY = 'alex@gmail.test';
const SAM_DEFAULT = 'AAMk-cal-default=';
const COMMANDER_CAL = 'c_commander@group.calendar.google.com';
const ares: ActionContext = { by: { kind: 'ares' }, why: 'ENG-412 needs about 2 hours' };
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 5, 7);
const HOUR = 60 * 60_000;
const START = Date.UTC(2026, 9, 8, 8);

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-made-events-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => T,
  });
  store.calendars.listed(ALEX, 'google-calendar', [
    { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
  ]);
  store.calendars.listed(SAM, 'outlook-calendar', [
    { id: SAM_DEFAULT, name: 'Calendar', colour: '#0078d4', primary: true, accessRole: 'owner' },
  ]);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const time = (at: number) => ({ at, timeZone: 'Europe/London', date: null });

function focus(extra: Partial<CommanderEventDraft> = {}): CommanderEventDraft {
  return {
    kind: 'focus-block',
    account: ALEX,
    title: 'Focus: Fix the login bug',
    start: time(START),
    end: time(START + 2 * HOUR),
    ...extra,
  };
}

function detailOf(itemId: string): EventDetail {
  const detail = store.get(itemId)?.item.detail;
  if (detail?.kind !== 'event') throw new Error(`${itemId} is not an event`);
  return detail;
}

// The event as the Source answers it once made (or a sync reads it), naming Commander's Item.
function asTheSourceHasIt(itemId: string, externalId: string, extra: Partial<EventDetail> = {}): SourceItem {
  return {
    externalId,
    kind: 'event',
    title: store.get(itemId)?.item.title ?? '',
    people: [],
    detail: {
      ...detailOf(itemId),
      calendar: { id: COMMANDER_CAL, name: 'Commander', colour: '#7986cb' },
      webUrl: 'https://www.google.com/calendar/event?eid=abc',
      ...extra,
    },
    commanderItemId: itemId,
  };
}

describe('a focus block', () => {
  it('is an event Item at once: busy, private, marked as Commander’s, under a placeholder id', () => {
    const entry = store.createEvent(focus({ filing: null }), ares);
    const item = store.get(entry.itemId)?.item;
    expect(entry).toMatchObject({ action: 'create', by: { kind: 'ares' }, why: ares.why });
    expect(item).toMatchObject({
      kind: 'event',
      source: 'google-calendar',
      account: ALEX,
      externalId: `commander:${entry.itemId}`,
      title: 'Focus: Fix the login bug',
      status: 'open',
    });
    expect(detailOf(entry.itemId)).toMatchObject({
      calendar: { id: 'commander', name: 'Commander' },
      start: time(START),
      end: time(START + 2 * HOUR),
      allDay: false,
      busy: true,
      private: true,
      attendees: [],
      description: null,
      createdByCommander: 'focus-block',
    });
    // It shows in the Calendar Section straight away.
    expect(store.events({ from: START, to: START + HOUR }).map((each) => each.id)).toEqual([entry.itemId]);
  });

  it('queues its creation for the Commander calendar, to be found or made, in the same transaction', () => {
    const entry = store.createEvent(focus(), ares);
    expect(store.outgoing.forItem(entry.itemId)).toMatchObject([
      {
        field: 'create',
        account: ALEX,
        source: 'google-calendar',
        externalId: `commander:${entry.itemId}`,
        entryId: entry.id,
        value: {
          kind: 'focus-block',
          calendarId: null,
          commanderId: entry.itemId,
          title: 'Focus: Fix the login bug',
          start: time(START),
          end: time(START + 2 * HOUR),
          allDay: false,
        },
      },
    ]);
  });

  it('goes straight in the Commander calendar once Commander knows it', () => {
    store.calendars.listed(ALEX, 'google-calendar', [
      { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7', primary: true, accessRole: 'owner' },
      { id: COMMANDER_CAL, name: 'Commander', colour: '#7986cb', primary: false, accessRole: 'owner' },
    ]);
    const entry = store.createEvent(focus(), ares);
    expect(detailOf(entry.itemId).calendar).toEqual({
      id: COMMANDER_CAL,
      name: 'Commander',
      colour: '#7986cb',
    });
    expect(store.outgoing.forItem(entry.itemId)[0]?.value).toMatchObject({ calendarId: COMMANDER_CAL });
  });

  it('takes the Project it is given', () => {
    const project = store.changeProject({
      type: 'create',
      project: { name: 'Titanlink', code: 'TL', accent: 'blue' },
    });
    const projectId = project.project?.id as string;
    const entry = store.createEvent(focus({ filing: { projectId, filedBy: 'inherited' } }), ares);
    expect(store.get(entry.itemId)?.item.filing).toEqual({ projectId, filedBy: 'inherited' });
  });

  it('is refused in an Account Commander hasn’t seen calendars for, or when it ends before it starts', () => {
    expect(() => store.createEvent(focus({ account: 'google:nobody' }), ares)).toThrow(/calendars/);
    expect(() => store.createEvent(focus({ end: time(START - HOUR) }), ares)).toThrow(/ends/);
    expect(store.query({ kinds: ['event'] })).toEqual([]);
  });
});

describe('once the Source has it', () => {
  it('is the same Item under its real id, whether the Source’s answer or a sync brings it', () => {
    const entry = store.createEvent(focus(), ares);
    const externalId = `${COMMANDER_CAL}/${entry.itemId.replaceAll('-', '')}`;
    const saved = store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [asTheSourceHasIt(entry.itemId, externalId)],
    });
    expect(saved.created).toEqual([]);
    expect(saved.updated).toEqual([entry.itemId]);
    expect(store.get(entry.itemId)?.item.externalId).toBe(externalId);
    expect(detailOf(entry.itemId).calendar.id).toBe(COMMANDER_CAL);
    // Saving it again (the next sync) changes nothing.
    const again = store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [asTheSourceHasIt(entry.itemId, externalId)],
    });
    expect(again.unchanged).toEqual([entry.itemId]);
    expect(store.query({ kinds: ['event'] })).toHaveLength(1);
  });

  it('stays Commander’s even when the Source’s copy has lost the marker', () => {
    const entry = store.createEvent(focus(), ares);
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [asTheSourceHasIt(entry.itemId, `${COMMANDER_CAL}/x1`, { createdByCommander: null })],
    });
    expect(detailOf(entry.itemId).createdByCommander).toBe('focus-block');
  });

  it('moves changes still queued to the real id', () => {
    const entry = store.createEvent(focus(), ares);
    store.record({ type: 'undo', entryId: entry.id }, user);
    // A sync brought it before the deletion went: it stays deleted, and the deletion names it.
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [asTheSourceHasIt(entry.itemId, `${COMMANDER_CAL}/x2`)],
    });
    expect(store.get(entry.itemId)?.item.deletedAt).not.toBeNull();
    expect(store.outgoing.forItem(entry.itemId).map((row) => [row.field, row.externalId])).toEqual([
      ['create', `${COMMANDER_CAL}/x2`],
      ['delete', `${COMMANDER_CAL}/x2`],
    ]);
  });

  it('never takes over an Item of another Account, nor one already at its Source', () => {
    const entry = store.createEvent(focus(), ares);
    store.saveFromSource({
      source: 'google-calendar',
      account: 'google:someone-else',
      items: [asTheSourceHasIt(entry.itemId, `${COMMANDER_CAL}/x3`)],
    });
    expect(store.get(entry.itemId)?.item.externalId).toBe(`commander:${entry.itemId}`);
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [asTheSourceHasIt(entry.itemId, `${COMMANDER_CAL}/x4`)],
    });
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [asTheSourceHasIt(entry.itemId, `${COMMANDER_CAL}/x5`)],
    });
    expect(store.get(entry.itemId)?.item.externalId).toBe(`${COMMANDER_CAL}/x4`);
    expect(store.query({ kinds: ['event'], account: ALEX })).toHaveLength(2);
  });
});

describe('undo, moves and deletes', () => {
  it('undoing its creation deletes it and queues its deletion at the Source', () => {
    const entry = store.createEvent(focus(), ares);
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(store.get(entry.itemId)?.item.deletedAt).toBe(T);
    expect(store.outgoing.forItem(entry.itemId).map((row) => [row.field, row.value])).toEqual([
      ['create', expect.objectContaining({ kind: 'focus-block' })],
      ['delete', true],
    ]);
  });

  it('moving it changes its times and queues them together as `time`; undo moves it back', () => {
    const entry = store.createEvent(focus(), ares);
    const later = { start: time(START + 3 * HOUR), end: time(START + 4 * HOUR), allDay: false };
    const moved = store.moveEvent(entry.itemId, later, ares);
    expect(detailOf(entry.itemId)).toMatchObject({ start: later.start, end: later.end });
    const before = { start: time(START), end: time(START + 2 * HOUR), allDay: false };
    // The time it had is kept with the change (#206): what Discard puts it back to.
    expect(store.outgoing.forItem(entry.itemId).map((row) => [row.field, row.value, row.synced])).toEqual([
      ['create', expect.anything(), null],
      ['time', later, before],
    ]);
    store.record({ type: 'undo', entryId: moved.id }, user);
    expect(detailOf(entry.itemId)).toMatchObject({ start: time(START), end: time(START + 2 * HOUR) });
    // Moved back to the time it had before the change was sent: there is nothing to send.
    expect(store.outgoing.forItem(entry.itemId).map((row) => row.field)).toEqual(['create']);
  });

  it('moved again after a move was sent, it queues the new time; moved back there, nothing', () => {
    const entry = store.createEvent(focus(), ares);
    const [create] = store.outgoing.forItem(entry.itemId);
    store.outgoing.settle([create?.id as number]);
    const later = { start: time(START + 3 * HOUR), end: time(START + 4 * HOUR), allDay: false };
    store.moveEvent(entry.itemId, later, ares);
    const [move] = store.outgoing.forItem(entry.itemId);
    store.outgoing.markSending([move?.id as number], T);
    const latest = { start: time(START + 5 * HOUR), end: time(START + 6 * HOUR), allDay: false };
    store.moveEvent(entry.itemId, latest, ares);
    expect(store.outgoing.forItem(entry.itemId).map((row) => [row.status, row.value, row.synced])).toEqual([
      ['sending', later, expect.anything()],
      ['pending', latest, later],
    ]);
    store.moveEvent(entry.itemId, later, ares);
    expect(store.outgoing.forItem(entry.itemId).map((row) => row.status)).toEqual(['sending']);
  });

  it('deleting it queues its deletion at the Source', () => {
    const entry = store.createEvent(focus(), ares);
    store.record({ type: 'delete', itemId: entry.itemId }, ares);
    expect(store.outgoing.forItem(entry.itemId).at(-1)).toMatchObject({ field: 'delete', value: true });
  });

  it('moving or deleting an event Commander didn’t make is refused, or stays in Commander', () => {
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [
        {
          externalId: `${PRIMARY}/standup`,
          kind: 'event',
          title: 'Standup',
          detail: { ...detailOf(store.createEvent(focus(), ares).itemId), createdByCommander: null },
        },
      ],
    });
    const standup = store.query({ titleContains: 'Standup' })[0]?.id as string;
    expect(() =>
      store.moveEvent(standup, { start: time(START), end: time(START + HOUR), allDay: false }, ares),
    ).toThrow(/Commander/);
    store.record({ type: 'delete', itemId: standup }, user);
    expect(store.outgoing.forItem(standup)).toEqual([]);
  });
});

describe('a busy copy', () => {
  function work(): string {
    store.saveFromSource({
      source: 'google-calendar',
      account: ALEX,
      items: [
        {
          externalId: `${PRIMARY}/dentist`,
          kind: 'event',
          title: 'Dentist',
          people: [],
          detail: {
            kind: 'event',
            calendar: { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
            accountEmail: PRIMARY,
            start: time(START),
            end: time(START + HOUR),
            allDay: false,
            location: 'High Street',
            description: 'Bring the forms',
            organiser: null,
            attendees: [],
            myResponse: null,
            meetingUrl: null,
            busy: true,
            private: false,
            seriesId: null,
            webUrl: null,
            createdByCommander: null,
          },
        },
      ],
    });
    return store.query({ titleContains: 'Dentist' })[0]?.id as string;
  }

  it('goes on the other Account’s main calendar, titled Busy, with nothing of the event it copies', () => {
    const dentist = work();
    const entry = store.createEvent(
      {
        kind: 'busy-block',
        account: SAM,
        title: 'Dentist',
        start: time(START),
        end: time(START + HOUR),
        copyOf: dentist,
      },
      ares,
    );
    const copy = store.get(entry.itemId)?.item;
    expect(copy).toMatchObject({ source: 'outlook-calendar', account: SAM, title: 'Busy', people: [] });
    expect(detailOf(entry.itemId)).toMatchObject({
      calendar: { id: SAM_DEFAULT },
      location: null,
      description: null,
      busy: true,
      private: true,
      createdByCommander: 'busy-block',
    });
    expect(store.outgoing.forItem(entry.itemId)[0]?.value).toMatchObject({
      kind: 'busy-block',
      calendarId: SAM_DEFAULT,
      title: 'Busy',
    });
    expect(store.busyCopies.list()).toEqual([{ eventId: dentist, targetAccount: SAM, copyId: entry.itemId }]);
  });

  it('is made once per event and Account, and needs the event it copies', () => {
    const dentist = work();
    const draft: CommanderEventDraft = {
      kind: 'busy-block',
      account: SAM,
      title: 'Busy',
      start: time(START),
      end: time(START + HOUR),
      copyOf: dentist,
    };
    store.createEvent(draft, ares);
    expect(() => store.createEvent(draft, ares)).toThrow(/already/);
    expect(() => store.createEvent({ ...draft, copyOf: undefined }, ares)).toThrow(/copies/);
    expect(store.busyCopies.list()).toHaveLength(1);
  });
});

describe('focus settings', () => {
  it('start as Monday–Friday 09:00–18:00 with no Account chosen and no pairs, and keep what is saved', () => {
    expect(store.focusSettings.read()).toEqual({
      workingHours: DEFAULT_WORKING_HOURS,
      focusAccount: null,
      blockPairs: [],
    });
    const saved = store.focusSettings.save({
      workingHours: { days: [1, 2, 3, 4], start: '08:30', end: '16:00' },
      focusAccount: ALEX,
      blockPairs: [{ from: ALEX, to: SAM, on: true }],
    });
    expect(store.focusSettings.read()).toEqual(saved);
    expect(() =>
      store.focusSettings.save({ ...saved, workingHours: { days: [1], start: '17:00', end: '09:00' } }),
    ).toThrow();
  });
});
