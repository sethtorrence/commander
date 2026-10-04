import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, EventDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerItemStoreRequest } from '../item-store-requests';
import { type ItemStore, openItemStore } from '.';

// Answering invitations (#129) in the Item store: an answer is an `edit-fields` change to the synced
// field `response` (and `seriesResponse` for a whole series), shown at once, logged, undoable field by
// field and queued for the calendar Source in the same transaction; a sync keeps it on top until it
// reaches Google Calendar or Outlook.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACCOUNT = 'google:alex';
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-invitations-'));
  clock = Date.UTC(2026, 9, 5, 8);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base: EventDetail = {
  kind: 'event',
  calendar: { id: 'alex@gmail.test', name: 'alex@gmail.test', colour: '#9fe1e7' },
  accountEmail: 'alex@gmail.test',
  start: { at: Date.UTC(2026, 9, 8, 14), timeZone: 'Europe/London', date: null },
  end: { at: Date.UTC(2026, 9, 8, 15), timeZone: 'Europe/London', date: null },
  allDay: false,
  location: null,
  description: null,
  organiser: { email: 'dana@acme.test', name: 'Dana Reyes', self: false },
  attendees: [
    {
      email: 'alex@gmail.test',
      name: null,
      self: true,
      response: 'needs-action',
      organiser: false,
      optional: false,
      resource: false,
    },
  ],
  myResponse: 'needs-action',
  meetingUrl: null,
  busy: true,
  private: false,
  seriesId: null,
  webUrl: null,
  createdByCommander: null,
};

const event = (externalId: string, title: string, detail: Partial<EventDetail> = {}): SourceItem => ({
  externalId,
  kind: 'event',
  title,
  detail: { ...base, ...detail },
});

function sync(...items: SourceItem[]) {
  store.saveFromSource({ source: 'google-calendar', account: ACCOUNT, items });
  return items.map(
    (item) =>
      store.fromSource({ source: 'google-calendar', account: ACCOUNT }, [item.externalId])[0]?.id as string,
  );
}

const detailOf = (id: string) => store.get(id)?.item.detail as EventDetail;
const answer = (itemId: string, fields: Record<string, unknown>) =>
  store.record({ type: 'edit-fields', itemId, fields }, user);
const queued = () => store.outgoing.list().map(({ field, status, madeAt }) => ({ field, status, madeAt }));

describe('answering an invitation', () => {
  it('shows at once, and queues the answer for the Source in the same change', () => {
    const [pricing] = sync(event('alex@gmail.test/pricing', 'Pricing review'));
    const entry = answer(pricing as string, { response: 'accepted' });
    expect(detailOf(pricing as string).myResponse).toBe('accepted');
    expect(detailOf(pricing as string).attendees[0]?.response).toBe('accepted');
    expect(entry).toMatchObject({ by: { kind: 'user' }, action: 'update' });
    expect(queued()).toEqual([{ field: 'response', status: 'pending', madeAt: clock }]);
  });

  it('answers a whole series as its own field, beside the instance’s', () => {
    const [weekly] = sync(event('alex@gmail.test/weekly_20261008', 'Weekly', { seriesId: 'weekly' }));
    answer(weekly as string, { response: 'declined', seriesResponse: 'declined' });
    expect(detailOf(weekly as string)).toMatchObject({ myResponse: 'declined', seriesResponse: 'declined' });
    expect(queued().map((change) => change.field)).toEqual(['response', 'seriesResponse']);
  });

  it('refuses an answer to an event the User organised, or isn’t a guest of', () => {
    const [mine, holiday] = sync(
      event('alex@gmail.test/mine', 'Mine', {
        organiser: { email: 'alex@gmail.test', name: null, self: true },
        myResponse: 'accepted',
      }),
      event('alex@gmail.test/holiday', 'Holiday', { organiser: null, attendees: [], myResponse: null }),
    );
    expect(() => answer(mine as string, { response: 'declined' })).toThrow(/no fields that sync/);
    expect(() => answer(holiday as string, { response: 'declined' })).toThrow(/no fields that sync/);
    expect(() => answer(mine as string, { title: 'Hacked' })).toThrow();
    expect(queued()).toEqual([]);
  });

  it('refuses an answer that isn’t one', () => {
    const [pricing] = sync(event('alex@gmail.test/pricing', 'Pricing review'));
    expect(() => answer(pricing as string, { response: 'maybe-later' })).toThrow(/doesn.t fit/);
  });

  it('stays on top of a sync until it reaches the Source', () => {
    const [pricing] = sync(event('alex@gmail.test/pricing', 'Pricing review'));
    answer(pricing as string, { response: 'tentative' });
    clock += 1000;
    sync(event('alex@gmail.test/pricing', 'Pricing review (moved room)', { location: 'Room 2' }));
    expect(detailOf(pricing as string)).toMatchObject({ myResponse: 'tentative', location: 'Room 2' });
    // Google has it now: the change leaves the queue.
    sync(
      event('alex@gmail.test/pricing', 'Pricing review (moved room)', {
        myResponse: 'tentative',
        attendees: [{ ...(base.attendees[0] as EventDetail['attendees'][number]), response: 'tentative' }],
      }),
    );
    expect(queued()).toEqual([]);
  });

  it('undo takes a waiting answer back, and once sent, queues the previous answer', () => {
    const [pricing] = sync(event('alex@gmail.test/pricing', 'Pricing review'));
    const first = answer(pricing as string, { response: 'accepted' });
    store.record({ type: 'undo', entryId: first.id }, user);
    expect(detailOf(pricing as string).myResponse).toBe('needs-action');
    expect(queued()).toEqual([]);

    const second = answer(pricing as string, { response: 'declined' });
    // It reached Google (the sync engine settles it).
    store.outgoing.settle(store.outgoing.forItem(pricing as string).map((row) => row.id));
    clock += 1000;
    store.record({ type: 'undo', entryId: second.id }, user);
    expect(detailOf(pricing as string).myResponse).toBe('needs-action');
    expect(store.outgoing.forItem(pricing as string)).toMatchObject([
      { field: 'response', value: 'needs-action', synced: 'declined', madeAt: clock },
    ]);
  });

  it('undoing a series answer after a sync still answers the series again', () => {
    const [weekly] = sync(event('alex@gmail.test/weekly_20261008', 'Weekly', { seriesId: 'weekly' }));
    const entry = answer(weekly as string, { response: 'accepted', seriesResponse: 'accepted' });
    store.outgoing.settle(store.outgoing.forItem(weekly as string).map((row) => row.id));
    // The sync after the write brings Google's answer, for the instance and so the series.
    sync(
      event('alex@gmail.test/weekly_20261008', 'Weekly', {
        seriesId: 'weekly',
        myResponse: 'accepted',
      }),
    );
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(store.outgoing.forItem(weekly as string).map(({ field, value }) => ({ field, value }))).toEqual([
      { field: 'response', value: 'needs-action' },
      { field: 'seriesResponse', value: 'needs-action' },
    ]);
  });
});

describe('the invitations awaiting an answer', () => {
  it('are the invitations still to come that the User hasn’t answered, for the Dashboard', () => {
    const [pricing, answered, past, mine] = sync(
      event('alex@gmail.test/pricing', 'Pricing review'),
      event('alex@gmail.test/answered', 'Answered', { myResponse: 'accepted' }),
      event('alex@gmail.test/past', 'Past', {
        start: { at: Date.UTC(2026, 9, 1, 14), timeZone: null, date: null },
        end: { at: Date.UTC(2026, 9, 1, 15), timeZone: null, date: null },
      }),
      event('alex@gmail.test/mine', 'Mine', {
        organiser: { email: 'alex@gmail.test', name: null, self: true },
        myResponse: 'accepted',
      }),
    );
    expect([answered, past, mine]).toHaveLength(3);
    const reply = answerItemStoreRequest(store, {
      type: 'item-store-request',
      id: 1,
      request: { op: 'invitations' },
    });
    const result = reply?.response.ok ? (reply.response.result as { id: string }[]) : null;
    expect(result?.map((item) => item.id)).toEqual([pricing]);
  });
});
