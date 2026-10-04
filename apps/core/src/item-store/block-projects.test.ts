import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, BlockDetail, Filing, Item, ItemAction } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Block Projects (#51): a Block's own Project, or its parent's all the way up, kept on every Block's
// Item (filed as inherited) so queries and the Project filter work; and Todos made from Blocks, which
// follow their Block's Project until the User files them by hand.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;
let note: string;
let LT: string;
let TX: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-block-projects-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.UTC(2026, 9, 3, 9),
  });
  LT = project('Longtail', 'LT');
  TX = project('Tactics', 'TX');
  note = store.ensureDailyNote('2026-10-03', user).id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(name: string, code: string): string {
  const created = store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project;
  if (!created) throw new Error('No Project');
  return created.id;
}

const own = (projectId: string): Filing => ({ projectId, filedBy: 'user' });
const inherited = (projectId: string): Filing => ({ projectId, filedBy: 'inherited' });

function detail(fields: Partial<Omit<BlockDetail, 'kind'>> = {}): BlockDetail {
  return {
    kind: 'block',
    dailyNoteId: note,
    parentId: null,
    position: 'a0',
    text: '',
    folded: false,
    ...fields,
  };
}

const create = (id: string, fields: Partial<BlockDetail> = {}, filing: Filing = null): ItemAction => ({
  type: 'create',
  item: { id, kind: 'block', title: fields.text ?? '', filing, detail: detail(fields) },
});

function addBlock(fields: Partial<BlockDetail> = {}, filing: Filing = null): string {
  const id = randomUUID();
  store.record(create(id, { text: id.slice(0, 4), ...fields }, filing), user);
  return id;
}

const read = (id: string): Item => {
  const view = store.get(id);
  if (!view) throw new Error(`No Item ${id}`);
  return view.item;
};
const filingOf = (id: string) => read(id).filing;
const blockDetail = (id: string) => read(id).detail as BlockDetail;

function file(id: string, filing: Filing) {
  return store.record({ type: 'update', itemId: id, changes: { filing } }, user);
}

function moveUnder(id: string, parentId: string | null) {
  return store.record(
    { type: 'update', itemId: id, changes: { detail: { ...blockDetail(id), parentId, position: 'b0' } } },
    user,
  );
}

function todoFrom(blockId: string): string {
  const todo = randomUUID();
  store.recordAll(
    [
      {
        type: 'create',
        item: {
          id: todo,
          kind: 'todo',
          title: 'From a Block',
          detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
        },
      },
      { type: 'link', from: todo, linkType: 'made-from', to: blockId },
    ],
    user,
  );
  return todo;
}

describe('a Block’s Project', () => {
  it('is its own when the User files it, and Unfiled at the top without one', () => {
    const tagged = addBlock({}, own(LT));
    const plain = addBlock();

    expect(filingOf(tagged)).toEqual(own(LT));
    expect(filingOf(plain)).toBeNull();
  });

  it('is inherited from its parent, recursively, when it has none of its own', () => {
    const parent = addBlock({}, own(LT));
    const child = addBlock({ parentId: parent });
    const grandchild = addBlock({ parentId: child });

    expect(filingOf(child)).toEqual(inherited(LT));
    expect(filingOf(grandchild)).toEqual(inherited(LT));
  });

  it('can be overridden by a child, whose own children then follow it', () => {
    const parent = addBlock({}, own(LT));
    const child = addBlock({ parentId: parent }, own(TX));
    const grandchild = addBlock({ parentId: child });

    expect(filingOf(child)).toEqual(own(TX));
    expect(filingOf(grandchild)).toEqual(inherited(TX));
  });

  it('can’t be said to be inherited from anywhere but the parent', () => {
    const parent = addBlock({}, own(LT));
    const child = addBlock({ parentId: parent }, inherited(TX));

    expect(filingOf(child)).toEqual(inherited(LT));
  });

  it('re-files the children already there when their parent is tagged, except those with their own', () => {
    const parent = addBlock();
    const child = addBlock({ parentId: parent });
    const grandchild = addBlock({ parentId: child });
    const overriding = addBlock({ parentId: parent }, own(TX));
    const underOverriding = addBlock({ parentId: overriding });

    file(parent, own(LT));

    expect(filingOf(child)).toEqual(inherited(LT));
    expect(filingOf(grandchild)).toEqual(inherited(LT));
    expect(filingOf(overriding)).toEqual(own(TX));
    expect(filingOf(underOverriding)).toEqual(inherited(TX));
  });

  it('goes back to inheriting when its own Project is removed, and its children follow', () => {
    const top = addBlock({}, own(TX));
    const parent = addBlock({ parentId: top }, own(LT));
    const child = addBlock({ parentId: parent });

    file(parent, null);

    expect(filingOf(parent)).toEqual(inherited(TX));
    expect(filingOf(child)).toEqual(inherited(TX));

    file(top, null);
    expect([filingOf(top), filingOf(parent), filingOf(child)]).toEqual([null, null, null]);
  });

  it('is inherited again from the new parent when a Block is indented, outdented or moved', () => {
    const lt = addBlock({}, own(LT));
    const tx = addBlock({ position: 'a1' }, own(TX));
    const moving = addBlock({ parentId: lt });
    const underMoving = addBlock({ parentId: moving });

    moveUnder(moving, tx);
    expect(filingOf(moving)).toEqual(inherited(TX));
    expect(filingOf(underMoving)).toEqual(inherited(TX));

    moveUnder(moving, null);
    expect(filingOf(moving)).toBeNull();
    expect(filingOf(underMoving)).toBeNull();
  });

  it('stays its own when the Block moves', () => {
    const tx = addBlock({}, own(TX));
    const moving = addBlock({}, own(LT));
    const child = addBlock({ parentId: moving });

    moveUnder(moving, tx);

    expect(filingOf(moving)).toEqual(own(LT));
    expect(filingOf(child)).toEqual(inherited(LT));
  });

  it('is inherited by Blocks made under a parent in the same change', () => {
    const parent = randomUUID();
    const child = randomUUID();
    store.recordAll([create(parent, {}, own(LT)), create(child, { parentId: parent })], user);

    expect(filingOf(child)).toEqual(inherited(LT));
  });

  it('records each Block it re-files as the User’s, caused by the change, and the change is one entry', () => {
    const parent = addBlock();
    const child = addBlock({ parentId: parent });

    const entries = store.recordAll([{ type: 'update', itemId: parent, changes: { filing: own(LT) } }], user);

    expect(entries).toHaveLength(1);
    const [cascade] = store.activity({ itemId: child, limit: 1 });
    expect(cascade).toMatchObject({
      by: { kind: 'user' },
      action: 'update',
      why: 'Follows its parent Block',
      causedBy: { entryId: entries[0]?.id, itemId: parent },
      changes: [{ field: 'filing', before: null, after: inherited(LT) }],
    });
  });

  it('is put back, with its children’s, when tagging is undone, and again when that is redone', () => {
    const parent = addBlock();
    const child = addBlock({ parentId: parent });
    const tagging = file(parent, own(LT));

    const undo = store.record({ type: 'undo', entryId: tagging.id }, user);
    expect([filingOf(parent), filingOf(child)]).toEqual([null, null]);

    store.record({ type: 'undo', entryId: undo.id }, user);
    expect([filingOf(parent), filingOf(child)]).toEqual([own(LT), inherited(LT)]);
  });

  it('is put back, with its children’s, when a move is undone', () => {
    const lt = addBlock({}, own(LT));
    const moving = addBlock();
    const child = addBlock({ parentId: moving });
    const move = moveUnder(moving, lt);
    expect(filingOf(child)).toEqual(inherited(LT));

    store.record({ type: 'undo', entryId: move.id }, user);

    expect([filingOf(moving), filingOf(child)]).toEqual([null, null]);
  });

  it('is what search filters by, for the Blocks re-filed along with a parent too', () => {
    const parent = addBlock({ text: 'Planning' });
    const child = addBlock({ text: 'Standup notes', parentId: parent });
    const found = (projectId: string) =>
      store.search.query({ text: 'standup', projectId }).hits.map((hit) => hit.item.id);

    file(parent, own(LT));
    expect(found(LT)).toEqual([child]);

    moveUnder(child, null);
    expect(found(LT)).toEqual([]);
  });

  it('comes from the shorthand in a daily template Block copied into a new day', () => {
    store.saveDailyTemplate({
      blocks: [
        { id: 't1', parentId: null, position: 'a0', text: 'Longtail #lt', folded: false },
        { id: 't2', parentId: 't1', position: 'a0', text: 'Standup', folded: false },
        { id: 't3', parentId: null, position: 'a1', text: 'Ideas #ZZ', folded: false },
      ],
    });
    const day = store.ensureDailyNote('2026-10-04', user, { fromTemplate: true }).id;
    const byText = new Map(store.blocks([day]).map((block) => [block.title, block.filing]));

    expect(byText.get('Longtail #lt')).toEqual(own(LT));
    expect(byText.get('Standup')).toEqual(inherited(LT));
    expect(byText.get('Ideas #ZZ')).toBeNull();
  });
});

describe('a Todo made from a Block', () => {
  it('takes its Block’s Project, as inherited', () => {
    const parent = addBlock({}, own(LT));
    const block = addBlock({ parentId: parent });

    expect(filingOf(todoFrom(block))).toEqual(inherited(LT));
    expect(filingOf(todoFrom(addBlock()))).toBeNull();
  });

  it('follows its Block when the Block, or a Block above it, changes Project', () => {
    const parent = addBlock();
    const block = addBlock({ parentId: parent });
    const todo = todoFrom(block);

    file(parent, own(LT));
    expect(filingOf(todo)).toEqual(inherited(LT));

    file(block, own(TX));
    expect(filingOf(todo)).toEqual(inherited(TX));

    moveUnder(block, null);
    file(block, null);
    expect(filingOf(todo)).toBeNull();
  });

  it('stays where the User filed it by hand, whatever its Block does after', () => {
    const block = addBlock({}, own(LT));
    const todo = todoFrom(block);

    file(todo, own(TX));
    file(block, null);
    file(block, own(LT));

    expect(filingOf(todo)).toEqual(own(TX));
  });

  it('stays Unfiled when the User unfiled it by hand while its Block had a Project', () => {
    const block = addBlock({}, own(LT));
    const todo = todoFrom(block);

    file(todo, null);
    file(block, own(TX));

    expect(filingOf(todo)).toBeNull();
  });

  it('follows its Block again once filing it by hand is undone', () => {
    const block = addBlock({}, own(LT));
    const todo = todoFrom(block);
    const byHand = file(todo, own(TX));
    file(block, null);

    store.record({ type: 'undo', entryId: byHand.id }, user);
    expect(filingOf(todo)).toBeNull();

    file(block, own(LT));
    expect(filingOf(todo)).toEqual(inherited(LT));
  });

  it('records following its Block as the User’s, caused by the Block’s change', () => {
    const block = addBlock();
    const todo = todoFrom(block);

    const tagging = file(block, own(LT));

    const [follows] = store.activity({ itemId: todo, limit: 1 });
    expect(follows).toMatchObject({
      why: 'Follows its Block',
      causedBy: { entryId: tagging.id, itemId: block },
      changes: [{ field: 'filing', before: null, after: inherited(LT) }],
    });
  });
});

describe('Blocks by Project', () => {
  it('counts, for each Daily Note with something written, its Projects and whether it has Unfiled Blocks', () => {
    addBlock({ text: 'Longtail' }, own(LT));
    addBlock({ text: '', position: 'a2' });
    const earlier = store.ensureDailyNote('2026-10-02', user).id;
    store.record(create(randomUUID(), { dailyNoteId: earlier, text: 'Loose' }), user);
    store.record(
      create(randomUUID(), { dailyNoteId: earlier, text: 'Tactics', position: 'a1' }, own(TX)),
      user,
    );
    store.ensureDailyNote('2026-10-01', user);

    expect(store.dailyNoteProjects()).toEqual([
      { day: '2026-10-03', projectIds: [LT], unfiled: false },
      { day: '2026-10-02', projectIds: [TX], unfiled: true },
    ]);
  });

  it('lists a Project’s Blocks with something written, newest day first, in outline order', () => {
    const top = addBlock({ text: 'Planning' }, own(LT));
    const second = addBlock({ text: 'Second', position: 'a1' }, own(LT));
    const child = addBlock({ text: 'Under planning', parentId: top });
    addBlock({ text: '', parentId: top, position: 'a1' });
    addBlock({ text: 'Elsewhere', position: 'a2' }, own(TX));
    const earlier = store.ensureDailyNote('2026-10-02', user).id;
    const old = randomUUID();
    store.record(create(old, { dailyNoteId: earlier, text: 'Older' }, own(LT)), user);

    const found = store.projectBlocks(LT);

    expect(found.map(({ block, day }) => [day, block.id])).toEqual([
      ['2026-10-03', top],
      ['2026-10-03', child],
      ['2026-10-03', second],
      ['2026-10-02', old],
    ]);
  });
});
