import type { ItemStore } from '@commander/core/src/item-store';
import { defaultDailyTemplate } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemStoreClient } from '../../item-store/client';
import { openTestItemStore } from '../../item-store/test-item-store';
import { dailyNotesIn } from './daily-notes';
import { createNotebook, type Notebook } from './notebook';
import { visibleBlocks } from './outline';

let store: ItemStore;
let client: ItemStoreClient;
let close: () => void;
let errors: string[];
const notebooks: Notebook[] = [];

beforeEach(() => {
  ({ store, client, close } = openTestItemStore());
  // Most tests here write into an empty day; the daily template's own tests set one.
  store.saveDailyTemplate({ blocks: [] });
  errors = [];
});

afterEach(async () => {
  for (const notebook of notebooks.splice(0)) await notebook.flush();
  vi.useRealTimers();
  close();
});

// A Notebook on the test store, with ids b1, b2… so tests can name the Blocks they make.
function open(today = '2026-10-03', pageSize = 7) {
  let n = 0;
  const notebook = createNotebook(dailyNotesIn(client), {
    today,
    pageSize,
    newId: () => `00000000-0000-4000-8000-${String(++n + notebooks.length * 1000).padStart(12, '0')}`,
    onError: (message) => errors.push(message),
  });
  notebooks.push(notebook);
  return notebook;
}

const dayOf = (notebook: Notebook, day: string) => {
  const found = notebook.snapshot().days.find((d) => d.day === day);
  if (!found) throw new Error(`${day} is not shown`);
  return found;
};

// A day's outline as indented lines.
const lines = (notebook: Notebook, day: string) =>
  visibleBlocks(dayOf(notebook, day).outline, { includeFolded: true }).map(
    ({ block, depth }) => `${'  '.repeat(depth)}${block.folded ? '+ ' : ''}${block.text}`,
  );

// Writes lines into a day as the User would: the first Block, then Enter and typing for the rest.
// Returns the Blocks' ids.
function write(notebook: Notebook, day: string, ...texts: string[]): string[] {
  const ids: string[] = [];
  let caret = notebook.begin(day, texts[0] ?? '');
  ids.push(caret.id);
  for (const text of texts.slice(1)) {
    const current = dayOf(notebook, day).outline.get(caret.id);
    const next = notebook.enter(day, caret.id, current?.text.length ?? 0, current?.text.length ?? 0);
    if (!next) throw new Error('Enter did nothing');
    caret = next;
    notebook.type(day, caret.id, text);
    ids.push(caret.id);
  }
  return ids;
}

const blockItems = () => store.query({ kinds: ['block'] });

describe('opening Notes', () => {
  it('makes today’s Daily Note, and shows it first with the earlier days that have something written', async () => {
    for (const day of ['2026-09-30', '2026-10-01']) {
      const note = store.ensureDailyNote(day, { by: { kind: 'user' } });
      store.record(
        {
          type: 'create',
          item: {
            kind: 'block',
            title: '',
            detail: {
              kind: 'block',
              dailyNoteId: note.id,
              parentId: null,
              position: 'a0',
              text: day,
              folded: false,
            },
          },
        },
        { by: { kind: 'user' } },
      );
    }
    store.ensureDailyNote('2026-10-02', { by: { kind: 'user' } });

    const notebook = open();
    await notebook.start();

    expect(notebook.snapshot().days.map((d) => d.day)).toEqual(['2026-10-03', '2026-10-01', '2026-09-30']);
    expect(store.dailyNotes().notes.map((note) => note.day)).toContain('2026-10-03');
    expect(lines(notebook, '2026-10-01')).toEqual(['2026-10-01']);
    expect(notebook.snapshot().hasMore).toBe(false);
  });

  it('loads earlier days a page at a time', async () => {
    const seed = open('2026-10-10');
    await seed.start();
    for (let date = 1; date <= 9; date++) {
      const day = `2026-10-0${date}`;
      await seed.showDay(day);
      write(seed, day, `Day ${date}`);
    }
    await seed.flush();

    const notebook = open('2026-10-10', 4);
    await notebook.start();
    expect(notebook.snapshot().days.map((d) => d.day)).toEqual([
      '2026-10-10',
      '2026-10-09',
      '2026-10-08',
      '2026-10-07',
      '2026-10-06',
    ]);
    expect(notebook.snapshot()).toMatchObject({ hasMore: true, olderTotal: 9 });

    await notebook.loadMore();
    await notebook.loadMore();
    expect(notebook.snapshot().days).toHaveLength(10);
    expect(notebook.snapshot().hasMore).toBe(false);
  });

  it('adds the new day at the top when the date changes while open', async () => {
    const notebook = open('2026-10-03');
    await notebook.start();
    write(notebook, '2026-10-03', 'Late night');

    await notebook.setToday('2026-10-04');

    expect(notebook.snapshot().today).toBe('2026-10-04');
    expect(notebook.snapshot().days.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-03']);
  });
});

describe('the daily template', () => {
  const template = (...texts: string[]) => ({
    blocks: texts.map((text, i) => ({
      id: `t${i}`,
      parentId: i > 0 && text.startsWith(' ') ? 't0' : null,
      position: `a${i}`,
      text: text.trim(),
      folded: false,
    })),
  });

  it('starts today’s Daily Note with the default Morning, Meetings, Todos, Ideas and Evening', async () => {
    store.saveDailyTemplate(defaultDailyTemplate);
    const notebook = open();
    await notebook.start();

    expect(lines(notebook, '2026-10-03')).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
  });

  it('is not applied again when Notes opens on a day that already has its Daily Note', async () => {
    store.saveDailyTemplate(template('Plan'));
    const first = open();
    await first.start();
    const [plan] = dayOf(first, '2026-10-03').outline.keys();
    first.type('2026-10-03', plan as string, 'Plan, done');
    await first.flush();

    const again = open();
    await again.start();
    expect(lines(again, '2026-10-03')).toEqual(['Plan, done']);
  });

  it('makes the new day from the template when the date rolls over while open', async () => {
    store.saveDailyTemplate(template('Plan', ' Top three'));
    const notebook = open('2026-10-03');
    await notebook.start();
    const [plan] = dayOf(notebook, '2026-10-03').outline.keys();
    notebook.type('2026-10-03', plan as string, 'Plan, late');
    store.saveDailyTemplate(template('Focus'));

    await notebook.setToday('2026-10-04');

    expect(notebook.snapshot().days.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-03']);
    expect(lines(notebook, '2026-10-04')).toEqual(['Focus']);
    expect(lines(notebook, '2026-10-03')).toEqual(['Plan, late', '  Top three']);
  });

  it('leaves a blank past day empty, before and after the User writes in it', async () => {
    store.saveDailyTemplate(template('Plan'));
    const notebook = open();
    await notebook.start();

    await notebook.showDay('2026-09-28');
    expect(lines(notebook, '2026-09-28')).toEqual([]);
    write(notebook, '2026-09-28', 'Remembered later');
    await notebook.flush();

    const reopened = open();
    await reopened.start();
    await reopened.showDay('2026-09-28');
    expect(lines(reopened, '2026-09-28')).toEqual(['Remembered later']);
  });

  it('gives a new day Blocks of its own, which edit like any others', async () => {
    store.saveDailyTemplate(template('Plan'));
    const notebook = open();
    await notebook.start();
    const [id] = dayOf(notebook, '2026-10-03').outline.keys();

    expect(id).not.toBe('t0');
    notebook.type('2026-10-03', id as string, 'Plan the week');
    await notebook.flush();

    expect(store.dailyTemplate()).toEqual(template('Plan'));
    expect(blockItems().map((item) => item.title)).toEqual(['Plan the week']);
  });
});

describe('writing', () => {
  it('saves a small outline, and it comes back with the same ids, order, nesting and folds', async () => {
    const notebook = open();
    await notebook.start();
    const day = '2026-10-03';
    const [morning, coffee, , evening] = write(notebook, day, 'Morning', 'Coffee', 'Walk', 'Evening', 'Read');
    notebook.indent(day, coffee as string, 0);
    const walk = visibleBlocks(dayOf(notebook, day).outline)[2]?.block.id as string;
    notebook.indent(day, walk, 0);
    const read = visibleBlocks(dayOf(notebook, day).outline)[4]?.block.id as string;
    notebook.indent(day, read, 0);
    notebook.toggleFold(day, evening as string);
    notebook.move(day, evening as string, 'up', 0);
    await notebook.flush();

    expect(lines(notebook, day)).toEqual(['+ Evening', '  Read', 'Morning', '  Coffee', '  Walk']);
    const reopened = open();
    await reopened.start();
    expect(lines(reopened, day)).toEqual(lines(notebook, day));
    expect([...dayOf(reopened, day).outline.keys()].sort()).toEqual(
      [...dayOf(notebook, day).outline.keys()].sort(),
    );
    expect(dayOf(reopened, day).outline.get(morning as string)?.text).toBe('Morning');
    expect(errors).toEqual([]);
  });

  it('starts an empty Daily Note with the first thing typed, the caret after it', async () => {
    const notebook = open();
    await notebook.start();

    const caret = notebook.begin('2026-10-03', 'M');

    expect(caret).toEqual({ id: expect.any(String), offset: 1 });
    expect(lines(notebook, '2026-10-03')).toEqual(['M']);
  });

  it('saves typing once per pause, not once per keystroke', async () => {
    vi.useFakeTimers();
    const notebook = open();
    await notebook.start();
    const [id] = write(notebook, '2026-10-03', 'C');
    await vi.runAllTimersAsync();
    const before = store.activity().length;

    for (const text of ['Ca', 'Cal', 'Call', 'Call D', 'Call Da', 'Call Dan', 'Call Dana']) {
      notebook.type('2026-10-03', id as string, text);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(store.activity()).toHaveLength(before);

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.activity()).toHaveLength(before + 1);
    expect(store.get(id as string)?.item.title).toBe('Call Dana');
  });

  it('saves typing it is still holding when asked to (before quitting)', async () => {
    const notebook = open();
    await notebook.start();
    const [id] = write(notebook, '2026-10-03', 'Draft');
    notebook.type('2026-10-03', id as string, 'Draft that must not be lost');

    await notebook.flush();

    expect(store.get(id as string)?.item.title).toBe('Draft that must not be lost');
  });

  it('records each structural change in the activity log as the User’s', async () => {
    const notebook = open();
    await notebook.start();
    const [, second] = write(notebook, '2026-10-03', 'One', 'Two');
    await notebook.flush();
    const before = store.activity().length;

    notebook.indent('2026-10-03', second as string, 0);
    notebook.outdent('2026-10-03', second as string, 0);
    await notebook.flush();

    expect(store.activity().slice(0, store.activity().length - before)).toMatchObject([
      { action: 'update', itemId: second, by: { kind: 'user' }, why: 'Outdent' },
      { action: 'update', itemId: second, by: { kind: 'user' }, why: 'Indent' },
    ]);
  });

  it('removes an empty Block with Backspace, and deletes its Item', async () => {
    const notebook = open();
    await notebook.start();
    const [, empty] = write(notebook, '2026-10-03', 'Keep', '');

    expect(notebook.removeBackward('2026-10-03', empty as string)).toEqual({
      id: expect.any(String),
      offset: 4,
    });
    await notebook.flush();

    expect(lines(notebook, '2026-10-03')).toEqual(['Keep']);
    expect(blockItems().map((item) => item.title)).toEqual(['Keep']);
  });
});

describe('undo and redo', () => {
  it('reverse the last structural change, here and in the Item store', async () => {
    const notebook = open();
    await notebook.start();
    const [, second] = write(notebook, '2026-10-03', 'One', 'Two');
    notebook.indent('2026-10-03', second as string, 3);
    await notebook.flush();
    expect(lines(notebook, '2026-10-03')).toEqual(['One', '  Two']);

    expect(notebook.undo()).toEqual({ id: second, offset: 3 });
    await notebook.flush();
    expect(lines(notebook, '2026-10-03')).toEqual(['One', 'Two']);
    expect(store.activity()[0]).toMatchObject({ action: 'undo', itemId: second, by: { kind: 'user' } });
    const reopened = open();
    await reopened.start();
    expect(lines(reopened, '2026-10-03')).toEqual(['One', 'Two']);

    notebook.redo();
    await notebook.flush();
    expect(lines(notebook, '2026-10-03')).toEqual(['One', '  Two']);
    expect(detailParent(store, second as string)).not.toBeNull();
  });

  it('take back typing a pause at a time, and Enter as one change', async () => {
    const notebook = open();
    await notebook.start();
    const [first] = write(notebook, '2026-10-03', 'Call');
    await notebook.flush();
    notebook.type('2026-10-03', first as string, 'Call Dana tomorrow');
    notebook.enter('2026-10-03', first as string, 9, 9);
    await notebook.flush();
    expect(lines(notebook, '2026-10-03')).toEqual(['Call Dana', ' tomorrow']);

    notebook.undo();
    await notebook.flush();
    expect(lines(notebook, '2026-10-03')).toEqual(['Call Dana tomorrow']);
    expect(blockItems().map((item) => item.title)).toEqual(['Call Dana tomorrow']);

    notebook.undo();
    await notebook.flush();
    expect(lines(notebook, '2026-10-03')).toEqual(['Call']);
    expect(blockItems().map((item) => item.title)).toEqual(['Call']);
  });

  it('do nothing when there is nothing to undo or redo', async () => {
    const notebook = open();
    await notebook.start();

    expect(notebook.undo()).toBeNull();
    expect(notebook.redo()).toBeNull();
  });

  it('forget what could be redone once something new is written', async () => {
    const notebook = open();
    await notebook.start();
    const [, second] = write(notebook, '2026-10-03', 'One', 'Two');
    notebook.indent('2026-10-03', second as string, 0);
    notebook.undo();
    notebook.type('2026-10-03', second as string, 'Two!');

    expect(notebook.redo()).toBeNull();
    await notebook.flush();
    expect(errors).toEqual([]);
  });
});

describe('earlier days', () => {
  it('open blank, and are saved only once the User writes in them', async () => {
    const notebook = open();
    await notebook.start();

    await notebook.showDay('2026-09-28');
    expect(notebook.snapshot().days.map((d) => d.day)).toEqual(['2026-10-03', '2026-09-28']);
    expect(dayOf(notebook, '2026-09-28').noteId).toBeNull();
    expect(store.dailyNotes().notes.map((note) => note.day)).toEqual(['2026-10-03']);

    write(notebook, '2026-09-28', 'Remembered later');
    await notebook.flush();

    expect(store.dailyNotes({ withContent: true }).notes).toMatchObject([{ day: '2026-09-28', blocks: 1 }]);
  });

  it('are found when shown from beyond the loaded pages, and can be edited', async () => {
    const seed = open('2026-10-10');
    await seed.start();
    for (const day of ['2026-10-01', '2026-10-05', '2026-10-08']) {
      await seed.showDay(day);
      write(seed, day, `Notes on ${day}`);
    }
    await seed.flush();

    const notebook = open('2026-10-10', 1);
    await notebook.start();
    await notebook.showDay('2026-10-01');
    expect(notebook.snapshot().days.map((d) => d.day)).toEqual([
      '2026-10-10',
      '2026-10-08',
      '2026-10-05',
      '2026-10-01',
    ]);

    const [id] = [...dayOf(notebook, '2026-10-01').outline.keys()];
    notebook.type('2026-10-01', id as string, 'Edited later');
    await notebook.flush();
    expect(store.get(id as string)?.item.title).toBe('Edited later');
  });

  it('say which days of a week have something written', async () => {
    const notebook = open();
    await notebook.start();
    await notebook.showDay('2026-09-29');
    write(notebook, '2026-09-29', 'Tuesday');
    await notebook.flush();

    expect([...(await notebook.daysWithContent('2026-09-28', '2026-10-04'))]).toEqual(['2026-09-29']);
  });
});

function detailParent(store: ItemStore, id: string) {
  const detail = store.get(id)?.item.detail;
  return detail?.kind === 'block' ? detail.parentId : undefined;
}
