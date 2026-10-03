import type { ItemStore } from '@commander/core/src/item-store';
import type { ActivityEntry } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from './test-item-store';
import { describeEntry, type Todos, todosIn } from './todos';

// The Todos module against a real Item store on a temporary database.
let store: ItemStore;
let todos: Todos;
let close: (() => void) | undefined;

function reopen(now?: () => number) {
  close?.();
  const opened = openTestItemStore(now);
  todos = todosIn(opened.client);
  return opened;
}

beforeEach(() => {
  ({ store, close } = reopen());
});

afterEach(() => {
  close?.();
  close = undefined;
});

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
  it('lists open Todos in the order they were added, then ticked ones newest first, and skips other Items', async () => {
    let clock = 1000;
    ({ store, close } = reopen(() => clock++));
    const first = await todos.add('First');
    await todos.add('Second');
    const third = await todos.add('Third');
    await todos.add('Fourth');
    store.record({ type: 'create', item: { kind: 'event', title: 'Not a Todo' } }, { by: { kind: 'user' } });
    await todos.setDone(third.itemId, true);
    await todos.setDone(first.itemId, true);

    expect((await todos.list()).map((todo) => [todo.title, todo.status])).toEqual([
      ['Second', 'open'],
      ['Fourth', 'open'],
      ['First', 'done'],
      ['Third', 'done'],
    ]);
  });

  it('leaves out deleted Todos', async () => {
    const { itemId } = await todos.add('Gone soon');
    await todos.add('Staying');

    await todos.remove(itemId);

    expect((await todos.list()).map((todo) => todo.title)).toEqual(['Staying']);
  });
});

describe('renaming a Todo', () => {
  it('saves the new title, trimmed, and undo restores the old one', async () => {
    const { itemId } = await todos.add('Book the dentist');

    const rename = await todos.rename(itemId, '  Book the dentist for Tuesday ');
    expect((await todos.list())[0]?.title).toBe('Book the dentist for Tuesday');

    await todos.undo(rename.id);
    expect((await todos.list())[0]?.title).toBe('Book the dentist');
  });

  it('refuses an empty title', async () => {
    const { itemId } = await todos.add('Book the dentist');

    await expect(todos.rename(itemId, '  ')).rejects.toThrow(/empty/);
    expect((await todos.list())[0]?.title).toBe('Book the dentist');
  });
});

describe('deleting a Todo', () => {
  it('takes it off the list, and undo brings it back with its history intact', async () => {
    const { itemId } = await todos.add('Renew passport');
    await todos.setDone(itemId, true);

    const deletion = await todos.remove(itemId);
    expect(await todos.list()).toEqual([]);

    await todos.undo(deletion.id);
    expect(await todos.list()).toMatchObject([{ id: itemId, status: 'done' }]);
    const history = await todos.history(itemId);
    expect(history.map((entry) => describeEntry(entry, history))).toEqual([
      'Delete undone by you',
      'Deleted by you',
      'Ticked by you',
      'Added by you',
    ]);
  });
});

describe('a Todo’s Links', () => {
  it('lists Links from the Todo and backlinks to it, each with the Item at the other end', async () => {
    const { itemId } = await todos.add('Reply to Leo about the redlines');
    const {
      created: [emailId],
    } = store.saveFromSource({
      source: 'gmail',
      account: 'me@example.com',
      items: [{ externalId: 'm1', kind: 'email', title: 'Contract redlines, v3' }],
    });
    const later = await todos.add('Send the signed contract');
    const by = { kind: 'user' } as const;
    store.link({ from: itemId, linkType: 'made-from', to: emailId as string }, { by });
    store.link({ from: later.itemId, linkType: 'caused-by', to: itemId }, { by });

    expect(await todos.links(itemId)).toMatchObject([
      {
        type: 'made-from',
        backlink: false,
        other: { id: emailId, kind: 'email', title: 'Contract redlines, v3' },
      },
      { type: 'caused-by', backlink: true, other: { id: later.itemId, title: 'Send the signed contract' } },
    ]);
  });

  it('has none for a Todo that isn’t linked', async () => {
    const { itemId } = await todos.add('Water the plants');

    expect(await todos.links(itemId)).toEqual([]);
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
    [entry({ changes: [{ field: 'title', before: 'a', after: 'b' }] }), 'Title changed by you'],
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

  it('names a title change that was undone', () => {
    const renamed = entry({ id: 1, changes: [{ field: 'title', before: 'a', after: 'b' }] });
    const undo = entry({ id: 2, action: 'undo', undoes: 1 });

    expect(describeEntry(undo, [undo, renamed])).toBe('Title change undone by you');
  });
});
