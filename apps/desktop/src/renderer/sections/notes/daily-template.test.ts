import type { ItemStore } from '@commander/core/src/item-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { dailyNotesIn } from './daily-notes';
import { TEMPLATE_DAY, templateIn } from './daily-template';
import { createNotebook, type Notebook } from './notebook';
import { visibleBlocks } from './outline';

// Editing the daily template in Settings: the Notes outliner's Notebook, on the template instead of
// a day's Daily Note.

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
const notebooks: Notebook[] = [];

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
});

afterEach(async () => {
  for (const notebook of notebooks.splice(0)) await notebook.flush();
  close();
});

function openTemplate() {
  let n = 0;
  const notebook = createNotebook(templateIn(client), {
    today: TEMPLATE_DAY,
    newId: () => `new-${++n}`,
  });
  notebooks.push(notebook);
  return notebook;
}

function openNotes(today: string) {
  const notebook = createNotebook(dailyNotesIn(client), { today });
  notebooks.push(notebook);
  return notebook;
}

const lines = (notebook: Notebook, day = TEMPLATE_DAY) =>
  visibleBlocks(notebook.snapshot().days.find((d) => d.day === day)?.outline ?? new Map(), {
    includeFolded: true,
  }).map(({ block, depth }) => `${'  '.repeat(depth)}${block.text}`);

const templateLines = () => {
  const blocks = store.dailyTemplate().blocks;
  const out: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const block of blocks
      .filter((b) => b.parentId === parentId)
      .sort((a, b) => (a.position < b.position ? -1 : 1))) {
      out.push(`${'  '.repeat(depth)}${block.text}`);
      walk(block.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
};

// The id of the Block holding `text` in the template editor.
const idOf = (notebook: Notebook, text: string) => {
  const outline = notebook.snapshot().days[0]?.outline ?? new Map();
  const found = [...outline.values()].find((block) => block.text === text);
  if (!found) throw new Error(`No Block "${text}"`);
  return found.id;
};

describe('editing the daily template', () => {
  it('shows the template’s Blocks, the defaults on a fresh database', async () => {
    const editor = openTemplate();
    await editor.start();

    expect(editor.snapshot().days.map((d) => d.day)).toEqual([TEMPLATE_DAY]);
    expect(lines(editor)).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
  });

  it('saves Blocks added, nested and removed with the outliner, without touching any Item', async () => {
    const editor = openTemplate();
    await editor.start();

    // A Block under Morning, Ideas removed, and Evening typed over.
    const morning = idOf(editor, 'Morning');
    const coffee = editor.enter(TEMPLATE_DAY, morning, 7, 7);
    editor.type(TEMPLATE_DAY, coffee?.id as string, 'Coffee');
    editor.indent(TEMPLATE_DAY, coffee?.id as string, 6);
    const ideas = idOf(editor, 'Ideas');
    editor.type(TEMPLATE_DAY, ideas, '');
    editor.removeBackward(TEMPLATE_DAY, ideas);
    editor.type(TEMPLATE_DAY, idOf(editor, 'Evening'), 'Wind down');
    await editor.flush();

    const expected = ['Morning', '  Coffee', 'Meetings', 'Todos', 'Wind down'];
    expect(lines(editor)).toEqual(expected);
    expect(templateLines()).toEqual(expected);
    expect(store.query()).toEqual([]);

    const reopened = openTemplate();
    await reopened.start();
    expect(lines(reopened)).toEqual(expected);
  });

  it('keeps [] as text: the template’s Blocks don’t become Todos', async () => {
    const editor = openTemplate();
    await editor.start();
    const ideas = idOf(editor, 'Ideas');

    expect(editor.type(TEMPLATE_DAY, ideas, '[] Ideas', 3)).toBeNull();
    expect(editor.makeTodo(TEMPLATE_DAY, ideas)).toBeNull();
    await editor.flush();

    expect(templateLines()).toContain('[] Ideas');
    expect(editor.snapshot().days[0]?.outline.get(ideas)?.todo).toBeUndefined();
    expect(store.query()).toEqual([]);
  });

  it('undoes and redoes edits, and saves each', async () => {
    const editor = openTemplate();
    await editor.start();
    const meetings = idOf(editor, 'Meetings');

    editor.indent(TEMPLATE_DAY, meetings, 0);
    await editor.flush();
    expect(templateLines().slice(0, 2)).toEqual(['Morning', '  Meetings']);

    editor.undo();
    await editor.flush();
    expect(templateLines().slice(0, 2)).toEqual(['Morning', 'Meetings']);

    editor.redo();
    await editor.flush();
    expect(templateLines().slice(0, 2)).toEqual(['Morning', '  Meetings']);
  });

  it('can be emptied', async () => {
    const editor = openTemplate();
    await editor.start();
    for (const text of ['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']) {
      const id = idOf(editor, text);
      editor.type(TEMPLATE_DAY, id, '');
      editor.removeBackward(TEMPLATE_DAY, id);
    }
    await editor.flush();

    // The last Block can't be removed with Backspace, so one empty Block stays.
    expect(templateLines()).toEqual(['']);
  });

  it('changes the next new day, but not today or any earlier day', async () => {
    const notes = openNotes('2026-10-03');
    await notes.start();
    expect(lines(notes, '2026-10-03')).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);

    const editor = openTemplate();
    await editor.start();
    const todos = idOf(editor, 'Todos');
    editor.type(TEMPLATE_DAY, todos, 'Top three');
    editor.indent(TEMPLATE_DAY, todos, 0);
    await editor.flush();

    await notes.setToday('2026-10-04');
    expect(lines(notes, '2026-10-04')).toEqual(['Morning', 'Meetings', '  Top three', 'Ideas', 'Evening']);
    expect(lines(notes, '2026-10-03')).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
  });
});
