import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, FiledBy, ProjectAction } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Managing Projects through the Item store's interface on a real database: rename, recolour,
// reorder, archive and merge, each kept in the Project log so it can be undone.
const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-managing-projects-'));
  clock = Date.UTC(2026, 9, 1, 12);
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

function change(action: ProjectAction) {
  clock += 1000;
  return store.changeProject(action);
}

function create(name: string, code: string, accent = 'blue') {
  const project = change({ type: 'create', project: { name, code, accent } }).project;
  if (!project) throw new Error('No Project created');
  return project;
}

function addTodo(title: string, projectId: string | null = null, filedBy: FiledBy = 'user') {
  const filing = projectId ? { projectId, filedBy } : null;
  return store.record({ type: 'create', item: { kind: 'todo', title, filing } }, user).itemId;
}

const codes = (query?: { includeArchived?: boolean }) => store.projects(query).map((p) => p.code);
const filingOf = (itemId: string) => store.get(itemId)?.item.filing;
const countIn = (projectId: string) => store.query({ projectId, includeDeleted: true }).length;

describe('renaming, recoding and recolouring a Project', () => {
  it('changes its name, code and accent, and logs the change', () => {
    const lt = create('Longtail', 'LT');

    const changed = change({
      type: 'update',
      projectId: lt.id,
      changes: { name: ' Longtail Labs ', code: 'll', accent: '#3366FF' },
    });

    expect(changed).toMatchObject({
      action: 'update',
      project: { id: lt.id, name: 'Longtail Labs', code: 'LL', accent: '#3366FF' },
      mergedId: null,
      moved: 0,
      undoes: null,
    });
    expect(store.projects()).toEqual([changed.project]);
  });

  it('changes only what it is given', () => {
    const lt = create('Longtail', 'LT', 'blue');

    change({ type: 'update', projectId: lt.id, changes: { accent: 'violet' } });

    expect(store.projects()[0]).toMatchObject({ name: 'Longtail', code: 'LT', accent: 'violet' });
  });

  it('keeps its own code without complaint, but refuses a code another Project has, archived or not', () => {
    const lt = create('Longtail', 'LT');
    const tx = create('Tactics', 'TX');
    change({ type: 'archive', projectId: tx.id });

    expect(() => change({ type: 'update', projectId: lt.id, changes: { code: 'lt' } })).not.toThrow();
    expect(() => change({ type: 'update', projectId: lt.id, changes: { code: 'tx' } })).toThrow(
      'TX is already the Badge code for Tactics',
    );
    expect(codes()).toEqual(['LT']);
  });

  it.each([
    [{ name: '  ' }, 'A Project needs a name'],
    [{ code: 'L1' }, 'A Badge code is two letters'],
    [{ accent: 'not a colour!' }, 'A Project needs an accent colour'],
    [{}, 'Nothing to change'],
  ])('refuses %j', (changes, message) => {
    const lt = create('Longtail', 'LT');
    expect(() => change({ type: 'update', projectId: lt.id, changes })).toThrow(message);
  });

  it('refuses a Project that does not exist', () => {
    expect(() => change({ type: 'update', projectId: 'nope', changes: { name: 'x' } })).toThrow(
      'No Project nope',
    );
  });

  it('can be undone, and the undo redone', () => {
    const lt = create('Longtail', 'LT', 'blue');
    const renamed = change({ type: 'update', projectId: lt.id, changes: { name: 'Lighthouse', code: 'LH' } });

    const undone = change({ type: 'undo', changeId: renamed.id });
    expect(undone).toMatchObject({ action: 'undo', undoes: renamed.id, project: { code: 'LT' } });
    expect(store.projects()[0]).toMatchObject({ name: 'Longtail', code: 'LT', accent: 'blue' });

    change({ type: 'undo', changeId: undone.id });
    expect(store.projects()[0]).toMatchObject({ name: 'Lighthouse', code: 'LH' });
  });

  it('refuses to undo a rename whose old code another Project has taken since', () => {
    const lt = create('Longtail', 'LT');
    const renamed = change({ type: 'update', projectId: lt.id, changes: { code: 'LH' } });
    create('Lattice', 'LT');

    expect(() => change({ type: 'undo', changeId: renamed.id })).toThrow(
      'LT is already the Badge code for Lattice',
    );
  });
});

describe('putting Projects in order', () => {
  it('lists them in the order given, which survives every later read', () => {
    const lt = create('Longtail', 'LT');
    const tl = create('Titanlink', 'TL');
    const tx = create('Tactics', 'TX');

    const reordered = change({ type: 'reorder', projectIds: [tx.id, lt.id, tl.id] });

    expect(reordered).toMatchObject({ action: 'reorder', project: null });
    expect(codes()).toEqual(['TX', 'LT', 'TL']);
    expect(store.projects().map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it('needs every Project that is not archived, each once', () => {
    const lt = create('Longtail', 'LT');
    const tl = create('Titanlink', 'TL');
    const tx = create('Tactics', 'TX');
    change({ type: 'archive', projectId: tx.id });

    for (const projectIds of [[lt.id], [lt.id, tl.id, tx.id], [lt.id, lt.id], [lt.id, 'nope']]) {
      expect(() => change({ type: 'reorder', projectIds })).toThrow(
        'Put every Project that isn’t archived in order, each once',
      );
    }
    expect(() => change({ type: 'reorder', projectIds: [tl.id, lt.id] })).not.toThrow();
    expect(codes()).toEqual(['TL', 'LT']);
  });

  it('can be undone', () => {
    const lt = create('Longtail', 'LT');
    const tl = create('Titanlink', 'TL');
    const reordered = change({ type: 'reorder', projectIds: [tl.id, lt.id] });

    change({ type: 'undo', changeId: reordered.id });

    expect(codes()).toEqual(['LT', 'TL']);
  });
});

describe('archiving a Project', () => {
  it('takes it out of the Projects offered, while its Items keep their filing', () => {
    const lt = create('Longtail', 'LT');
    const tl = create('Titanlink', 'TL');
    const todo = addTodo('Ship the beta', lt.id);

    const archived = change({ type: 'archive', projectId: lt.id });

    expect(archived).toMatchObject({ action: 'archive', project: { id: lt.id, archived: true } });
    expect(codes()).toEqual(['TL']);
    expect(codes({ includeArchived: true })).toEqual(['LT', 'TL']);
    expect(filingOf(todo)).toEqual({ projectId: lt.id, filedBy: 'user' });
    expect(store.activity({ itemId: todo })).toHaveLength(1);
    expect(tl.archived).toBe(false);
  });

  it('comes back at the end of the order when unarchived', () => {
    const lt = create('Longtail', 'LT');
    create('Titanlink', 'TL');
    create('Tactics', 'TX');
    change({ type: 'archive', projectId: lt.id });

    const unarchived = change({ type: 'unarchive', projectId: lt.id });

    expect(unarchived).toMatchObject({ action: 'unarchive', project: { archived: false } });
    expect(codes()).toEqual(['TL', 'TX', 'LT']);
  });

  it('can be undone, back to where it was in the order', () => {
    const lt = create('Longtail', 'LT');
    create('Titanlink', 'TL');
    const archived = change({ type: 'archive', projectId: lt.id });

    change({ type: 'undo', changeId: archived.id });

    expect(codes()).toEqual(['LT', 'TL']);
  });

  it('refuses to archive an archived Project, or unarchive one that isn’t', () => {
    const lt = create('Longtail', 'LT');
    expect(() => change({ type: 'unarchive', projectId: lt.id })).toThrow('Longtail isn’t archived');
    change({ type: 'archive', projectId: lt.id });
    expect(() => change({ type: 'archive', projectId: lt.id })).toThrow('Longtail is already archived');
  });
});

describe('merging one Project into another', () => {
  function merging() {
    const lt = create('Longtail', 'LT');
    const tl = create('Titanlink', 'TL');
    const tx = create('Tactics', 'TX', 'violet');
    const mine = addTodo('Draft Q4 positioning', tx.id, 'user');
    const aresFiled = addTodo('Book the offsite', tx.id, 'ares');
    const deleted = addTodo('Old idea', tx.id);
    store.record({ type: 'delete', itemId: deleted }, user);
    const stays = addTodo('Ship the beta', lt.id);
    return { lt, tl, tx, mine, aresFiled, deleted, stays };
  }

  it('moves every Item into the Project kept, keeping how each was filed', () => {
    const { lt, tx, mine, aresFiled, deleted, stays } = merging();
    expect([countIn(lt.id), countIn(tx.id)]).toEqual([1, 3]);

    const merged = change({ type: 'merge', projectId: tx.id, into: lt.id });

    expect(merged).toMatchObject({ action: 'merge', project: { id: lt.id }, mergedId: tx.id, moved: 3 });
    expect([countIn(lt.id), countIn(tx.id)]).toEqual([4, 0]);
    expect(filingOf(mine)).toEqual({ projectId: lt.id, filedBy: 'user' });
    expect(filingOf(aresFiled)).toEqual({ projectId: lt.id, filedBy: 'ares' });
    expect(filingOf(deleted)).toEqual({ projectId: lt.id, filedBy: 'user' });
    expect(filingOf(stays)).toEqual({ projectId: lt.id, filedBy: 'user' });
  });

  it('records each move in the Item’s activity log, as the User’s, saying why', () => {
    const { lt, tx, mine } = merging();

    change({ type: 'merge', projectId: tx.id, into: lt.id });

    expect(store.activity({ itemId: mine })[0]).toMatchObject({
      action: 'update',
      by: { kind: 'user' },
      why: 'Merged Tactics (TX) into Longtail (LT)',
      changes: [
        {
          field: 'filing',
          before: { projectId: tx.id, filedBy: 'user' },
          after: { projectId: lt.id, filedBy: 'user' },
        },
      ],
    });
  });

  it('removes the merged Project, freeing its code, and refuses to file anything into it', () => {
    const { lt, tx } = merging();
    change({ type: 'merge', projectId: tx.id, into: lt.id });

    expect(codes({ includeArchived: true })).toEqual(['LT', 'TL']);
    expect(() => addTodo('Late', tx.id)).toThrow(`No Project ${tx.id}`);
    expect(() => create('Taxes', 'TX')).not.toThrow();
  });

  it('can merge an archived Project, or into one', () => {
    const { lt, tx } = merging();
    change({ type: 'archive', projectId: lt.id });

    change({ type: 'merge', projectId: tx.id, into: lt.id });

    expect(countIn(lt.id)).toBe(4);
    expect(codes({ includeArchived: true })).toEqual(['LT', 'TL']);
  });

  it('refuses to merge a Project into itself, or with one that does not exist', () => {
    const { lt } = merging();
    expect(() => change({ type: 'merge', projectId: lt.id, into: lt.id })).toThrow(
      'A Project can’t be merged into itself',
    );
    expect(() => change({ type: 'merge', projectId: lt.id, into: 'nope' })).toThrow('No Project nope');
    expect(() => change({ type: 'merge', projectId: 'nope', into: lt.id })).toThrow('No Project nope');
  });

  it('is undone whole: both Projects as they were, every Item back, each move undone in its log', () => {
    const { lt, tl, tx, mine, aresFiled, deleted, stays } = merging();
    change({ type: 'archive', projectId: tx.id });
    const before = store.projects({ includeArchived: true });
    const merged = change({ type: 'merge', projectId: tx.id, into: lt.id });

    const undone = change({ type: 'undo', changeId: merged.id });

    expect(undone).toMatchObject({ action: 'undo', undoes: merged.id, mergedId: tx.id, moved: 3 });
    expect(store.projects({ includeArchived: true })).toEqual(before);
    expect([countIn(lt.id), countIn(tx.id), countIn(tl.id)]).toEqual([1, 3, 0]);
    expect(filingOf(mine)).toEqual({ projectId: tx.id, filedBy: 'user' });
    expect(filingOf(aresFiled)).toEqual({ projectId: tx.id, filedBy: 'ares' });
    expect(filingOf(deleted)).toEqual({ projectId: tx.id, filedBy: 'user' });
    expect(filingOf(stays)).toEqual({ projectId: lt.id, filedBy: 'user' });
    const [undoEntry, moveEntry] = store.activity({ itemId: mine });
    expect(undoEntry).toMatchObject({ action: 'undo', undoes: moveEntry?.id, by: { kind: 'user' } });
  });

  it('can be redone by undoing the undo', () => {
    const { lt, tx, mine } = merging();
    const merged = change({ type: 'merge', projectId: tx.id, into: lt.id });
    const undone = change({ type: 'undo', changeId: merged.id });

    change({ type: 'undo', changeId: undone.id });

    expect(codes()).toEqual(['LT', 'TL']);
    expect(filingOf(mine)).toEqual({ projectId: lt.id, filedBy: 'user' });
    expect(countIn(lt.id)).toBe(4);
  });

  it('leaves an Item the User has re-filed since where the User put it', () => {
    const { lt, tl, tx, mine, aresFiled } = merging();
    const merged = change({ type: 'merge', projectId: tx.id, into: lt.id });
    store.record(
      { type: 'update', itemId: mine, changes: { filing: { projectId: tl.id, filedBy: 'user' } } },
      user,
    );

    const undone = change({ type: 'undo', changeId: merged.id });

    expect(undone.moved).toBe(2);
    expect(filingOf(mine)).toEqual({ projectId: tl.id, filedBy: 'user' });
    expect(filingOf(aresFiled)).toEqual({ projectId: tx.id, filedBy: 'ares' });
  });

  it('refuses to be undone once another Project has taken the merged code', () => {
    const { lt, tx, mine } = merging();
    const merged = change({ type: 'merge', projectId: tx.id, into: lt.id });
    create('Taxes', 'TX');

    expect(() => change({ type: 'undo', changeId: merged.id })).toThrow(
      'TX is already the Badge code for Taxes',
    );
    expect(filingOf(mine)?.projectId).toBe(lt.id);
  });
});

describe('the Project log', () => {
  it('refuses to undo a creation, an entry already undone, or one that does not exist', () => {
    const created = change({ type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } });
    const lt = created.project;
    if (!lt) throw new Error('No Project');
    const renamed = change({ type: 'update', projectId: lt.id, changes: { name: 'Lighthouse' } });
    change({ type: 'undo', changeId: renamed.id });

    expect(() => change({ type: 'undo', changeId: created.id })).toThrow(
      'Making a Project can’t be undone. Archive it instead',
    );
    expect(() => change({ type: 'undo', changeId: renamed.id })).toThrow('That change is already undone');
    expect(() => change({ type: 'undo', changeId: 999 })).toThrow('No Project change 999');
  });

  it('survives reopening the database', () => {
    const lt = create('Longtail', 'LT');
    const tl = create('Titanlink', 'TL');
    const reordered = change({ type: 'reorder', projectIds: [tl.id, lt.id] });
    store.close();
    store = openItemStore({
      path: join(dir, 'commander.db'),
      snapshotDir: join(dir, 'snapshots'),
      migrationsFolder,
      now: () => clock,
    });

    change({ type: 'undo', changeId: reordered.id });

    expect(codes()).toEqual(['LT', 'TL']);
  });
});
