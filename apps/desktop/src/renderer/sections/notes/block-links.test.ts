import type { ItemStore } from '@commander/core/src/item-store';
import { blockLinkToken } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { dailyNotesIn } from './daily-notes';
import { createNotebook, type Notebook } from './notebook';

// `[[` links from the Notes Section's side: choosing a target in a Block, deleting the chip, undo and
// redo, and the Links the Item store keeps for them.

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
const notebooks: Notebook[] = [];
const today = '2026-10-03';

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
  store.saveDailyTemplate({ blocks: [] });
});

afterEach(async () => {
  for (const notebook of notebooks.splice(0)) await notebook.flush();
  close();
});

function open(day = today) {
  let n = 0;
  const notebook = createNotebook(dailyNotesIn(client), {
    today: day,
    newId: () => `00000000-0000-4000-8000-${String(++n + notebooks.length * 1000).padStart(12, '0')}`,
  });
  notebooks.push(notebook);
  return notebook;
}

const textOf = (notebook: Notebook, day: string, id: string) =>
  notebook
    .snapshot()
    .days.find((d) => d.day === day)
    ?.outline.get(id)?.text;

const linksOf = (blockId: string) =>
  (store.get(blockId)?.links ?? []).map((link) => `${link.type} ${link.to.kind} ${link.to.title}`);

function makeProject(name: string, code: string) {
  const made = store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project;
  if (!made) throw new Error('No Project');
  return made.id;
}

describe('choosing a [[ target', () => {
  it('puts a chip in the Block and links it at once: to a day, and to a Project', async () => {
    const longtail = makeProject('Longtail', 'LT');
    const notebook = open();
    await notebook.start();
    const { id } = notebook.begin(today, 'See [[thu');

    const caret = notebook.link(today, id, { start: 4, query: 'thu' }, { type: 'day', day: '2026-10-01' });
    const day = blockLinkToken({ type: 'day', day: '2026-10-01' });
    expect(caret).toEqual({ id, offset: 4 + day.length });
    expect(textOf(notebook, today, id)).toBe(`See ${day}`);

    notebook.type(today, id, `See ${day} on [[lon`);
    notebook.link(
      today,
      id,
      { start: 8 + day.length, query: 'lon' },
      { type: 'project', projectId: longtail },
    );
    await notebook.flush();

    expect(linksOf(id)).toEqual([
      'refers-to daily-note Thursday 1 October 2026',
      'refers-to project Longtail',
    ]);
  });

  it('is one step to undo, which takes the chip and its Link away; redo brings both back', async () => {
    const notebook = open();
    await notebook.start();
    const { id } = notebook.begin(today, 'See [[');
    notebook.link(today, id, { start: 4, query: '' }, { type: 'day', day: '2026-10-02' });
    await notebook.flush();

    notebook.undo();
    await notebook.flush();
    expect(textOf(notebook, today, id)).toBe('See [[');
    expect(linksOf(id)).toEqual([]);

    notebook.redo();
    await notebook.flush();
    expect(textOf(notebook, today, id)).toBe('See [[2026-10-02]]');
    expect(linksOf(id)).toEqual(['refers-to daily-note Friday 2 October 2026']);
  });
});

describe('deleting a chip', () => {
  it('removes it whole and its Link with it; undo restores both', async () => {
    const notebook = open();
    await notebook.start();
    const token = blockLinkToken({ type: 'day', day: '2026-10-02' });
    const { id } = notebook.begin(today, `See ${token} later`);
    await notebook.flush();
    expect(linksOf(id)).toHaveLength(1);

    expect(notebook.unlink(today, id, 4 + token.length, 'backward')).toEqual({ id, offset: 4 });
    await notebook.flush();
    expect(textOf(notebook, today, id)).toBe('See  later');
    expect(linksOf(id)).toEqual([]);

    notebook.undo();
    await notebook.flush();
    expect(textOf(notebook, today, id)).toBe(`See ${token} later`);
    expect(linksOf(id)).toHaveLength(1);
  });

  it('does nothing where there is no chip', async () => {
    const notebook = open();
    await notebook.start();
    const { id } = notebook.begin(today, 'Plain');
    expect(notebook.unlink(today, id, 5, 'backward')).toBeNull();
  });

  it('leaves typing held back alone where there is no chip, so Backspaces stay one step to undo', async () => {
    const notebook = open();
    await notebook.start();
    const { id } = notebook.begin(today, 'Plan');
    await notebook.flush();
    for (const text of ['Pla', 'Pl', 'P']) {
      expect(notebook.unlink(today, id, text.length + 1, 'backward')).toBeNull();
      notebook.type(today, id, text);
    }
    notebook.undo();
    await notebook.flush();
    expect(textOf(notebook, today, id)).toBe('Plan');
  });
});

describe('Blocks with links', () => {
  it('keep their Links when moved under another Block, and after Commander restarts', async () => {
    const notebook = open();
    await notebook.start();
    const { id: first } = notebook.begin(today, 'Meetings');
    // As bullets, which nest (#239).
    notebook.type(today, first, '- Meetings', 2);
    const second = notebook.enter(today, first, 8, 8);
    if (!second) throw new Error('No second Block');
    notebook.type(today, second.id, 'Call [[2026-10-01]]');
    notebook.indent(today, second.id, 0);
    await notebook.flush();

    const reopened = open();
    await reopened.start();
    const moved = reopened.snapshot().days[0]?.outline.get(second.id);
    expect(moved?.parentId).toBe(first);
    expect(linksOf(second.id)).toEqual(['refers-to daily-note Thursday 1 October 2026']);
  });
});

describe('a day linked ahead of time', () => {
  it('opens from its chip, and starts from the daily template once it becomes today if nothing was written', async () => {
    store.saveDailyTemplate({
      blocks: [{ id: 't1', parentId: null, position: 'a0', text: 'Morning', folded: false }],
    });
    const notebook = open('2026-10-03');
    await notebook.start();
    const [plan] = notebook.snapshot().days[0]?.outline.keys() ?? [];
    notebook.type('2026-10-03', plan as string, 'Ship [[');
    notebook.link('2026-10-03', plan as string, { start: 5, query: '' }, { type: 'day', day: '2026-10-05' });
    await notebook.flush();

    await notebook.showDay('2026-10-05');
    expect(notebook.snapshot().days.map((d) => d.day)).toEqual(['2026-10-05', '2026-10-03']);
    expect(notebook.snapshot().days[0]?.outline.size).toBe(0);

    await notebook.setToday('2026-10-05');
    const texts = [...(notebook.snapshot().days[0]?.outline.values() ?? [])].map((block) => block.text);
    expect(texts).toEqual(['Morning']);
  });
});
