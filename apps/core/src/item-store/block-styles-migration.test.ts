import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';
import { migrateAtomically } from './database-health';

// Daily Notes write like Markdown (#239): the migration giving existing notes their line styles. A
// database is built as the version before it left one, with the User's kind of notes (the template's
// sections, a meeting chip with notes under it, Todos, Links and Projects), then migrated.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
// The first migration of #239: the database is built with every migration before it.
const FIRST_OF_239 = 'block_styles';

let dir: string;
let path: string;
let previousMigrations: string;
const stores: ItemStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-block-styles-'));
  path = join(dir, 'commander.db');
  previousMigrations = join(dir, 'previous-drizzle');
  cpSync(migrationsFolder, previousMigrations, { recursive: true });
  const journalPath = join(previousMigrations, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const first = journal.entries.findIndex((entry) => entry.tag.replace(/^\d+_/, '') === FIRST_OF_239);
  expect(first).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, first);
  writeFileSync(journalPath, JSON.stringify(journal));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const AT = new Date(2026, 9, 7, 9, 0).getTime();

// The database as the previous version leaves it, written with its own SQL.
function previousDatabase(write: (sql: (statement: string, ...values: unknown[]) => void) => void) {
  const sqlite = new Database(path);
  migrateAtomically(sqlite, previousMigrations);
  sqlite.pragma('foreign_keys = ON');
  write((statement, ...values) => sqlite.prepare(statement).run(...values));
  sqlite.close();
}

type Sql = (statement: string, ...values: unknown[]) => void;

function item(sql: Sql, id: string, kind: string, title: string, project?: string) {
  sql(
    `INSERT INTO items (id, kind, title, people, project_id, filed_by, status, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?, 'open', ?, ?)`,
    id,
    kind,
    title,
    project ?? null,
    project ? 'user' : null,
    AT,
    AT,
  );
}

function block(
  sql: Sql,
  id: string,
  parentId: string | null,
  position: string,
  text: string,
  project?: string,
) {
  item(sql, id, 'block', text, project);
  sql(
    `INSERT INTO block_details (item_id, daily_note_id, parent_id, position, text, folded)
     VALUES (?, 'note', ?, ?, ?, 0)`,
    id,
    parentId,
    position,
    text,
  );
}

function todoFrom(sql: Sql, todoId: string, blockId: string, title: string) {
  item(sql, todoId, 'todo', title);
  sql(`INSERT INTO todo_details (item_id, origin) VALUES (?, 'daily-note')`, todoId);
  sql(
    `INSERT INTO links (from_item_id, type, to_item_id, created_at) VALUES (?, 'made-from', ?, ?)`,
    todoId,
    blockId,
    AT,
  );
}

function dailyNote(sql: Sql) {
  sql(
    `INSERT INTO projects (id, name, code, accent, position, created_at) VALUES ('lt', 'Longtail', 'LT', 'orange', 0, ?)`,
    AT,
  );
  item(sql, 'note', 'daily-note', '2026-10-07');
  sql(`INSERT INTO daily_note_details (item_id, day) VALUES ('note', '2026-10-07')`);
}

function open() {
  const store = openItemStore({
    path,
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => AT,
  });
  stores.push(store);
  return store;
}

// What the migration must leave alone: every Block's text and place, every Item's Project, every Link
// and every Todo, read straight from the database.
function untouched() {
  const sqlite = new Database(path, { readonly: true });
  try {
    return {
      blocks: sqlite
        .prepare(
          'SELECT item_id, daily_note_id, parent_id, position, text, folded FROM block_details ORDER BY item_id',
        )
        .all(),
      items: sqlite
        .prepare('SELECT id, kind, title, project_id, filed_by, status, deleted_at FROM items ORDER BY id')
        .all(),
      links: sqlite.prepare('SELECT * FROM links ORDER BY id').all(),
      todos: sqlite.prepare('SELECT * FROM todo_details ORDER BY item_id').all(),
      chips: sqlite.prepare('SELECT * FROM meeting_chips').all(),
    };
  } finally {
    sqlite.close();
  }
}

function stylesOf(store: ItemStore): Record<string, string | undefined> {
  return Object.fromEntries(
    store
      .blocks(['note'])
      .map((found) => [found.id, found.detail?.kind === 'block' ? found.detail.style : 'not a Block']),
  );
}

describe('the migration to line styles', () => {
  it('makes template sections subheadings, meetings quotes and Todos checkboxes, losing nothing', () => {
    previousDatabase((sql) => {
      dailyNote(sql);
      // The default template's five sections (the User never saved one of their own).
      block(sql, 'morning', null, 'a0', 'Morning');
      block(sql, 'meetings', null, 'a1', 'Meetings');
      block(sql, 'todos', null, 'a2', 'Todos');
      block(sql, 'ideas', null, 'a3', 'Ideas');
      block(sql, 'evening', null, 'a4', 'Evening');
      // Written under a section, and at the top among them.
      block(sql, 'coffee', 'morning', 'a0', 'Coffee with [[2026-10-08]] in mind');
      block(sql, 'loose', null, 'a5', 'Ideas for lunch');
      block(sql, 'nested-morning', 'ideas', 'a0', 'Morning');
      block(sql, 'blank', null, 'a6', '');
      // A meeting chip Commander made, with the meeting's notes under it, one nested and one a Todo.
      item(sql, 'event', 'event', 'Weekly sync');
      block(sql, 'chip', 'meetings', 'a0', '[[event:event]]', 'lt');
      sql(
        `INSERT INTO meeting_chips (daily_note_id, event_id, block_id, created_at) VALUES ('note', 'event', 'chip', ?)`,
        AT,
      );
      sql(
        `INSERT INTO links (from_item_id, type, to_item_id, created_at) VALUES ('chip', 'refers-to', 'event', ?)`,
        AT,
      );
      block(sql, 'said', 'chip', 'a0', 'Budget is **fine**');
      block(sql, 'said-under', 'said', 'a0', 'Ask [[project:lt]] about Q4');
      sql(
        `INSERT INTO links (from_item_id, type, target_type, to_project_id, created_at) VALUES ('said-under', 'refers-to', 'project', 'lt', ?)`,
        AT,
      );
      block(sql, 'deck', 'chip', 'a1', 'Send the deck');
      todoFrom(sql, 'deck-todo', 'deck', 'Send the deck');
      // A chip the User wrote themselves, by the event's link, with nothing under it.
      item(sql, 'event-2', 'event', 'Standup');
      block(sql, 'own-chip', 'meetings', 'a2', '  [[event:event-2]] standup');
      // A Todo made from a line, and one whose Todo was deleted.
      block(sql, 'flights', 'todos', 'a0', 'Book flights');
      todoFrom(sql, 'flights-todo', 'flights', 'Book flights');
      block(sql, 'gone', 'todos', 'a1', 'Was a Todo');
      todoFrom(sql, 'gone-todo', 'gone', 'Was a Todo');
      sql(`UPDATE items SET deleted_at = ? WHERE id = 'gone-todo'`, AT);
    });
    const before = untouched();

    const store = open();
    expect(stylesOf(store)).toEqual({
      morning: 'heading-2',
      meetings: 'heading-2',
      todos: 'heading-2',
      ideas: 'heading-2',
      evening: 'heading-2',
      coffee: 'plain',
      loose: 'plain',
      'nested-morning': 'plain',
      blank: 'plain',
      chip: 'quote',
      said: 'quote',
      'said-under': 'quote',
      deck: 'todo',
      'own-chip': 'quote',
      flights: 'todo',
      gone: 'plain',
    });
    store.close();
    stores.length = 0;
    expect(untouched()).toEqual(before);

    // As the Notes Section reads them: the Todos still on their Blocks, the Projects still filed.
    const again = open();
    expect(
      again
        .blockTodos({ dailyNoteIds: ['note'] })
        .map(({ todo, block }) => [todo.id, block.id])
        .sort(),
    ).toEqual([
      ['deck-todo', 'deck'],
      ['flights-todo', 'flights'],
    ]);
    expect(again.get('chip')?.item.filing).toEqual({ projectId: 'lt', filedBy: 'user' });
  });

  it('takes the sections from the template the User saved, and gives its Blocks styles too', () => {
    const template = {
      blocks: [
        { id: 't1', parentId: null, position: 'a0', text: 'Plan', folded: false },
        { id: 't2', parentId: 't1', position: 'a0', text: 'Top three', folded: false },
        { id: 't3', parentId: null, position: 'a1', text: 'Meetings', folded: false },
        { id: 't4', parentId: null, position: 'a2', text: '', folded: false },
      ],
    };
    previousDatabase((sql) => {
      sql(
        `INSERT INTO daily_template (id, template, updated_at) VALUES (1, ?, ?)`,
        JSON.stringify(template),
        AT,
      );
      dailyNote(sql);
      block(sql, 'plan', null, 'a0', 'Plan');
      block(sql, 'top', 'plan', 'a0', 'Top three');
      block(sql, 'meetings', null, 'a1', 'Meetings');
      // A default section the User's template doesn't have.
      block(sql, 'morning', null, 'a2', 'Morning');
    });

    const store = open();
    expect(stylesOf(store)).toEqual({
      plan: 'heading-2',
      top: 'plain',
      meetings: 'heading-2',
      morning: 'plain',
    });
    expect(store.dailyTemplate()).toEqual({
      blocks: [
        { ...template.blocks[0], style: 'heading-2' },
        { ...template.blocks[1], style: 'plain' },
        { ...template.blocks[2], style: 'heading-2' },
        { ...template.blocks[3], style: 'plain' },
      ],
    });
  });
});
