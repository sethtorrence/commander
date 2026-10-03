import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Projects, and filing Items into them, through the Item store's interface on a real database.
const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
const stores: ItemStore[] = [];

function open() {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  stores.push(store);
  return store;
}

const longtail = { name: 'Longtail', code: 'LT', accent: 'blue' };
const titanlink = { name: 'Titanlink', code: 'TL', accent: 'teal' };

function create(store: ItemStore, project: { name: string; code: string; accent: string }) {
  return store.changeProject({ type: 'create', project });
}

function addTodo(store: ItemStore, title = 'Write the brief') {
  return store.record({ type: 'create', item: { kind: 'todo', title } }, user).itemId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-projects-'));
  clock = Date.UTC(2026, 9, 1, 12);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('creating Projects', () => {
  it('stores the name, Badge code and accent, in creation order, and they survive reopening', () => {
    const store = open();
    const created = create(store, longtail);
    clock += 1000;
    create(store, titanlink);
    store.close();
    stores.length = 0;

    expect(open().projects()).toEqual([
      {
        id: created.id,
        name: 'Longtail',
        code: 'LT',
        accent: 'blue',
        order: 0,
        archived: false,
        createdAt: clock - 1000,
      },
      expect.objectContaining({ name: 'Titanlink', code: 'TL', accent: 'teal', order: 1 }),
    ]);
  });

  it('upper-cases the code and trims the name', () => {
    const store = open();

    expect(create(store, { name: '  Tactics ', code: 'tx', accent: 'violet' })).toMatchObject({
      name: 'Tactics',
      code: 'TX',
    });
  });

  it('refuses a code that is already taken, whatever its case, naming the Project that has it', () => {
    const store = open();
    create(store, longtail);

    expect(() => create(store, { name: 'Lighthouse', code: 'lt', accent: 'green' })).toThrow(
      'LT is already the Badge code for Longtail',
    );
    expect(store.projects()).toHaveLength(1);
  });

  it.each([
    [{ ...longtail, code: 'L' }, 'A Badge code is two letters'],
    [{ ...longtail, code: 'LTX' }, 'A Badge code is two letters'],
    [{ ...longtail, code: 'L1' }, 'A Badge code is two letters'],
    [{ ...longtail, name: '   ' }, 'A Project needs a name'],
    [{ ...longtail, accent: '' }, 'A Project needs an accent colour'],
  ])('refuses %j with a clear message', (project, message) => {
    expect(() => create(open(), project)).toThrow(message);
  });
});

describe('filing an Item into a Project', () => {
  it('records the Project and how it was filed, with an activity entry of the change', () => {
    const store = open();
    const lt = create(store, longtail);
    const todo = addTodo(store);
    const filing = { projectId: lt.id, filedBy: 'user' } as const;

    const entry = store.record({ type: 'update', itemId: todo, changes: { filing } }, user);

    expect(store.get(todo)?.item.filing).toEqual(filing);
    expect(entry).toMatchObject({
      action: 'update',
      by: { kind: 'user' },
      changes: [{ field: 'filing', before: null, after: filing }],
    });
    expect(store.query({ projectId: lt.id }).map((item) => item.id)).toEqual([todo]);
  });

  it('moves it between Projects and unfiles it', () => {
    const store = open();
    const lt = create(store, longtail);
    const tl = create(store, titanlink);
    const todo = addTodo(store);
    const file = (projectId: string | null) =>
      store.record(
        {
          type: 'update',
          itemId: todo,
          changes: { filing: projectId ? { projectId, filedBy: 'user' } : null },
        },
        user,
      );

    file(lt.id);
    file(tl.id);
    expect(store.get(todo)?.item.filing?.projectId).toBe(tl.id);

    const unfiled = file(null);
    expect(store.get(todo)?.item.filing).toBeNull();
    expect(store.query({ projectId: null }).map((item) => item.id)).toEqual([todo]);
    expect(unfiled.changes).toEqual([
      { field: 'filing', before: { projectId: tl.id, filedBy: 'user' }, after: null },
    ]);
  });

  it('can be undone, putting back where it was filed before', () => {
    const store = open();
    const lt = create(store, longtail);
    const todo = addTodo(store);
    const filed = store.record(
      { type: 'update', itemId: todo, changes: { filing: { projectId: lt.id, filedBy: 'user' } } },
      user,
    );

    store.record({ type: 'undo', entryId: filed.id }, user);

    expect(store.get(todo)?.item.filing).toBeNull();
  });

  it('files a new Item straight into a Project', () => {
    const store = open();
    const lt = create(store, longtail);

    const entry = store.record(
      {
        type: 'create',
        item: { kind: 'todo', title: 'Ship it', filing: { projectId: lt.id, filedBy: 'user' } },
      },
      user,
    );

    expect(store.get(entry.itemId)?.item.filing).toEqual({ projectId: lt.id, filedBy: 'user' });
  });

  it('refuses a Project that does not exist', () => {
    const store = open();
    const todo = addTodo(store);
    const filing = { projectId: 'nope', filedBy: 'user' } as const;

    expect(() => store.record({ type: 'update', itemId: todo, changes: { filing } }, user)).toThrow(
      'No Project nope',
    );
    expect(() => store.record({ type: 'create', item: { kind: 'todo', title: 'x', filing } }, user)).toThrow(
      'No Project nope',
    );
    expect(store.get(todo)?.item.filing).toBeNull();
  });
});
