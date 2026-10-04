import type { ItemStore } from '@commander/core/src/item-store';
import type { Item } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { type Todos, todosIn } from '../todos/todos';
import { dailyNotesIn } from './daily-notes';
import { createNotebook, type Notebook } from './notebook';
import { type Block, visibleBlocks } from './outline';

// `[]` turns a Block into a Todo: the Notes Section's Notebook and the Todos Section's module, side by
// side on one real Item store, as the two Sections share it in the window.

const TODAY = '2026-10-03';
let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let todos: Todos;
let errors: string[];
const notebooks: Notebook[] = [];

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
  // Today starts empty, without the daily template's Blocks.
  store.saveDailyTemplate({ blocks: [] });
  todos = todosIn(client);
  errors = [];
});

afterEach(async () => {
  for (const notebook of notebooks.splice(0)) await notebook.flush();
  close();
  expect(errors).toEqual([]);
});

async function open(): Promise<Notebook> {
  let n = 0;
  const prefix = notebooks.length;
  const notebook = createNotebook(dailyNotesIn(client), {
    today: TODAY,
    newId: () => `00000000-0000-4000-8000-${String(prefix * 1000 + ++n).padStart(12, '0')}`,
    onError: (message) => errors.push(message),
  });
  notebooks.push(notebook);
  await notebook.start();
  return notebook;
}

const blockIn = (notebook: Notebook, id: string): Block => {
  const block = notebook
    .snapshot()
    .days.find((d) => d.day === TODAY)
    ?.outline.get(id);
  if (!block) throw new Error(`No Block ${id}`);
  return block;
};

// Today's Blocks as lines: "[ ] text" for an open Todo, "[x] text" for a ticked one.
const lines = (notebook: Notebook) =>
  visibleBlocks(notebook.snapshot().days.find((d) => d.day === TODAY)?.outline ?? new Map()).map(
    ({ block }) => `${block.todo ? (block.todo.done ? '[x] ' : '[ ] ') : ''}${block.text}`,
  );

const liveTodos = () => store.query({ kinds: ['todo'] });
const onlyTodo = (): Item => {
  const [todo, ...more] = liveTodos();
  if (!todo || more.length) throw new Error(`Expected one Todo, found ${liveTodos().length}`);
  return todo;
};

// Writes a Block and types `[] ` at its start, as the User would; returns the Block's id.
async function todoBlock(notebook: Notebook, text: string): Promise<string> {
  const { id } = notebook.begin(TODAY, text);
  notebook.type(TODAY, id, `[] ${text}`, 3);
  await notebook.flush();
  return id;
}

describe('typing [] at the start of a Block', () => {
  it('makes it a Todo of origin Daily Note, with a made-from Link to the Block', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'Call Dana');
    // Typed a key at a time: the Block becomes a Todo once the space after [] is typed.
    notebook.type(TODAY, id, '[Call Dana', 1);
    expect(notebook.type(TODAY, id, '[]Call Dana', 2)).toBeNull();

    const caret = notebook.type(TODAY, id, '[] Call Dana', 3);
    await notebook.flush();

    expect(caret).toEqual({ id, offset: 0 });
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
    const todo = onlyTodo();
    expect(todo).toMatchObject({
      title: 'Call Dana',
      status: 'open',
      detail: { kind: 'todo', origin: 'daily-note' },
    });
    expect(store.get(todo.id)?.links).toMatchObject([{ type: 'made-from', to: { id, kind: 'block' } }]);
    expect(store.get(id)?.backlinks).toMatchObject([{ type: 'made-from', from: { id: todo.id } }]);
    expect((await todos.list()).map((t) => t.title)).toEqual(['Call Dana']);
  });

  it('works with [ ] too, and only at the start of a Block', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'x');
    notebook.type(TODAY, id, 'Buy [] milk');
    expect(liveTodos()).toEqual([]);

    expect(notebook.type(TODAY, id, '[ ] Buy milk')).toEqual({ id, offset: 'Buy milk'.length });
    await notebook.flush();

    expect(lines(notebook)).toEqual(['[ ] Buy milk']);
    expect(onlyTodo().title).toBe('Buy milk');
  });

  it('is one change to undo, typing included: the Todo goes and the Block is as it was', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');

    notebook.undo();
    await notebook.flush();

    expect(lines(notebook)).toEqual(['Call Dana']);
    expect(liveTodos()).toEqual([]);
    expect(store.get(id)?.item.title).toBe('Call Dana');

    notebook.redo();
    await notebook.flush();
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
    expect(onlyTodo().status).toBe('open');
  });

  it('survives a restart', async () => {
    const first = await open();
    const id = await todoBlock(first, 'Call Dana');
    first.tick(TODAY, id);
    await first.flush();

    const again = await open();
    expect(lines(again)).toEqual(['[x] Call Dana']);
  });
});

describe('Ctrl+Enter', () => {
  it('makes a plain Block a Todo, then ticks and unticks it', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'Water the plants');

    notebook.makeTodo(TODAY, id);
    await notebook.flush();
    expect(lines(notebook)).toEqual(['[ ] Water the plants']);
    expect(onlyTodo().title).toBe('Water the plants');

    notebook.tick(TODAY, id);
    await notebook.flush();
    expect(lines(notebook)).toEqual(['[x] Water the plants']);
    expect(onlyTodo().status).toBe('done');
  });
});

describe('the Todo’s title and the Block’s text', () => {
  it('follow each other: typing in the Block renames the Todo', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');

    notebook.type(TODAY, id, 'Call Dana about the offsite');
    await notebook.flush();

    expect(onlyTodo().title).toBe('Call Dana about the offsite');
  });

  it('follow each other: renaming the Todo in Todos changes the Block, and undo there puts both back', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');
    const todo = onlyTodo();

    const entry = await todos.rename(todo.id, 'Call Dana back');
    await notebook.refresh();
    expect(lines(notebook)).toEqual(['[ ] Call Dana back']);
    expect(store.get(id)?.item.title).toBe('Call Dana back');

    await todos.undo(entry.id);
    await notebook.refresh();
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
    expect(onlyTodo().title).toBe('Call Dana');
  });
});

describe('a Todo Ares added for a Block', () => {
  // As the gate carries out a "Suggest Todos" proposal for a Block the User wrote.
  async function aresAdds(notebook: Notebook, blockId: string, title: string) {
    const [todo] = store.recordAll(
      [
        {
          type: 'create',
          item: {
            kind: 'todo',
            title,
            detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
          },
        },
      ],
      { by: { kind: 'ares' } },
    );
    store.link(
      { from: todo?.itemId as string, linkType: 'made-from', to: blockId },
      { by: { kind: 'ares' } },
    );
    await notebook.refresh();
    return todo?.itemId as string;
  }

  it('shows as the Block’s checkbox, and ticks from the note', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'need to send Dana the Q3 numbers');
    await notebook.flush();
    const todo = await aresAdds(notebook, id, 'Send Dana the Q3 numbers');

    expect(lines(notebook)).toEqual(['[ ] need to send Dana the Q3 numbers']);
    expect(blockIn(notebook, id).todo).toEqual({ id: todo, done: false, ares: true });
    notebook.tick(TODAY, id);
    await notebook.flush();
    expect(store.get(todo)?.item.status).toBe('done');
  });

  it('keeps its own title when the User edits the Block', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'need to send Dana the Q3 numbers');
    await notebook.flush();
    const todo = await aresAdds(notebook, id, 'Send Dana the Q3 numbers');

    notebook.type(TODAY, id, 'need to send Dana the Q3 numbers by Friday');
    await notebook.flush();
    expect(store.get(todo)?.item.title).toBe('Send Dana the Q3 numbers');
    expect(store.get(id)?.item.title).toBe('need to send Dana the Q3 numbers by Friday');
  });
});

describe('ticking', () => {
  it('in the note ticks the Todo in Todos, and undo in the note unticks it', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');

    notebook.tick(TODAY, id);
    await notebook.flush();
    expect((await todos.list()).map((t) => [t.title, t.status])).toEqual([['Call Dana', 'done']]);
    expect(store.get(id)?.item.status).toBe('open');

    notebook.undo();
    await notebook.flush();
    expect(onlyTodo().status).toBe('open');
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
  });

  it('in Todos shows ticked in the note, and undo in Todos unticks it', async () => {
    const notebook = await open();
    await todoBlock(notebook, 'Call Dana');

    const entry = await todos.setDone(onlyTodo().id, true);
    await notebook.refresh();
    expect(lines(notebook)).toEqual(['[x] Call Dana']);

    await todos.undo(entry.id);
    await notebook.refresh();
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
  });

  it('does not change the Block itself', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');
    const before = store.activity({ itemId: id }).length;

    notebook.tick(TODAY, id);
    await notebook.flush();

    expect(store.activity({ itemId: id })).toHaveLength(before);
  });
});

describe('removing a Todo', () => {
  it('by deleting the checkbox keeps the Block’s text and deletes the Todo; undo brings it back', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');

    expect(notebook.removeTodo(TODAY, id)).toEqual({ id, offset: 0 });
    await notebook.flush();
    expect(lines(notebook)).toEqual(['Call Dana']);
    expect(liveTodos()).toEqual([]);

    notebook.undo();
    await notebook.flush();
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
    expect(onlyTodo().title).toBe('Call Dana');
  });

  it('by deleting its Block deletes the Todo; undo brings both back', async () => {
    const notebook = await open();
    const first = notebook.begin(TODAY, 'Morning');
    const second = notebook.enter(TODAY, first.id, 7, 7);
    if (!second) throw new Error('Enter did nothing');
    notebook.type(TODAY, second.id, '[] Call Dana', 3);
    await notebook.flush();

    // Delete at the end of the Block above joins the Todo's Block onto it.
    notebook.joinNext(TODAY, first.id);
    await notebook.flush();
    expect(lines(notebook)).toEqual(['MorningCall Dana']);
    expect(liveTodos()).toEqual([]);

    notebook.undo();
    await notebook.flush();
    expect(lines(notebook)).toEqual(['Morning', '[ ] Call Dana']);
    expect(onlyTodo().title).toBe('Call Dana');
  });

  it('in Todos removes the checkbox but keeps the Block’s text; undo there brings it back', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');

    const entry = await todos.remove(onlyTodo().id);
    await notebook.refresh();
    expect(lines(notebook)).toEqual(['Call Dana']);
    expect(store.get(id)?.item.deletedAt).toBeNull();

    await todos.undo(entry.id);
    await notebook.refresh();
    expect(lines(notebook)).toEqual(['[ ] Call Dana']);
  });
});

describe('Enter in a Todo', () => {
  it('makes the next Block a Todo too, and on an empty Todo makes it a plain Block', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');

    const next = notebook.enter(TODAY, id, 9, 9);
    if (!next) throw new Error('Enter did nothing');
    await notebook.flush();
    expect(lines(notebook)).toEqual(['[ ] Call Dana', '[ ] ']);
    expect(liveTodos()).toHaveLength(2);

    expect(notebook.enter(TODAY, next.id, 0, 0)).toEqual({ id: next.id, offset: 0 });
    await notebook.flush();
    expect(lines(notebook)).toEqual(['[ ] Call Dana', '']);
    expect(blockIn(notebook, next.id).todo).toBeUndefined();
    expect(liveTodos().map((t) => t.title)).toEqual(['Call Dana']);
  });
});

describe('the Todos Section', () => {
  it('knows the day and Block each Daily Note Todo was made from', async () => {
    const notebook = await open();
    const id = await todoBlock(notebook, 'Call Dana');
    await todos.add('Book flights');

    const madeFrom = await todos.madeFrom(await todos.list());

    expect([...madeFrom.entries()]).toEqual([[onlyDailyNoteTodo().id, { blockId: id, day: TODAY }]]);
  });
});

const onlyDailyNoteTodo = () => {
  const found = liveTodos().filter((t) => t.detail?.kind === 'todo' && t.detail.origin === 'daily-note');
  if (found.length !== 1 || !found[0]) throw new Error('Expected one Daily Note Todo');
  return found[0];
};
