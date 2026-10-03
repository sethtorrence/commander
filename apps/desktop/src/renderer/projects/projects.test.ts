import type { ItemStore } from '@commander/core/src/item-store';
import type { ItemChange, Project } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestItemStore } from '../item-store/test-item-store';
import { describeFiling, type ProjectsClient, projectsIn } from './projects';

// The renderer's Projects client against a real Item store on a temporary database.
let store: ItemStore;
let projects: ProjectsClient;
let close: () => void;

beforeEach(() => {
  const opened = openTestItemStore();
  ({ store, close } = opened);
  projects = projectsIn(opened.client);
});

afterEach(() => close());

const addTodo = (title = 'Write the brief') =>
  store.record({ type: 'create', item: { kind: 'todo', title } }, { by: { kind: 'user' } }).itemId;

describe('the Projects client', () => {
  it('creates Projects and lists them in order', async () => {
    await projects.create({ name: 'Longtail', code: 'lt', accent: 'blue' });
    await projects.create({ name: 'Titanlink', code: 'TL', accent: 'teal' });

    expect((await projects.list()).map((p) => [p.code, p.name, p.accent])).toEqual([
      ['LT', 'Longtail', 'blue'],
      ['TL', 'Titanlink', 'teal'],
    ]);
  });

  it('passes on why a Project was refused', async () => {
    await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });

    await expect(projects.create({ name: 'Lighthouse', code: 'LT', accent: 'green' })).rejects.toThrow(
      'LT is already the Badge code for Longtail',
    );
  });

  it('files an Item into a Project as the User, and unfiles it', async () => {
    const lt = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    const todo = addTodo();

    const filed = await projects.file(todo, lt.id);
    expect(store.get(todo)?.item.filing).toEqual({ projectId: lt.id, filedBy: 'user' });
    expect(filed).toMatchObject({ by: { kind: 'user' }, itemId: todo });

    await projects.file(todo, null);
    expect(store.get(todo)?.item.filing).toBeNull();
  });

  it('lists archived Projects too, so old Items can still show their Badges', async () => {
    const lt = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    await projects.create({ name: 'Titanlink', code: 'TL', accent: 'teal' });

    await projects.change({ type: 'archive', projectId: lt.id });

    expect((await projects.list()).map((p) => [p.code, p.archived])).toEqual([
      ['LT', true],
      ['TL', false],
    ]);
  });

  it('merges one Project into another and undoes it, passing on refusals', async () => {
    const lt = await projects.create({ name: 'Longtail', code: 'LT', accent: 'blue' });
    const tx = await projects.create({ name: 'Tactics', code: 'TX', accent: 'violet' });
    const todo = addTodo();
    await projects.file(todo, tx.id);

    const merged = await projects.change({ type: 'merge', projectId: tx.id, into: lt.id });
    expect(merged).toMatchObject({ action: 'merge', moved: 1, project: { code: 'LT' } });
    expect(store.get(todo)?.item.filing?.projectId).toBe(lt.id);

    await projects.change({ type: 'undo', changeId: merged.id });
    expect(store.get(todo)?.item.filing?.projectId).toBe(tx.id);

    await expect(projects.change({ type: 'merge', projectId: lt.id, into: lt.id })).rejects.toThrow(
      'A Project can’t be merged into itself',
    );
  });
});

describe('describing a change of filing', () => {
  const lt: Project = {
    id: 'p-lt',
    name: 'Longtail',
    code: 'LT',
    accent: 'blue',
    order: 0,
    archived: false,
    createdAt: 0,
  };
  const change = (before: string | null, after: string | null): ItemChange & { field: 'filing' } => ({
    field: 'filing',
    before: before ? { projectId: before, filedBy: 'user' } : null,
    after: after ? { projectId: after, filedBy: 'user' } : null,
  });

  it.each([
    [change(null, 'p-lt'), 'Filed under LT'],
    [change('p-other', 'p-lt'), 'Filed under LT'],
    [change('p-lt', null), 'Unfiled'],
    [change(null, 'p-gone'), 'Filed under a Project'],
  ])('%#: %s', (filing, expected) => {
    expect(describeFiling(filing, [lt])).toBe(expected);
  });
});
