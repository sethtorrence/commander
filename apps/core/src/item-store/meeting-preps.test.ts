import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, MeetingPrepDetail } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Meeting preps in the Item store (#130): Ares's Items of kind meeting-prep, found by their event, and
// the people filter the prep's gathering asks for.

const ares: ActionContext = { by: { kind: 'ares' } };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-preps-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => 1_000,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const detail = (eventId: string, text: string): MeetingPrepDetail => ({
  kind: 'meeting-prep',
  eventId,
  revision: 'r1',
  preparedAt: 1_000,
  about: { text, sources: [eventId] },
  lastTime: [],
  open: [],
  raise: [],
});

function prep(eventId: string, text: string): string {
  return store.record(
    { type: 'create', item: { kind: 'meeting-prep', title: 'Prep: 1:1', detail: detail(eventId, text) } },
    ares,
  ).itemId;
}

describe('meeting preps', () => {
  it('keep their detail and are found by their event', () => {
    const id = prep('event-1', 'Launch review');
    prep('event-2', 'Hiring loop');
    const [found, ...others] = store.meetingPreps(['event-1']);
    expect(others).toEqual([]);
    expect(found?.id).toBe(id);
    expect(found?.detail).toEqual(detail('event-1', 'Launch review'));
    expect(store.meetingPreps([])).toEqual([]);
  });

  it('follow a change to their detail, and a deleted one is no longer found', () => {
    const id = prep('event-1', 'Launch review');
    store.record(
      { type: 'update', itemId: id, changes: { detail: detail('event-1', 'Moved to Thursday') } },
      ares,
    );
    expect(store.meetingPreps(['event-1'])[0]?.detail).toEqual(detail('event-1', 'Moved to Thursday'));
    store.record({ type: 'delete', itemId: id }, ares);
    expect(store.meetingPreps(['event-1'])).toEqual([]);
  });
});

describe('the people filter', () => {
  it('finds the Items involving any of the handles, whatever their case', () => {
    store.saveFromSource({
      source: 'linear',
      account: 'linear:1',
      items: [
        { externalId: 'a', kind: 'linear-issue', title: 'Priya’s', people: ['linear:u1', 'Priya@Acme.test'] },
        { externalId: 'b', kind: 'linear-issue', title: 'Dana’s', people: ['dana@acme.test'] },
        { externalId: 'c', kind: 'linear-issue', title: 'Nobody’s', people: [] },
      ],
    });
    const titles = (people: string[]) =>
      store
        .query({ people })
        .map((item) => item.title)
        .sort();
    expect(titles(['priya@acme.test'])).toEqual(['Priya’s']);
    expect(titles(['PRIYA@acme.test', 'dana@acme.test'])).toEqual(['Dana’s', 'Priya’s']);
    expect(titles(['sam@acme.test'])).toEqual([]);
  });
});
