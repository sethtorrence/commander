import type { ItemStore } from '@commander/core/src/item-store';
import type { ActivityEntry } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from './test-item-store';
import { describeEntry, type Todos, todosIn } from './todos';

// The Todos module against a real Item store on a temporary database.
let store: ItemStore;
let todos: Todos;
let close: () => void;

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close } = opened);
  todos = todosIn(opened.client);
});

afterEach(() => close());

describe('adding a Todo', () => {
  it('saves it as an Unfiled Todo Item of manual origin, added by the User', async () => {
    const entry = await todos.add('Book the dentist');

    expect(await todos.list()).toMatchObject([
      {
        id: entry.itemId,
        kind: 'todo',
        source: null,
        title: 'Book the dentist',
        status: 'open',
        filing: null,
        detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
      },
    ]);
    expect(entry).toMatchObject({ action: 'create', by: { kind: 'user' } });
  });

  it('trims the title and refuses an empty one', async () => {
    await todos.add('  Water the plants  ');

    await expect(todos.add('   ')).rejects.toThrow(/empty/);
    expect((await todos.list()).map((todo) => todo.title)).toEqual(['Water the plants']);
  });
});

describe('listing Todos', () => {
  it('lists them in the order they were added, ticked ones included, and skips other Items', async () => {
    const first = await todos.add('First');
    await todos.add('Second');
    store.record({ type: 'create', item: { kind: 'event', title: 'Not a Todo' } }, { by: { kind: 'user' } });
    await todos.setDone(first.itemId, true);

    expect((await todos.list()).map((todo) => [todo.title, todo.status])).toEqual([
      ['First', 'done'],
      ['Second', 'open'],
    ]);
  });
});

describe('ticking and undo', () => {
  it('ticks a Todo, and undoing the tick reopens it', async () => {
    const { itemId } = await todos.add('Renew passport');

    const tick = await todos.setDone(itemId, true);
    expect((await todos.list())[0]?.status).toBe('done');

    await todos.undo(tick.id);
    expect((await todos.list())[0]?.status).toBe('open');
  });

  it('keeps every change in the Todo’s history, newest first', async () => {
    const { itemId } = await todos.add('Renew passport');
    const tick = await todos.setDone(itemId, true);
    await todos.undo(tick.id);

    const history = await todos.history(itemId);

    expect(history.map((entry) => describeEntry(entry, history))).toEqual([
      'Tick undone by you',
      'Ticked by you',
      'Added by you',
    ]);
  });
});

describe('describing an activity entry', () => {
  const entry = (fields: Partial<ActivityEntry>): ActivityEntry => ({
    id: 1,
    at: 0,
    by: { kind: 'user' },
    action: 'update',
    itemId: 't',
    otherItemId: null,
    why: null,
    causedBy: null,
    undoes: null,
    changes: [],
    ...fields,
  });

  it.each([
    [entry({ action: 'create' }), 'Added by you'],
    [entry({ changes: [{ field: 'status', before: 'open', after: 'done' }] }), 'Ticked by you'],
    [entry({ changes: [{ field: 'status', before: 'done', after: 'open' }] }), 'Unticked by you'],
    [entry({ changes: [{ field: 'title', before: 'a', after: 'b' }] }), 'Renamed by you'],
    [entry({ action: 'delete', by: { kind: 'ares' } }), 'Deleted by Ares'],
    [entry({ by: { kind: 'rule', ruleId: 'r1' } }), 'Changed by a Rule'],
    [
      entry({ action: 'tombstone', by: { kind: 'source', source: 'linear', account: 'a' } }),
      'Deleted in Linear',
    ],
  ])('%#: %s', (activity, expected) => {
    expect(describeEntry(activity, [activity])).toBe(expected);
  });

  it('names what an undo reversed, when that entry is in the history', () => {
    const added = entry({ id: 1, action: 'create' });
    const undo = entry({ id: 2, action: 'undo', undoes: 1 });

    expect(describeEntry(undo, [undo, added])).toBe('Add undone by you');
    expect(describeEntry(undo, [undo])).toBe('Undone by you');
  });
});
