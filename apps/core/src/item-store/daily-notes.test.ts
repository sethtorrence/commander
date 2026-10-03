import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, BlockDetail, Item } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Daily Notes and their Blocks (ADR 0002): a Daily Note is an Item for one calendar day, and each
// Block is an Item whose detail holds its Daily Note, parent Block, position and text.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-daily-notes-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

type BlockFields = Partial<Omit<BlockDetail, 'kind' | 'dailyNoteId'>> & { id?: string };

// Records a new Block in a Daily Note and returns its id.
function addBlock(dailyNoteId: string, { id = randomUUID(), ...fields }: BlockFields = {}): string {
  store.record(
    { type: 'create', item: { id, kind: 'block', title: '', detail: block(dailyNoteId, fields) } },
    user,
  );
  return id;
}

function block(dailyNoteId: string, fields: BlockFields = {}): BlockDetail {
  const { id: _id, ...rest } = fields;
  return { kind: 'block', dailyNoteId, parentId: null, position: 'a0', text: '', folded: false, ...rest };
}

function detailOf(item: Item | undefined): BlockDetail {
  if (item?.detail?.kind !== 'block') throw new Error('Not a Block');
  return item.detail;
}

// The Blocks of a Daily Note as "text" lines indented by depth, in outline order.
function outline(dailyNoteId: string): string[] {
  const blocks = store.blocks([dailyNoteId]);
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const item of blocks.filter((b) => detailOf(b).parentId === parentId)) {
      lines.push(`${'  '.repeat(depth)}${detailOf(item).text}`);
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

describe('Daily Notes', () => {
  it('are made once per day, recorded as the User’s, and found again by their day', () => {
    const note = store.ensureDailyNote('2026-10-03', user);
    const again = store.ensureDailyNote('2026-10-03', user);

    expect(note).toMatchObject({
      kind: 'daily-note',
      source: null,
      title: 'Saturday 3 October 2026',
      detail: { kind: 'daily-note', day: '2026-10-03' },
    });
    expect(again.id).toBe(note.id);
    expect(store.activity({ itemId: note.id })).toMatchObject([{ action: 'create', by: { kind: 'user' } }]);
  });

  it('survive reopening the database', () => {
    const note = store.ensureDailyNote('2026-10-03', user);
    store.close();
    store = open();

    expect(store.ensureDailyNote('2026-10-03', user).id).toBe(note.id);
  });

  it('refuse a day that is not a calendar date', () => {
    expect(() => store.ensureDailyNote('2026-13-40', user)).toThrow();
    expect(() => store.ensureDailyNote('yesterday', user)).toThrow();
  });

  it('come back when a deleted one is asked for again', () => {
    const note = store.ensureDailyNote('2026-10-03', user);
    store.record({ type: 'delete', itemId: note.id }, user);

    expect(store.ensureDailyNote('2026-10-03', user)).toMatchObject({ id: note.id, deletedAt: null });
  });

  it('are listed newest first, and only those with something written when asked', () => {
    const empty = store.ensureDailyNote('2026-10-02', user);
    for (const day of ['2026-09-29', '2026-10-01', '2026-09-30']) {
      addBlock(store.ensureDailyNote(day, user).id, { text: `Notes for ${day}` });
    }
    addBlock(empty.id, { text: '' });

    expect(store.dailyNotes().notes.map((note) => note.day)).toEqual([
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
    ]);
    expect(store.dailyNotes({ withContent: true })).toMatchObject({
      notes: [{ day: '2026-10-01', blocks: 1 }, { day: '2026-09-30' }, { day: '2026-09-29' }],
      total: 3,
    });
  });

  it('are listed a page at a time, and by a range of days', () => {
    for (const day of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) {
      addBlock(store.ensureDailyNote(day, user).id, { text: 'Something' });
    }

    const page = store.dailyNotes({ withContent: true, before: '2026-10-01', limit: 2 });
    expect(page.notes.map((note) => note.day)).toEqual(['2026-09-30', '2026-09-29']);
    expect(page.total).toBe(3);
    expect(store.dailyNotes({ from: '2026-09-29', to: '2026-09-30' }).notes.map((note) => note.day)).toEqual([
      '2026-09-30',
      '2026-09-29',
    ]);
  });

  it('do not count deleted Blocks as something written', () => {
    const note = store.ensureDailyNote('2026-10-01', user);
    const id = addBlock(note.id, { text: 'Gone soon' });
    store.record({ type: 'delete', itemId: id }, user);

    expect(store.dailyNotes({ withContent: true }).notes).toEqual([]);
  });
});

describe('Blocks', () => {
  let note: string;
  beforeEach(() => {
    note = store.ensureDailyNote('2026-10-03', user).id;
  });

  it('keep the id they were made with, and their text is their title', () => {
    const id = randomUUID();
    const entry = store.record(
      {
        type: 'create',
        item: { id, kind: 'block', title: '', detail: block(note, { text: 'Call Dana' }) },
      },
      user,
    );

    expect(entry).toMatchObject({ action: 'create', itemId: id, by: { kind: 'user' } });
    expect(store.get(id)?.item).toMatchObject({
      id,
      kind: 'block',
      title: 'Call Dana',
      detail: block(note, { text: 'Call Dana' }),
    });
  });

  it('refuse an id that is already taken', () => {
    const id = addBlock(note);

    expect(() => addBlock(note, { id })).toThrow(/already/);
  });

  it('follow their text with their title when it changes', () => {
    const id = addBlock(note, { text: 'Draft' });
    store.record({ type: 'update', itemId: id, changes: { detail: block(note, { text: 'Final' }) } }, user);

    expect(store.get(id)?.item).toMatchObject({ title: 'Final', detail: { text: 'Final' } });
  });

  it('must belong to a Daily Note', () => {
    const todo = store.record({ type: 'create', item: { kind: 'todo', title: 'Not a note' } }, user).itemId;

    expect(() => addBlock(todo)).toThrow(/Daily Note/);
    expect(() => addBlock(randomUUID())).toThrow(/Daily Note/);
    expect(() => store.record({ type: 'create', item: { kind: 'block', title: 'No detail' } }, user)).toThrow(
      /detail/,
    );
  });

  it('nest under one another and come back in outline order', () => {
    const morning = addBlock(note, { text: 'Morning', position: 'a0' });
    const evening = addBlock(note, { text: 'Evening', position: 'a1' });
    addBlock(note, { text: 'Slept badly', parentId: morning, position: 'a1' });
    addBlock(note, { text: 'Coffee first', parentId: morning, position: 'a0' });
    addBlock(note, { text: 'Read', parentId: evening, position: 'a0' });

    expect(outline(note)).toEqual(['Morning', '  Coffee first', '  Slept badly', 'Evening', '  Read']);
  });

  it('refuse a parent that is not a Block of the same Daily Note', () => {
    const other = store.ensureDailyNote('2026-10-02', user).id;
    const elsewhere = addBlock(other, { text: 'Yesterday' });

    expect(() => addBlock(note, { parentId: elsewhere })).toThrow(/same Daily Note/);
    expect(() => addBlock(note, { parentId: note })).toThrow(/same Daily Note/);
  });

  it('move with one change each, carrying their children, and undo puts them back', () => {
    const first = addBlock(note, { text: 'First', position: 'a0' });
    const second = addBlock(note, { text: 'Second', position: 'a1' });
    addBlock(note, { text: 'Child of second', parentId: second, position: 'a0' });

    const move = store.record(
      {
        type: 'update',
        itemId: second,
        changes: { detail: block(note, { text: 'Second', position: 'Zz' }) },
      },
      user,
    );
    expect(outline(note)).toEqual(['Second', '  Child of second', 'First']);

    store.record(
      {
        type: 'update',
        itemId: first,
        changes: { detail: block(note, { text: 'First', parentId: second, position: 'a1' }) },
      },
      user,
    );
    expect(outline(note)).toEqual(['Second', '  Child of second', '  First']);

    store.record({ type: 'undo', entryId: move.id + 1 }, user);
    store.record({ type: 'undo', entryId: move.id }, user);
    expect(outline(note)).toEqual(['First', 'Second', '  Child of second']);
  });

  it('cannot be moved under themselves or their own children', () => {
    const parent = addBlock(note, { text: 'Parent' });
    const child = addBlock(note, { text: 'Child', parentId: parent });

    const under = (itemId: string, parentId: string) =>
      store.record({ type: 'update', itemId, changes: { detail: block(note, { parentId }) } }, user);

    expect(() => under(parent, child)).toThrow(/under itself/);
    expect(() => under(parent, parent)).toThrow(/under itself/);
  });

  it('keep whether they are folded', () => {
    const id = addBlock(note, { text: 'Folded', folded: true });
    store.close();
    store = open();

    expect(detailOf(store.get(id)?.item)).toMatchObject({ folded: true });
  });

  it('leave the outline when deleted, and undo brings them back', () => {
    const keep = addBlock(note, { text: 'Keep', position: 'a0' });
    const drop = addBlock(note, { text: 'Drop', position: 'a1' });

    const deletion = store.record({ type: 'delete', itemId: drop }, user);
    expect(store.blocks([note]).map((item) => item.id)).toEqual([keep]);

    store.record({ type: 'undo', entryId: deletion.id }, user);
    expect(outline(note)).toEqual(['Keep', 'Drop']);
  });

  it('come back from several Daily Notes at once, grouped by note', () => {
    const other = store.ensureDailyNote('2026-10-02', user).id;
    addBlock(other, { text: 'Friday' });
    addBlock(note, { text: 'Saturday' });

    expect(store.blocks([note, other]).map((item) => detailOf(item).text)).toEqual(
      expect.arrayContaining(['Friday', 'Saturday']),
    );
    expect(store.blocks([])).toEqual([]);
  });
});

describe('recording several actions at once', () => {
  it('applies them in order, so a Block can be made under one made just before', () => {
    const note = store.ensureDailyNote('2026-10-03', user).id;
    const parent = randomUUID();
    const child = randomUUID();

    const entries = store.recordAll(
      [
        {
          type: 'create',
          item: { id: parent, kind: 'block', title: '', detail: block(note, { text: 'Parent' }) },
        },
        {
          type: 'create',
          item: {
            id: child,
            kind: 'block',
            title: '',
            detail: block(note, { text: 'Child', parentId: parent }),
          },
        },
      ],
      user,
    );

    expect(entries.map((entry) => [entry.action, entry.itemId])).toEqual([
      ['create', parent],
      ['create', child],
    ]);
    expect(outline(note)).toEqual(['Parent', '  Child']);
  });

  it('applies none of them when one is refused', () => {
    const note = store.ensureDailyNote('2026-10-03', user).id;
    const before = store.activity().length;

    expect(() =>
      store.recordAll(
        [
          { type: 'create', item: { kind: 'block', title: '', detail: block(note, { text: 'Fine' }) } },
          { type: 'delete', itemId: randomUUID() },
        ],
        user,
      ),
    ).toThrow();
    expect(store.blocks([note])).toEqual([]);
    expect(store.activity()).toHaveLength(before);
  });
});

describe('Todos made from Blocks', () => {
  // Makes a Todo from a Block, as `[]` does: the Todo, origin Daily Note, and its made-from Link.
  function makeTodo(blockId: string, title: string): string {
    const todoId = randomUUID();
    store.recordAll(
      [
        {
          type: 'create',
          item: {
            id: todoId,
            kind: 'todo',
            title,
            detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: todoId, linkType: 'made-from', to: blockId },
      ],
      user,
    );
    return todoId;
  }

  it('are found by their Daily Notes or by the Todos, with the Block and its day', () => {
    const friday = store.ensureDailyNote('2026-10-02', user).id;
    const saturday = store.ensureDailyNote('2026-10-03', user).id;
    const call = addBlock(friday, { text: 'Call Dana' });
    addBlock(friday, { text: 'Just a note', position: 'a1' });
    const gift = addBlock(saturday, { text: 'Buy a gift' });
    const callTodo = makeTodo(call, 'Call Dana');
    const giftTodo = makeTodo(gift, 'Buy a gift');

    const fromFriday = store.blockTodos({ dailyNoteIds: [friday] });
    expect(fromFriday.map((found) => [found.todo.id, found.block.id, found.day])).toEqual([
      [callTodo, call, '2026-10-02'],
    ]);
    expect(fromFriday[0]?.todo.detail).toMatchObject({ kind: 'todo', origin: 'daily-note' });
    expect(detailOf(fromFriday[0]?.block).text).toBe('Call Dana');

    const byTodo = store.blockTodos({ todoIds: [giftTodo, callTodo] });
    expect(byTodo.map((found) => `${found.todo.id} ${found.day}`).sort()).toEqual(
      [`${callTodo} 2026-10-02`, `${giftTodo} 2026-10-03`].sort(),
    );
  });

  it('leave out deleted Todos and Todos of deleted Blocks', () => {
    const note = store.ensureDailyNote('2026-10-03', user).id;
    const kept = addBlock(note, { text: 'Kept' });
    const gone = addBlock(note, { text: 'Gone', position: 'a1' });
    const plain = addBlock(note, { text: 'Plain again', position: 'a2' });
    const keptTodo = makeTodo(kept, 'Kept');
    makeTodo(gone, 'Gone');
    const plainTodo = makeTodo(plain, 'Plain again');
    store.record({ type: 'delete', itemId: gone }, user);
    store.record({ type: 'delete', itemId: plainTodo }, user);

    expect(store.blockTodos({ dailyNoteIds: [note] }).map((found) => found.todo.id)).toEqual([keptTodo]);
    expect(store.blockTodos({})).toHaveLength(0);
  });
});
