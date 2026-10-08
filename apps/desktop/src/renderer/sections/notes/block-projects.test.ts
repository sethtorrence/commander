import type { ItemStore } from '@commander/core/src/item-store';
import type { Filing, Project } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { projectsIn } from '../../projects/projects';
import { type Todos, todosIn } from '../todos/todos';
import { effectiveFilings, filterView, noteCounts } from './block-projects';
import { dailyNotesIn } from './daily-notes';
import { createNotebook, type Notebook } from './notebook';
import { type Block, type Outline, outlineOf } from './outline';

// Block Projects in the Notes Section: the `#LT` shorthand and the Badge picker set a Block's own
// Project, Blocks below inherit it, Todos made from Blocks follow it, and the Project filter narrows
// the stream. The Notebook, the Todos module and filing, side by side on one real Item store.

const TODAY = '2026-10-03';
let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let todos: Todos;
let errors: string[];
let LT: Project;
let TX: Project;
const notebooks: Notebook[] = [];

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
  store.saveDailyTemplate({ blocks: [] });
  todos = todosIn(client);
  errors = [];
  LT = project('Longtail', 'LT');
  TX = project('Tactics', 'TX');
});

afterEach(async () => {
  for (const notebook of notebooks.splice(0)) await notebook.flush();
  close();
  expect(errors).toEqual([]);
});

function project(name: string, code: string): Project {
  const created = store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project;
  if (!created) throw new Error('No Project');
  return created;
}

async function open(): Promise<Notebook> {
  let n = 0;
  const prefix = notebooks.length;
  const notebook = createNotebook(dailyNotesIn(client), {
    today: TODAY,
    newId: () => `00000000-0000-4000-8000-${String(prefix * 1000 + ++n).padStart(12, '0')}`,
    onError: (message) => errors.push(message),
    projects: () => store.projects(),
  });
  notebooks.push(notebook);
  await notebook.start();
  return notebook;
}

const own = (p: Project): Filing => ({ projectId: p.id, filedBy: 'user' });
const inherited = (p: Project): Filing => ({ projectId: p.id, filedBy: 'inherited' });

const outlineOfToday = (notebook: Notebook) =>
  notebook.snapshot().days.find((d) => d.day === TODAY)?.outline ?? new Map();
const textOf = (notebook: Notebook, id: string) => outlineOfToday(notebook).get(id)?.text;
// The Project each Block shows in the note, as the margin and the filter see it.
const shown = (notebook: Notebook, id: string) => effectiveFilings(outlineOfToday(notebook)).get(id);
// The Project kept on each Block's Item in the store.
const saved = (id: string) => store.get(id)?.item.filing;

// Makes a Block a bullet, as typing `- ` at its start does: only list items nest (#239).
const bullet = (notebook: Notebook, id: string) =>
  notebook.type(TODAY, id, `- ${textOf(notebook, id) ?? ''}`, 2);

// Writes a parent bullet and a child bullet under it; returns their ids.
function parentAndChild(notebook: Notebook, parent: string, child: string): [string, string] {
  const { id: parentId } = notebook.begin(TODAY, parent);
  bullet(notebook, parentId);
  const next = notebook.enter(TODAY, parentId, parent.length, parent.length);
  if (!next) throw new Error('Enter did nothing');
  notebook.type(TODAY, next.id, child);
  notebook.indent(TODAY, next.id, child.length);
  return [parentId, next.id];
}

describe('the #LT shorthand', () => {
  it('sets the Block’s own Project, recorded as filed by the User', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'Pricing');
    notebook.type(TODAY, id, 'Pricing #l');
    notebook.type(TODAY, id, 'Pricing #lt');
    expect(shown(notebook, id)).toEqual(own(LT));
    await notebook.flush();

    expect(saved(id)).toEqual(own(LT));
    const [entry] = store.activity({ itemId: id, limit: 1 });
    expect(entry?.by).toEqual({ kind: 'user' });
    expect(entry?.changes).toContainEqual({ field: 'filing', before: null, after: own(LT) });
  });

  it('stays plain text for a code no active Project has', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'Pricing #ZZ');
    await notebook.flush();

    expect(shown(notebook, id)).toBeNull();
    expect(saved(id)).toBeNull();
  });

  it('goes back to inheriting when removed', async () => {
    const notebook = await open();
    const [parent, child] = parentAndChild(notebook, 'Tactics #TX', 'Positioning #LT');
    await notebook.flush();
    expect(saved(child)).toEqual(own(LT));

    notebook.type(TODAY, child, 'Positioning');
    await notebook.flush();

    expect(shown(notebook, child)).toEqual(inherited(TX));
    expect(saved(child)).toEqual(inherited(TX));
    expect(saved(parent)).toEqual(own(TX));
  });

  it('can be undone and redone, tagging and untagging alike', async () => {
    const notebook = await open();
    const [parent, child] = parentAndChild(notebook, 'Longtail', 'Standup');
    notebook.type(TODAY, parent, 'Longtail #LT');
    await notebook.flush();
    expect(saved(child)).toEqual(inherited(LT));

    notebook.undo();
    await notebook.flush();
    expect([shown(notebook, parent), shown(notebook, child)]).toEqual([null, null]);
    expect([saved(parent), saved(child)]).toEqual([null, null]);

    notebook.redo();
    await notebook.flush();
    expect([saved(parent), saved(child)]).toEqual([own(LT), inherited(LT)]);

    notebook.type(TODAY, parent, 'Longtail');
    await notebook.flush();
    expect(saved(child)).toBeNull();
    notebook.undo();
    await notebook.flush();
    expect([saved(parent), saved(child)]).toEqual([own(LT), inherited(LT)]);
  });
});

describe('inheritance in the note', () => {
  it('files children under their parent’s Project, and a child’s own one overrides it', async () => {
    const notebook = await open();
    const [parent, child] = parentAndChild(notebook, 'Longtail #LT', 'Standup');
    const next = notebook.enter(TODAY, child, 7, 7);
    if (!next) throw new Error('Enter did nothing');
    notebook.type(TODAY, next.id, 'Board #TX');
    await notebook.flush();

    expect(shown(notebook, child)).toEqual(inherited(LT));
    expect(shown(notebook, next.id)).toEqual(own(TX));
    expect([saved(parent), saved(child), saved(next.id)]).toEqual([own(LT), inherited(LT), own(TX)]);
  });

  it('re-inherits when a Block is indented under a tagged Block and outdented again, as one change each', async () => {
    const notebook = await open();
    const { id: parent } = notebook.begin(TODAY, 'Longtail #LT');
    bullet(notebook, parent);
    const next = notebook.enter(TODAY, parent, 12, 12);
    if (!next) throw new Error('Enter did nothing');
    notebook.type(TODAY, next.id, 'Standup');
    await notebook.flush();
    expect(saved(next.id)).toBeNull();

    notebook.indent(TODAY, next.id, 0);
    await notebook.flush();
    expect(shown(notebook, next.id)).toEqual(inherited(LT));
    expect(saved(next.id)).toEqual(inherited(LT));

    notebook.outdent(TODAY, next.id, 0);
    await notebook.flush();
    expect(saved(next.id)).toBeNull();

    notebook.undo();
    await notebook.flush();
    expect(saved(next.id)).toEqual(inherited(LT));
  });
});

describe('the Badge picker on a Block', () => {
  it('files a Block without the shorthand, as one change to undo', async () => {
    const notebook = await open();
    const [parent, child] = parentAndChild(notebook, 'Longtail', 'Standup');

    notebook.file(TODAY, parent, LT.id);
    await notebook.flush();
    expect(textOf(notebook, parent)).toBe('Longtail');
    expect([saved(parent), saved(child)]).toEqual([own(LT), inherited(LT)]);

    notebook.undo();
    await notebook.flush();
    expect([saved(parent), saved(child)]).toEqual([null, null]);
  });

  it('changes the shorthand in the text to the Project chosen, and removes it for Unfiled', async () => {
    const notebook = await open();
    const { id } = notebook.begin(TODAY, 'Pricing #lt today');

    notebook.file(TODAY, id, TX.id);
    expect(textOf(notebook, id)).toBe('Pricing #TX today');
    expect(shown(notebook, id)).toEqual(own(TX));

    notebook.file(TODAY, id, null);
    await notebook.flush();
    expect(textOf(notebook, id)).toBe('Pricing today');
    expect(saved(id)).toBeNull();
  });
});

describe('a Todo made from a tagged Block', () => {
  it('shows the Block’s Project in Todos and follows it, until it is filed there by hand', async () => {
    const notebook = await open();
    const [parent, child] = parentAndChild(notebook, 'Longtail #LT', 'Call Dana');
    notebook.makeTodo(TODAY, child);
    await notebook.flush();

    const todoOf = async () => (await todos.list()).find((todo) => todo.title === 'Call Dana');
    expect((await todoOf())?.filing).toEqual(inherited(LT));

    notebook.type(TODAY, parent, 'Longtail #TX');
    await notebook.flush();
    expect((await todoOf())?.filing).toEqual(inherited(TX));

    const todo = await todoOf();
    if (!todo) throw new Error('No Todo');
    await projectsIn(client).file(todo.id, LT.id);
    notebook.type(TODAY, parent, 'Longtail');
    await notebook.flush();
    expect((await todoOf())?.filing).toEqual(own(LT));
  });
});

// Outlines written by hand for the filter: `filing` is what the Block's Item holds.
function outline(...blocks: (Partial<Block> & { id: string })[]): Outline {
  return outlineOf(
    blocks.map((block, i) => ({
      parentId: null,
      position: `a${i}`,
      text: block.id,
      folded: false,
      ...block,
    })),
  );
}

describe('the Project filter in Notes', () => {
  const tagged = outline(
    { id: 'meeting' },
    { id: 'longtail', parentId: 'meeting', filing: { projectId: 'p-lt', filedBy: 'user' } },
    { id: 'notes', parentId: 'longtail' },
    { id: 'tactics', parentId: 'longtail', filing: { projectId: 'p-tx', filedBy: 'user' } },
    { id: 'other', parentId: 'meeting' },
    { id: 'loose' },
  );

  it('shows everything when Everything is chosen', () => {
    expect(filterView(tagged, 'everything')).toEqual({ hidden: new Set(), dimmed: new Set(), matching: 6 });
  });

  it('shows a Project’s Blocks, with the Blocks above them dimmed, and hides the rest', () => {
    expect(filterView(tagged, 'p-lt')).toEqual({
      hidden: new Set(['tactics', 'other', 'loose']),
      dimmed: new Set(['meeting']),
      matching: 2,
    });
  });

  it('shows the Unfiled Blocks', () => {
    expect(filterView(tagged, 'unfiled')).toEqual({
      hidden: new Set(['longtail', 'notes', 'tactics']),
      dimmed: new Set(),
      matching: 3,
    });
  });

  it('keeps showing the Blocks the User is writing in, whatever their Project', () => {
    expect(filterView(tagged, 'p-tx', new Set(['loose']))).toMatchObject({
      hidden: new Set(['notes', 'other']),
      dimmed: new Set(['meeting', 'longtail']),
      matching: 1,
    });
  });

  it('counts the Daily Notes with a written Block in each Project, the days on screen as they are now', () => {
    const counts = noteCounts(
      [
        { day: '2026-10-03', projectIds: ['p-lt'], unfiled: false },
        { day: '2026-10-02', projectIds: ['p-lt', 'p-tx'], unfiled: true },
        { day: '2026-10-01', projectIds: [], unfiled: true },
      ],
      [
        { day: '2026-10-03', outline: tagged },
        { day: '2026-10-01', outline: outline({ id: 'blank', text: '' }) },
      ],
    );

    expect(counts.everything).toBe(2);
    expect(counts.unfiled).toBe(2);
    expect(counts.project('p-lt')).toBe(2);
    expect(counts.project('p-tx')).toBe(2);
  });
});
