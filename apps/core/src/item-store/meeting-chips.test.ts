import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, BlockDetail, EventDetail, Item, Project, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Meeting chips (#128) through the Item store, with seeded events: today's Daily Note gets one chip
// per meeting under its Meetings Block, in time order, kept in step with the calendar as it syncs,
// never twice, never on past days, and never at the cost of the notes written under one.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACCOUNT = 'google:104512345678901234567';
const PRIMARY = 'alex@gmail.test';
const user: ActionContext = { by: { kind: 'user' } };
const asToday = { fromTemplate: true };
// Local times on Saturday 3 October 2026 (and the days around it), as the User's clock reads them.
const at = (hour: number, minute = 0, date = 3) => new Date(2026, 9, date, hour, minute).getTime();
const TODAY = '2026-10-03';

let dir: string;
let store: ItemStore;
let now = at(8);

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => now,
  });
}

beforeEach(() => {
  now = at(8);
  dir = mkdtempSync(join(tmpdir(), 'commander-meeting-chips-'));
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function event(id: string, title: string, start: number, minutes = 30, extra: Partial<EventDetail> = {}) {
  const detail: EventDetail = {
    kind: 'event',
    calendar: { id: PRIMARY, name: PRIMARY, colour: '#9fe1e7' },
    accountEmail: PRIMARY,
    start: { at: start, timeZone: 'Europe/London', date: null },
    end: { at: start + minutes * 60_000, timeZone: 'Europe/London', date: null },
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
    webUrl: null,
    createdByCommander: null,
    ...extra,
  };
  return { externalId: id, kind: 'event', title, people: [PRIMARY], detail } satisfies SourceItem;
}

const sync = (items: SourceItem[], deleted: string[] = []) =>
  store.saveFromSource({ source: 'google-calendar', account: ACCOUNT, items, deleted });

const eventItem = (externalId: string) =>
  store
    .query({ kinds: ['event'], includeDeleted: true })
    .find((item) => item.externalId === externalId) as Item;

function detailOf(item: Item | undefined): BlockDetail {
  if (item?.detail?.kind !== 'block') throw new Error('Not a Block');
  return item.detail;
}

const noteOf = (day: string) => store.dailyNotes({ from: day, to: day }).notes[0]?.item;

// A Daily Note's Blocks as indented lines, with each meeting chip written as `chip:<event title>`.
function outline(day: string): string[] {
  const note = noteOf(day);
  if (!note) return [];
  const blocks = store.blocks([note.id]);
  const events = new Map(store.query({ kinds: ['event'], includeDeleted: true }).map((e) => [e.id, e]));
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const block of blocks.filter((b) => detailOf(b).parentId === parentId)) {
      const text = detailOf(block).text.replace(
        /\[\[event:([^\]]+)\]\]/g,
        (_, id: string) => `chip:${events.get(id)?.title ?? id}`,
      );
      lines.push(`${'  '.repeat(depth)}${text}`);
      walk(block.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

const chipOf = (day: string, title: string) => {
  const note = noteOf(day);
  const id = eventItem(
    store.query({ kinds: ['event'], includeDeleted: true }).find((e) => e.title === title)?.externalId ?? '',
  )?.id;
  return store.blocks(note ? [note.id] : []).find((block) => detailOf(block).text === `[[event:${id}]]`);
};

// Writes a Block under another, as the Notes Section would.
function writeUnder(parent: Item, text: string): Item {
  const { dailyNoteId } = detailOf(parent);
  const entry = store.record(
    {
      type: 'create',
      item: {
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId, parentId: parent.id, position: 'a0', text, folded: false },
      },
    },
    user,
  );
  return store.get(entry.itemId)?.item as Item;
}

function project(name: string, code: string): Project {
  return store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project as Project;
}

const MEETINGS_DAY = [
  event('sync', 'Weekly sync with Priya', at(10)),
  event('standup', 'Standup', at(9), 15),
  event('declined', 'Offsite planning', at(11), 60, { myResponse: 'declined' }),
  event('holiday', 'Bank holiday', at(0), 24 * 60, { allDay: true }),
  event('free', 'Lunch walk', at(12), 30, { busy: false }),
  event('tomorrow', 'Dentist', at(10, 0, 4)),
];

describe('meeting chips in today’s Daily Note', () => {
  it('one chip per meeting under Meetings, in time order; none for declined, all-day or free events', () => {
    sync(MEETINGS_DAY);
    store.ensureDailyNote(TODAY, user, asToday);
    const change = store.meetingChips.fill();

    expect(outline(TODAY)).toEqual([
      'Morning',
      'Meetings',
      '  chip:Standup',
      '  chip:Weekly sync with Priya',
      'Todos',
      'Ideas',
      'Evening',
    ]);
    expect(change.dailyNoteId).toBe(noteOf(TODAY)?.id);
    expect(change.itemIds).toHaveLength(2);
    // Each chip is joined to its event by a refers-to Link: the event is "mentioned in" today's note.
    const chip = chipOf(TODAY, 'Standup') as Item;
    expect(store.backlinks({ targetType: 'item', id: eventItem('standup').id })).toEqual([
      expect.objectContaining({ type: 'refers-to', from: expect.objectContaining({ id: chip.id }) }),
    ]);
    expect(store.activity({ itemId: chip.id }).at(-1)).toMatchObject({
      action: 'create',
      by: { kind: 'source', source: 'google-calendar', account: ACCOUNT },
      why: 'Today’s meeting from the calendar',
    });
  });

  it('takes Outlook Calendar’s events alike, in one time order with Google’s', () => {
    sync([event('sync', 'Weekly sync with Priya', at(10))]);
    store.saveFromSource({
      source: 'outlook-calendar',
      account: 'outlook:dana',
      items: [event('AAMk-standup', 'Titanlink standup', at(9), 15)],
    });
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    expect(outline(TODAY).filter((line) => line.includes('chip:'))).toEqual([
      '  chip:Titanlink standup',
      '  chip:Weekly sync with Priya',
    ]);
    expect(store.activity({ itemId: (chipOf(TODAY, 'Titanlink standup') as Item).id }).at(-1)?.by).toEqual({
      kind: 'source',
      source: 'outlook-calendar',
      account: 'outlook:dana',
    });
  });

  it('adds nothing while there is no Daily Note for today: it never makes one', () => {
    sync(MEETINGS_DAY);
    expect(store.meetingChips.fill()).toEqual({ dailyNoteId: null, itemIds: [] });
    expect(noteOf(TODAY)).toBeUndefined();
  });

  it('adds nothing without a top-level Meetings Block (the User deleted it)', () => {
    sync(MEETINGS_DAY);
    const note = store.ensureDailyNote(TODAY, user, asToday);
    const meetings = store.blocks([note.id]).find((block) => detailOf(block).text === 'Meetings') as Item;
    store.record({ type: 'delete', itemId: meetings.id }, user);
    expect(store.meetingChips.fill().itemIds).toEqual([]);
    expect(outline(TODAY)).toEqual(['Morning', 'Todos', 'Ideas', 'Evening']);
  });

  it('finds a Meetings Block written as a heading, with a Project’s code', () => {
    const lt = project('Longtail', 'LT');
    store.saveDailyTemplate({
      blocks: [{ id: 't-m', parentId: null, position: 'a0', text: '## Meetings #LT', folded: false }],
    });
    sync([event('standup', 'Standup', at(9), 15)]);
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    expect(outline(TODAY)).toEqual(['## Meetings #LT', '  chip:Standup']);
    // The event is Unfiled, so its chip takes the Meetings Block's Project.
    expect(chipOf(TODAY, 'Standup')?.filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
  });
});

describe('only today, only once', () => {
  it('re-opening, restarting and re-syncing never add a chip twice', () => {
    sync(MEETINGS_DAY);
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    const once = outline(TODAY);

    expect(store.meetingChips.fill().itemIds).toEqual([]);
    store.ensureDailyNote(TODAY, user, asToday);
    sync(MEETINGS_DAY);
    store.close();
    store = open();
    sync(MEETINGS_DAY);
    expect(store.meetingChips.fill().itemIds).toEqual([]);
    expect(outline(TODAY)).toEqual(once);
  });

  it('a chip the User deleted stays deleted', () => {
    sync(MEETINGS_DAY);
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    store.record({ type: 'delete', itemId: (chipOf(TODAY, 'Standup') as Item).id }, user);
    store.meetingChips.fill();
    expect(outline(TODAY)).toContain('  chip:Weekly sync with Priya');
    expect(outline(TODAY)).not.toContain('  chip:Standup');
  });

  it('past days never gain chips, even when the calendar changes', () => {
    now = at(8, 0, 2);
    store.ensureDailyNote('2026-10-02', user, asToday);
    now = at(8);
    store.ensureDailyNote(TODAY, user, asToday);
    sync([event('friday', 'Friday review', at(15, 0, 2)), event('standup', 'Standup', at(9), 15)]);
    store.meetingChips.fill();
    expect(outline('2026-10-02')).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
    expect(outline(TODAY)).toContain('  chip:Standup');
  });

  it('takes a meeting the User linked under Meetings themselves as its chip', () => {
    sync([event('standup', 'Standup', at(9), 15)]);
    const note = store.ensureDailyNote(TODAY, user, asToday);
    const meetings = store.blocks([note.id]).find((block) => detailOf(block).text === 'Meetings') as Item;
    writeUnder(meetings, `[[event:${eventItem('standup').id}]] agenda`);
    store.meetingChips.fill();
    expect(outline(TODAY).filter((line) => line.includes('chip:'))).toEqual(['  chip:Standup agenda']);
  });
});

describe('chips keep up with the calendar', () => {
  beforeEach(() => {
    sync(MEETINGS_DAY);
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
  });

  const chips = () => outline(TODAY).filter((line) => line.startsWith('  chip:'));

  it('an event added later in the day gets a chip on the next sync, in its place', () => {
    sync([event('review', 'Design review', at(9, 30))]);
    store.meetingChips.fill();
    expect(chips()).toEqual(['  chip:Standup', '  chip:Design review', '  chip:Weekly sync with Priya']);
  });

  it('a moved event re-sorts', () => {
    sync([event('standup', 'Standup', at(16), 15)]);
    store.meetingChips.fill();
    expect(chips()).toEqual(['  chip:Weekly sync with Priya', '  chip:Standup']);
  });

  it('a cancelled event’s chip goes if nothing is under it, and stays (with the notes) if something is', () => {
    const sync1 = chipOf(TODAY, 'Weekly sync with Priya') as Item;
    writeUnder(sync1, 'Priya owns the launch checklist');
    sync([], ['sync', 'standup']);
    store.meetingChips.fill();
    expect(outline(TODAY).slice(1, 4)).toEqual([
      'Meetings',
      '  chip:Weekly sync with Priya',
      '    Priya owns the launch checklist',
    ]);
    expect(chips()).toEqual(['  chip:Weekly sync with Priya']);
  });

  it('a declined event’s chip goes the same way', () => {
    writeUnder(chipOf(TODAY, 'Standup') as Item, 'Blocked on review');
    sync([
      event('standup', 'Standup', at(9), 15, { myResponse: 'declined' }),
      event('sync', 'Weekly sync with Priya', at(10), 30, { myResponse: 'declined' }),
    ]);
    store.meetingChips.fill();
    expect(chips()).toEqual(['  chip:Standup']);
  });

  it('an event moved to another day takes its chip with it, unless notes are under it', () => {
    writeUnder(chipOf(TODAY, 'Weekly sync with Priya') as Item, 'Agenda: launch');
    sync([
      event('standup', 'Standup', at(9, 0, 8), 15),
      event('sync', 'Weekly sync with Priya', at(10, 0, 8)),
    ]);
    store.meetingChips.fill();
    expect(chips()).toEqual(['  chip:Weekly sync with Priya']);
    // Moved back to today, the standup gets a chip again.
    sync([event('standup', 'Standup', at(9), 15)]);
    store.meetingChips.fill();
    expect(chips()).toEqual(['  chip:Standup', '  chip:Weekly sync with Priya']);
  });

  it('removes a chip with only empty Blocks under it', () => {
    const standup = chipOf(TODAY, 'Standup') as Item;
    writeUnder(standup, '');
    sync([], ['standup']);
    const change = store.meetingChips.fill();
    expect(chips()).toEqual(['  chip:Weekly sync with Priya']);
    expect(change.itemIds).toContain(standup.id);
  });
});

describe('chips and Projects', () => {
  it('a chip takes its event’s Project, and the notes under it inherit it', () => {
    const tl = project('Titanlink', 'TL');
    sync([event('sync', 'Weekly sync with Priya', at(10))]);
    store.record(
      {
        type: 'update',
        itemId: eventItem('sync').id,
        changes: { filing: { projectId: tl.id, filedBy: 'user' } },
      },
      user,
    );
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    const chip = chipOf(TODAY, 'Weekly sync with Priya') as Item;
    expect(chip.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });
    const note = writeUnder(chip, 'Priya owns the launch checklist');
    expect(note.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });
  });

  it('follows its event when the event is re-filed (by the User or a Rule), with the notes under it', () => {
    const tl = project('Titanlink', 'TL');
    const lt = project('Longtail', 'LT');
    sync([event('sync', 'Weekly sync with Priya', at(10))]);
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    const chip = chipOf(TODAY, 'Weekly sync with Priya') as Item;
    const note = writeUnder(chip, 'Priya owns the launch checklist');

    const filing = { projectId: tl.id, filedBy: 'user' as const };
    store.record({ type: 'update', itemId: eventItem('sync').id, changes: { filing } }, user);
    expect(store.get(chip.id)?.item.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });
    expect(store.get(note.id)?.item.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });

    store.record({ type: 'update', itemId: eventItem('sync').id, changes: { filing: null } }, user);
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: lt.id },
        when: {
          join: 'and',
          terms: [{ field: 'google-calendar.title', op: 'contains', value: 'sync', label: 'sync' }],
        },
      },
    });
    store.refile([eventItem('sync').id]);
    expect(store.get(chip.id)?.item.filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
    expect(store.get(note.id)?.item.filing).toEqual({ projectId: lt.id, filedBy: 'inherited' });
  });

  it('tagging the chip files it and the notes under it, and it stays when the event is re-filed', () => {
    const tl = project('Titanlink', 'TL');
    const lt = project('Longtail', 'LT');
    sync([event('sync', 'Weekly sync with Priya', at(10))]);
    store.ensureDailyNote(TODAY, user, asToday);
    store.meetingChips.fill();
    const chip = chipOf(TODAY, 'Weekly sync with Priya') as Item;
    const note = writeUnder(chip, 'Priya owns the launch checklist');

    const text = `${detailOf(chip).text} #TL`;
    store.record(
      {
        type: 'update',
        itemId: chip.id,
        changes: {
          detail: { ...detailOf(chip), text },
          filing: { projectId: tl.id, filedBy: 'user' },
        },
      },
      user,
    );
    expect(store.get(note.id)?.item.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });

    const filing = { projectId: lt.id, filedBy: 'user' as const };
    store.record({ type: 'update', itemId: eventItem('sync').id, changes: { filing } }, user);
    expect(store.get(chip.id)?.item.filing).toEqual({ projectId: tl.id, filedBy: 'user' });
    expect(store.get(note.id)?.item.filing).toEqual({ projectId: tl.id, filedBy: 'inherited' });
  });
});
