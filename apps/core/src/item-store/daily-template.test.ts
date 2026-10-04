import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, BlockDetail, DailyTemplate, Item, TemplateBlock } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// The daily template: the Blocks a Daily Note made as today starts with, copied as fresh Items.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const asToday = { fromTemplate: true };

let dir: string;
let store: ItemStore;

function open() {
  return openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => Date.UTC(2026, 9, 3, 9),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-daily-template-'));
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function detailOf(item: Item | undefined): BlockDetail {
  if (item?.detail?.kind !== 'block') throw new Error('Not a Block');
  return item.detail;
}

// A Daily Note's Blocks as lines indented by depth ("+ " when folded), in outline order.
function outline(dailyNoteId: string): string[] {
  const blocks = store.blocks([dailyNoteId]);
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const item of blocks.filter((b) => detailOf(b).parentId === parentId)) {
      const { folded, text } = detailOf(item);
      lines.push(`${'  '.repeat(depth)}${folded ? '+ ' : ''}${text}`);
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

const t = (id: string, text: string, fields: Partial<TemplateBlock> = {}): TemplateBlock => ({
  id,
  parentId: null,
  position: 'a0',
  text,
  folded: false,
  ...fields,
});

const nested: DailyTemplate = {
  blocks: [
    t('t-plan', 'Plan', { position: 'a0' }),
    t('t-top3', 'Top three', { parentId: 't-plan', position: 'a0', folded: true }),
    t('t-one', 'One', { parentId: 't-top3', position: 'a0' }),
    t('t-log', 'Log', { position: 'a1' }),
  ],
};

describe('the daily template', () => {
  it('starts as Morning, Meetings, Todos, Ideas and Evening on a fresh database', () => {
    expect(store.dailyTemplate().blocks.map((block) => [block.text, block.parentId])).toEqual([
      ['Morning', null],
      ['Meetings', null],
      ['Todos', null],
      ['Ideas', null],
      ['Evening', null],
    ]);
  });

  it('fills a Daily Note made as today, on a fresh database', () => {
    const note = store.ensureDailyNote('2026-10-03', user, asToday);

    expect(outline(note.id)).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
  });

  it('leaves a Daily Note made for any other reason empty', () => {
    const note = store.ensureDailyNote('2026-09-28', user);

    expect(outline(note.id)).toEqual([]);
  });

  // A Daily Note made ahead of time (a `[[day]]` link to a future day) and never written in still
  // starts from the template when its day comes (#52).
  it('fills a Daily Note that already exists only if it has never held a Block', () => {
    const ahead = store.ensureDailyNote('2026-10-03', user);
    const again = store.ensureDailyNote('2026-10-03', user, asToday);

    expect(again.id).toBe(ahead.id);
    expect(outline(ahead.id)).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
  });

  it('never fills a Daily Note that has held Blocks, even if they were all deleted', () => {
    const written = store.ensureDailyNote('2026-10-03', user);
    const id = randomUUID();
    const detail = {
      kind: 'block' as const,
      dailyNoteId: written.id,
      parentId: null,
      position: 'a0',
      text: 'x',
      folded: false,
    };
    store.record({ type: 'create', item: { id, kind: 'block', title: 'x', detail } }, user);
    store.record({ type: 'delete', itemId: id }, user);

    expect(outline(store.ensureDailyNote('2026-10-03', user, asToday).id)).toEqual([]);
  });

  it('does not fill a deleted Daily Note that comes back', () => {
    const note = store.ensureDailyNote('2026-10-03', user);
    store.record({ type: 'delete', itemId: note.id }, user);

    expect(outline(store.ensureDailyNote('2026-10-03', user, asToday).id)).toEqual([]);
  });

  it('is saved, kept across a restart, and copied with its nesting and folds', () => {
    expect(store.saveDailyTemplate(nested)).toEqual(nested);
    store.close();
    store = open();

    expect(store.dailyTemplate()).toEqual(nested);
    const note = store.ensureDailyNote('2026-10-04', user, asToday);
    expect(outline(note.id)).toEqual(['Plan', '  + Top three', '    One', 'Log']);
  });

  it('gives each day’s copies their own ids, so days are independent of the template and each other', () => {
    store.saveDailyTemplate(nested);
    const monday = store.ensureDailyNote('2026-10-05', user, asToday);
    const tuesday = store.ensureDailyNote('2026-10-06', user, asToday);
    const ids = (noteId: string) => store.blocks([noteId]).map((item) => item.id);

    const templateIds = nested.blocks.map((block) => block.id);
    expect(ids(monday.id)).toHaveLength(4);
    for (const id of ids(monday.id)) expect(templateIds).not.toContain(id);
    expect(ids(tuesday.id).filter((id) => ids(monday.id).includes(id))).toEqual([]);

    // Editing a day's copy leaves the template alone.
    const plan = store.blocks([monday.id]).find((item) => detailOf(item).text === 'Plan');
    if (!plan) throw new Error('No Plan Block');
    store.record(
      { type: 'update', itemId: plan.id, changes: { detail: { ...detailOf(plan), text: 'Plan the week' } } },
      user,
    );
    expect(store.dailyTemplate()).toEqual(nested);
    expect(outline(tuesday.id)[0]).toBe('Plan');
  });

  it('changes only days made after it is edited', () => {
    const today = store.ensureDailyNote('2026-10-03', user, asToday);
    store.saveDailyTemplate(nested);

    expect(outline(today.id)).toEqual(['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening']);
    expect(outline(store.ensureDailyNote('2026-10-04', user, asToday).id)).toEqual([
      'Plan',
      '  + Top three',
      '    One',
      'Log',
    ]);
  });

  it('can be emptied, and new days then start empty', () => {
    store.saveDailyTemplate({ blocks: [] });

    expect(outline(store.ensureDailyNote('2026-10-03', user, asToday).id)).toEqual([]);
  });

  it('records the copies in the activity log as the User’s, from the daily template', () => {
    const note = store.ensureDailyNote('2026-10-03', user, asToday);
    const first = store.blocks([note.id])[0];

    expect(store.activity({ itemId: first?.id })).toMatchObject([
      { action: 'create', by: { kind: 'user' }, why: 'From the daily template' },
    ]);
  });

  it('copies a Block whose parent is gone to the top of the day', () => {
    store.saveDailyTemplate({ blocks: [t('t-a', 'Orphan', { parentId: 'gone' })] });

    expect(outline(store.ensureDailyNote('2026-10-03', user, asToday).id)).toEqual(['Orphan']);
  });

  it('refuses a template with two Blocks under one id', () => {
    expect(() => store.saveDailyTemplate({ blocks: [t('same', 'A'), t('same', 'B')] })).toThrow(/own id/);
  });
});
