import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, LinearIssueDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Two-way sync's side of the Item store: a change made in Commander to a Source Item's synced fields
// shows at once, is logged and undoable, and is queued for the Source in the same transaction, field
// by field; syncs keep queued changes on top; undo goes back field by field.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ACME = 'linear:org-acme';
const user: ActionContext = { by: { kind: 'user' } };
const priya = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const sam = { id: 'user-sam', name: 'Sam Rivera', displayName: 'sam', email: null };
const bug = { id: 'label-bug', name: 'Bug', color: '#eb5757' };
const customer = { id: 'label-customer', name: 'Customer', color: '#5e6ad2' };
const progress = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const done = { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' };

let dir: string;
let store: ItemStore;
let clock: number;

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-outgoing-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base: LinearIssueDetail = {
  kind: 'linear-issue',
  identifier: 'ENG-418',
  url: 'https://linear.app/acme/issue/ENG-418',
  team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
  state: progress,
  priority: 2,
  assignee: priya,
  creator: null,
  labels: [bug],
  cycle: null,
  linearProject: null,
  dueDate: null,
  estimate: 3,
  description: 'The login page loops.',
  comments: [],
  createdAt: Date.UTC(2026, 8, 29),
  updatedAt: Date.UTC(2026, 9, 1),
  startedAt: null,
  completedAt: null,
  canceledAt: null,
};

const issue = (detail: Partial<LinearIssueDetail> = {}): SourceItem => ({
  externalId: 'issue-418',
  kind: 'linear-issue',
  title: 'Fix the login loop',
  detail: { ...base, ...detail },
});

function sync(detail: Partial<LinearIssueDetail> = {}) {
  return store.saveFromSource({ source: 'linear', account: ACME, items: [issue(detail)] });
}

function saved() {
  const [found] = store.query({ kinds: ['linear-issue'] });
  if (!found) throw new Error('No issue saved');
  return found;
}

const detailOf = () => saved().detail as LinearIssueDetail;
const edit = (fields: Record<string, unknown>) =>
  store.record({ type: 'edit-fields', itemId: saved().id, fields }, user);
const queued = () =>
  store.outgoing.forItem(saved().id).map(({ field, value, synced, madeAt, status }) => ({
    field,
    value,
    synced,
    madeAt,
    status,
  }));

describe('a change made in Commander', () => {
  beforeEach(() => sync());

  it('shows at once, is the User’s in the activity log, and is queued with the time it was made', () => {
    const entry = edit({ priority: 1 });

    expect(detailOf()).toMatchObject({ priority: 1, estimate: 3, labels: [bug] });
    expect(entry).toMatchObject({ by: { kind: 'user' }, action: 'update' });
    expect(queued()).toEqual([
      { field: 'priority', value: 1, synced: 2, madeAt: Date.UTC(2026, 9, 3, 9), status: 'pending' },
    ]);
    expect(store.outgoing.list()).toEqual([
      expect.objectContaining({ itemId: saved().id, account: ACME, source: 'linear', field: 'priority' }),
    ]);
  });

  it('queues each field on its own, labels one by one and a new comment by its id', () => {
    const comment = { id: 'c-new', author: sam, body: 'On it.', createdAt: clock, updatedAt: clock };
    edit({ 'label:label-customer': customer, 'label:label-bug': null, 'comment:c-new': comment });

    expect(detailOf().labels).toEqual([customer]);
    expect(detailOf().comments).toEqual([comment]);
    expect(queued().map(({ field, value }) => [field, value])).toEqual([
      ['label:label-bug', null],
      ['label:label-customer', customer],
      ['comment:c-new', comment],
    ]);
  });

  it('closes the Item when the state moves to a completed one', () => {
    edit({ state: done });
    expect(saved().status).toBe('done');
  });

  it('folds changes to one field together, and drops it when changed back to what the Source has', () => {
    edit({ priority: 1 });
    clock += 60_000;
    edit({ priority: 4 });
    expect(queued()).toEqual([
      expect.objectContaining({ field: 'priority', value: 4, synced: 2, madeAt: clock }),
    ]);

    edit({ priority: 2 });
    expect(queued()).toEqual([]);
  });

  it('refuses fields that don’t sync, values that don’t fit, and Items with no Source', () => {
    expect(() => edit({ description: 'Rewritten' })).toThrow(/Not a synced field/);
    expect(() => edit({ priority: 9 })).toThrow(/doesn't fit/);
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Mine' } }, user);
    expect(() =>
      store.record({ type: 'edit-fields', itemId: todo.itemId, fields: { priority: 1 } }, user),
    ).toThrow(/no fields that sync/);
    expect(store.outgoing.list()).toEqual([]);
  });

  it('is never queued when it came from the Source itself', () => {
    sync({ priority: 4 });
    expect(store.outgoing.list()).toEqual([]);
  });

  it('survives a restart', () => {
    edit({ estimate: 5 });
    store.close();
    store = open();
    expect(queued()).toEqual([expect.objectContaining({ field: 'estimate', value: 5, status: 'pending' })]);
  });
});

describe('syncs while changes are queued', () => {
  beforeEach(() => sync());

  it('keep the queued values on top, and note what the Source has as last synced', () => {
    edit({ priority: 1 });
    sync({ priority: 3, estimate: 8 });

    expect(detailOf()).toMatchObject({ priority: 1, estimate: 8 });
    expect(queued()).toEqual([expect.objectContaining({ field: 'priority', value: 1, synced: 3 })]);
  });

  it('drop a queued change the Source already has', () => {
    edit({ priority: 1 });
    sync({ priority: 1 });
    expect(queued()).toEqual([]);
  });

  it('record a note on the Source’s change when there is one to give', () => {
    store.saveFromSource({
      source: 'linear',
      account: ACME,
      items: [issue({ estimate: 13 })],
      why: 'Changed in Linear by Priya Patel at 14:02',
    });
    expect(store.activity({ itemId: saved().id })[0]).toMatchObject({
      by: { kind: 'source', source: 'linear', account: ACME },
      why: 'Changed in Linear by Priya Patel at 14:02',
    });
  });
});

describe('undo', () => {
  beforeEach(() => sync());

  it('of a change not yet sent restores it and takes it out of the queue', () => {
    const entry = edit({ priority: 1 });
    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(detailOf().priority).toBe(2);
    expect(queued()).toEqual([]);
  });

  it('of a change that reached the Source queues the change back, with the time of the undo', () => {
    const entry = edit({ priority: 1 });
    store.outgoing.settle(store.outgoing.forItem(saved().id).map((row) => row.id));
    sync({ priority: 1 });
    clock += 5 * 60_000;
    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(detailOf().priority).toBe(2);
    expect(queued()).toEqual([{ field: 'priority', value: 2, synced: 1, madeAt: clock, status: 'pending' }]);
  });

  it('restores only the fields it changed, so what the Source changed since stays', () => {
    const priyas = { id: 'c-priya', author: priya, body: 'Still loops.', createdAt: clock, updatedAt: clock };
    const mine = { id: 'c-mine', author: sam, body: 'Looking.', createdAt: clock, updatedAt: clock };
    const entry = edit({ 'comment:c-mine': mine, estimate: 5 });
    store.outgoing.settle(store.outgoing.forItem(saved().id).map((row) => row.id));
    sync({ comments: [mine, priyas], estimate: 5, priority: 3 });
    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(detailOf()).toMatchObject({ comments: [priyas], estimate: 3, priority: 3 });
    expect(queued().map(({ field, value }) => [field, value])).toEqual([
      ['estimate', 3],
      ['comment:c-mine', null],
    ]);
  });
});

describe('the queue', () => {
  beforeEach(() => sync());

  it('hands out what is due per Item, retries failed changes, and counts them per Account', () => {
    edit({ priority: 1 });
    const [ids] = store.outgoing.due(ACME, clock).map((group) => group.map((row) => row.id));
    store.outgoing.markSending(ids ?? []);
    expect(store.outgoing.counts(ACME)).toEqual({ pending: 1, failed: 0 });

    store.outgoing.fail(ids ?? [], { error: 'Linear refused it', failed: true, nextAttemptAt: null });
    expect(store.outgoing.counts(ACME)).toEqual({ pending: 0, failed: 1 });
    expect(store.outgoing.due(ACME, clock)).toEqual([]);

    expect(store.outgoing.retry(saved().id)).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 0, error: null }),
    ]);
    expect(store.outgoing.due(ACME, clock)).toHaveLength(1);
  });

  it('queues a new change to a field being sent after it, rather than into it', () => {
    edit({ priority: 1 });
    store.outgoing.markSending(store.outgoing.forItem(saved().id).map((row) => row.id));
    edit({ priority: 4 });

    expect(queued()).toEqual([
      expect.objectContaining({ value: 1, status: 'sending' }),
      expect.objectContaining({ value: 4, synced: 1, status: 'pending' }),
    ]);
  });

  it('tells listeners once the change is in', async () => {
    const heard: string[] = [];
    store.outgoing.onChange((account) => heard.push(account));
    edit({ priority: 1 });
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([ACME]);
  });
});
