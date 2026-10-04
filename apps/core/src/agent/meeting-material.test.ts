import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, blockLinkToken, isEvent } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { gatherMeetingMaterial } from './meeting-material';
import {
  attendee,
  chipWithNotes,
  DANA,
  eventItem,
  itemOf,
  ME,
  PRIYA,
  syncEvents,
  syncIssues,
  writeBlock,
} from './testing/meeting-fixtures';

// Gathering what a meeting's prep rests on (#130) is code, not the model: on fixture Items in a real
// Item store, the attendees' open Items, the notes under earlier meetings' chips, the Items linked to
// the event, and the cap.

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-material-'));
  clock = at(5, 9);
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

function event(id: string) {
  const item = itemOf(store, id);
  if (!isEvent(item)) throw new Error('not an event');
  return item;
}

describe('the attendees’ open Items', () => {
  it('are those involving someone else in the meeting, still open, whatever their kind', () => {
    const [oneOnOne] = syncEvents(store, [eventItem('one', '1:1 with Priya', at(5, 15))]);
    const [priyas, done, mine, danas] = syncIssues(store, [
      { id: 'a', title: 'Audit log export', people: ['linear:u2', 'Priya@Acme.test'] },
      { id: 'b', title: 'Shipped already', people: [PRIYA], status: 'done' },
      { id: 'c', title: 'Only mine', people: [ME] },
      { id: 'd', title: 'Dana’s', people: [DANA] },
    ]);
    const material = gatherMeetingMaterial(store, event(oneOnOne as string));
    const ids = material.items.map((item) => item.id);
    expect(ids).toContain(priyas);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(mine);
    expect(ids).not.toContain(danas);
    // Other events (the meeting itself among them) aren't Items involving them.
    expect(material.items.every((item) => item.kind !== 'event')).toBe(true);
    expect(material.people.map((person) => person.email)).toEqual([PRIYA]);
  });
});

describe('earlier meetings’ notes', () => {
  it('are the notes under the chips of earlier meetings in the same series, newest first', () => {
    const [first, second, third, today] = syncEvents(store, [
      eventItem('w1', 'Weekly with Priya', at(1, 15), { seriesId: 'weekly' }),
      eventItem('w2', 'Weekly with Priya', at(2, 15), { seriesId: 'weekly' }),
      eventItem('w3', 'Weekly with Priya', at(3, 15), { seriesId: 'weekly' }),
      eventItem('w5', 'Weekly with Priya', at(5, 15), { seriesId: 'weekly' }),
    ]);
    chipWithNotes(store, '2026-10-01', first as string, ['Agreed the launch date']);
    const secondChip = chipWithNotes(store, '2026-10-02', second as string, ['Priya owns the checklist']);
    // The last one's chip has nothing under it: skipped.
    chipWithNotes(store, '2026-10-03', third as string, []);
    // Notes nest: a note under a note comes too.
    const parent = writeBlock(store, '2026-10-02', 'Risks', secondChip);
    writeBlock(store, '2026-10-02', 'Vendor contract late', parent);

    const { earlier } = gatherMeetingMaterial(store, event(today as string));
    expect(earlier.map((meeting) => [meeting.day, meeting.lines.map((line) => line.text)])).toEqual([
      ['2026-10-02', ['Priya owns the checklist', 'Risks', 'Vendor contract late']],
      ['2026-10-01', ['Agreed the launch date']],
    ]);
    expect(earlier[0]?.lines.map((line) => line.depth)).toEqual([0, 0, 1]);
    expect(earlier[0]?.chip.id).toBe(secondChip);
  });

  it('are otherwise the last meeting with the same people', () => {
    const [withPriya, withBoth, today] = syncEvents(store, [
      eventItem('p', 'Catch-up', at(1, 10)),
      eventItem('b', 'Planning', at(2, 10), {
        attendees: [attendee(ME, { organiser: true }), attendee(PRIYA), attendee(DANA)],
      }),
      eventItem('t', '1:1 with Priya', at(5, 15)),
    ]);
    chipWithNotes(store, '2026-10-01', withPriya as string, ['Talked about the offsite']);
    chipWithNotes(store, '2026-10-02', withBoth as string, ['Dana joined']);
    const { earlier } = gatherMeetingMaterial(store, event(today as string));
    expect(earlier.map((meeting) => meeting.lines.map((line) => line.text))).toEqual([
      ['Talked about the offsite'],
    ]);
  });
});

describe('the event’s own material', () => {
  it('takes the Items linked to the event, but not its chip or Ares’s prep', () => {
    const [meeting] = syncEvents(store, [eventItem('m', 'Launch review', at(5, 15))]);
    const chip = chipWithNotes(store, '2026-10-05', meeting as string, []);
    const mention = writeBlock(
      store,
      '2026-10-04',
      `Prepare slides for ${blockLinkToken({ type: 'event', eventId: meeting as string })}`,
    );
    const todo = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Read the deck',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      user,
    ).itemId;
    store.link({ from: todo, linkType: 'made-from', to: meeting as string }, user);
    const ids = gatherMeetingMaterial(store, event(meeting as string)).items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([mention, todo]));
    expect(ids).not.toContain(chip);
  });
});

describe('the cap', () => {
  it('keeps the newest 40 Items', () => {
    const [meeting] = syncEvents(store, [eventItem('m', '1:1 with Priya', at(5, 15))]);
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      clock += 60_000;
      ids.push(...syncIssues(store, [{ id: `i${i}`, title: `Issue ${i}`, people: [PRIYA] }]));
    }
    const material = gatherMeetingMaterial(store, event(meeting as string));
    expect(material.items).toHaveLength(40);
    expect(material.items.map((item) => item.id)).toEqual(ids.slice(5).reverse());
  });
});
