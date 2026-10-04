import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, type BlockDetail, blockLinkToken } from '@commander/domain';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// `[[` links from Blocks (ADR 0002): a token in a Block's text is a refers-to Link from the Block to a
// day's Daily Note or to a Project, kept in the one Link table and answered by the one backlinks query.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let clock: number;
let store: ItemStore;

const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-block-links-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = open();
  store.saveDailyTemplate({ blocks: [] });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const day = (date: string) => blockLinkToken({ type: 'day', day: date });
const project = (projectId: string) => blockLinkToken({ type: 'project', projectId });

function detail(dailyNoteId: string, fields: Partial<BlockDetail> = {}): BlockDetail {
  return { kind: 'block', dailyNoteId, parentId: null, position: 'a0', text: '', folded: false, ...fields };
}

// Writes a Block into a day's Daily Note and returns its id and the Daily Note's.
function addBlock(date: string, text: string, fields: Partial<BlockDetail> = {}) {
  const noteId = store.ensureDailyNote(date, user).id;
  const id = randomUUID();
  store.record(
    { type: 'create', item: { id, kind: 'block', title: text, detail: detail(noteId, { text, ...fields }) } },
    user,
  );
  return { id, noteId };
}

function setText(blockId: string, text: string) {
  const current = store.get(blockId)?.item.detail;
  if (current?.kind !== 'block') throw new Error('Not a Block');
  return store.record({ type: 'update', itemId: blockId, changes: { detail: { ...current, text } } }, user);
}

function makeProject(name: string, code: string) {
  const made = store.changeProject({ type: 'create', project: { name, code, accent: 'blue' } }).project;
  if (!made) throw new Error('No Project');
  return made.id;
}

const noteOf = (date: string) => store.dailyNotes({ from: date, to: date }).notes[0]?.item.id ?? null;

describe('a [[day]] link from a Block', () => {
  it('is a refers-to Link to that day’s Daily Note, seen from both ends', () => {
    const { noteId: thursday } = addBlock('2026-10-01', 'Kick-off');
    const { id } = addBlock('2026-10-03', `Follow up on ${day('2026-10-01')}`);

    expect(store.get(id)?.links).toMatchObject([
      { type: 'refers-to', to: { id: thursday, kind: 'daily-note', title: 'Thursday 1 October 2026' } },
    ]);
    expect(store.get(thursday)?.backlinks).toMatchObject([
      { type: 'refers-to', from: { id, kind: 'block' } },
    ]);
  });

  it('makes the empty Daily Note of a day that has none yet, so the Link has a target', () => {
    expect(noteOf('2026-10-09')).toBeNull();
    const { id } = addBlock('2026-10-03', `Due ${day('2026-10-09')}`);

    const target = noteOf('2026-10-09');
    expect(target).not.toBeNull();
    expect(store.blocks([target as string])).toEqual([]);
    expect(store.get(id)?.links).toMatchObject([{ to: { id: target } }]);
    expect(store.activity({ itemId: target as string }).map((entry) => entry.action)).toContain('create');
  });

  it('is removed when the token leaves the text, and comes back when that is undone', () => {
    const { noteId: thursday } = addBlock('2026-10-01', 'Kick-off');
    const { id } = addBlock('2026-10-03', `See ${day('2026-10-01')}`);

    const edit = setText(id, 'See');
    expect(store.get(id)?.links).toEqual([]);
    expect(store.get(thursday)?.backlinks).toEqual([]);

    store.record({ type: 'undo', entryId: edit.id }, user);
    expect(store.get(id)?.links).toMatchObject([{ type: 'refers-to', to: { id: thursday } }]);
  });

  it('is one Link however many times the day is mentioned, and each token change is in the activity log', () => {
    const { id } = addBlock('2026-10-03', `${day('2026-10-01')} and again ${day('2026-10-01')}`);
    expect(store.get(id)?.links).toHaveLength(1);

    setText(id, 'gone');
    const actions = store.activity({ itemId: id }).map((entry) => entry.action);
    expect(actions.filter((action) => action === 'link')).toHaveLength(1);
    expect(actions.filter((action) => action === 'unlink')).toHaveLength(1);
  });

  it('keeps its Links when the Block moves under another parent', () => {
    const { noteId: thursday } = addBlock('2026-10-01', 'Kick-off');
    const parent = addBlock('2026-10-03', 'Meetings');
    const { id } = addBlock('2026-10-03', `See ${day('2026-10-01')}`, { position: 'a1' });
    const current = store.get(id)?.item.detail as BlockDetail;

    store.record(
      {
        type: 'update',
        itemId: id,
        changes: { detail: { ...current, parentId: parent.id, position: 'a0' } },
      },
      user,
    );

    expect(store.get(id)?.links).toMatchObject([{ to: { id: thursday } }]);
  });

  it('stays when the Block is deleted (it is a tombstone), but the Block is no longer a mention', () => {
    const { noteId: thursday } = addBlock('2026-10-01', 'Kick-off');
    const { id } = addBlock('2026-10-03', `See ${day('2026-10-01')}`);

    store.record({ type: 'delete', itemId: id }, user);

    expect(store.get(thursday)?.backlinks).toMatchObject([{ from: { id, deletedAt: clock } }]);
    expect(store.mentions({ targets: [{ targetType: 'item', id: thursday }] })).toEqual([]);
  });

  it('survives a restart', () => {
    const { noteId: thursday } = addBlock('2026-10-01', 'Kick-off');
    const { id } = addBlock('2026-10-03', `See ${day('2026-10-01')}`);

    store.close();
    store = open();

    expect(store.get(id)?.links).toMatchObject([{ to: { id: thursday } }]);
  });
});

describe('a [[Project]] link from a Block', () => {
  it('is a refers-to Link to the Project, which is not an Item', () => {
    const longtail = makeProject('Longtail', 'LT');
    const { id } = addBlock('2026-10-03', `Pricing for ${project(longtail)}`);

    expect(store.get(id)?.links).toEqual([
      {
        type: 'refers-to',
        from: expect.objectContaining({ id }),
        to: { kind: 'project', id: longtail, title: 'Longtail', code: 'LT', accent: 'blue', archived: false },
        createdAt: clock,
      },
    ]);
    expect(store.backlinks({ targetType: 'project', id: longtail })).toMatchObject([
      { type: 'refers-to', from: { id } },
    ]);
  });

  it('records the Link with the Project at its other end, and undoing it removes the Link', () => {
    const longtail = makeProject('Longtail', 'LT');
    const { id } = addBlock('2026-10-03', 'Pricing');

    const linked = store.link({ from: id, linkType: 'refers-to', to: longtail, targetType: 'project' }, user);
    expect(linked).toMatchObject({ action: 'link', itemId: id, otherItemId: null, otherProjectId: longtail });

    store.record({ type: 'undo', entryId: linked.id }, user);
    expect(store.backlinks({ targetType: 'project', id: longtail })).toEqual([]);
  });

  it('is only ever a refers-to Link, and only to a Project that exists', () => {
    const longtail = makeProject('Longtail', 'LT');
    const { id } = addBlock('2026-10-03', 'Pricing');

    expect(() =>
      store.link({ from: id, linkType: 'about', to: longtail, targetType: 'project' }, user),
    ).toThrow(/refers-to/);
    expect(() =>
      store.link({ from: id, linkType: 'refers-to', to: 'no-such-project', targetType: 'project' }, user),
    ).toThrow(/No Project/);
  });

  it('works for archived Projects, and ignores a token for a Project that doesn’t exist', () => {
    const old = makeProject('Old work', 'OW');
    store.changeProject({ type: 'archive', projectId: old });
    const { id } = addBlock('2026-10-03', `${project(old)} ${project(randomUUID())}`);

    expect(store.get(id)?.links).toMatchObject([{ to: { id: old, archived: true } }]);
  });

  it('follows a merge: a Link to the merged Project shows and counts as the one kept', () => {
    const longtail = makeProject('Longtail', 'LT');
    const tail = makeProject('Tail', 'TA');
    const { id } = addBlock('2026-10-03', `About ${project(tail)}`);

    const merge = store.changeProject({ type: 'merge', projectId: tail, into: longtail });

    expect(store.get(id)?.links).toMatchObject([{ to: { id: longtail, code: 'LT' } }]);
    expect(store.mentions({ targets: [{ targetType: 'project', id: longtail }] })).toHaveLength(1);

    store.changeProject({ type: 'undo', changeId: merge.id });
    expect(store.mentions({ targets: [{ targetType: 'project', id: longtail }] })).toEqual([]);
    expect(store.mentions({ targets: [{ targetType: 'project', id: tail }] })).toHaveLength(1);
  });
});

describe('mentions', () => {
  it('lists the live Blocks linking to each target with their day, newest day first, in outline order', () => {
    const longtail = makeProject('Longtail', 'LT');
    const { noteId: thursday } = addBlock('2026-10-01', 'Kick-off');
    const a = addBlock('2026-10-02', `First ${day('2026-10-01')}`);
    const b = addBlock('2026-10-03', `Later ${day('2026-10-01')} on ${project(longtail)}`, {
      position: 'a1',
    });
    const c = addBlock('2026-10-03', `Earlier ${day('2026-10-01')}`, { position: 'a0' });

    const found = store.mentions({
      targets: [
        { targetType: 'item', id: thursday },
        { targetType: 'project', id: longtail },
      ],
    });

    expect(found.map((m) => [m.target.id, m.block.id, m.day])).toEqual([
      [thursday, c.id, '2026-10-03'],
      [thursday, b.id, '2026-10-03'],
      [thursday, a.id, '2026-10-02'],
      [longtail, b.id, '2026-10-03'],
    ]);
  });
});

describe('a day’s Daily Note made only as a link target', () => {
  it('still starts from the daily template the first time it is made as today, if nothing was written in it', () => {
    store.saveDailyTemplate({
      blocks: [{ id: 't1', parentId: null, position: 'a0', text: 'Morning', folded: false }],
    });
    addBlock('2026-10-03', `Ship it ${day('2026-10-09')}`);
    const linked = noteOf('2026-10-09') as string;

    const note = store.ensureDailyNote('2026-10-09', user, { fromTemplate: true });

    expect(note.id).toBe(linked);
    expect(store.blocks([linked]).map((block) => block.title)).toEqual(['Morning']);
    // Only once: the day has Blocks now.
    store.ensureDailyNote('2026-10-09', user, { fromTemplate: true });
    expect(store.blocks([linked])).toHaveLength(1);
  });

  it('does not, once the User has written in it (even if they deleted it all since)', () => {
    store.saveDailyTemplate({
      blocks: [{ id: 't1', parentId: null, position: 'a0', text: 'Morning', folded: false }],
    });
    const { id } = addBlock('2026-10-09', 'Written ahead');
    store.record({ type: 'delete', itemId: id }, user);

    store.ensureDailyNote('2026-10-09', user, { fromTemplate: true });

    expect(store.blocks([noteOf('2026-10-09') as string])).toEqual([]);
  });
});

describe('upgrading a database made before Links could point at Projects', () => {
  it('keeps every Link between Items', () => {
    // A copy of the migrations up to the one before this change.
    const older = join(dir, 'older-migrations');
    cpSync(migrationsFolder, older, { recursive: true });
    const journalPath = join(older, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((entry) => entry.tag.endsWith('_link_targets'));
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }));
    store.close();
    const path = join(dir, 'upgraded.db');
    const old = new Database(path);
    migrate(drizzle(old), { migrationsFolder: older });
    old.exec(`
      INSERT INTO items (id, kind, title, people, status, created_at, updated_at)
        VALUES ('todo', 'todo', 'Reply', '[]', 'open', 1, 1), ('email', 'email', 'Hi', '[]', 'open', 1, 1);
      INSERT INTO links (from_item_id, type, to_item_id, created_at) VALUES ('todo', 'made-from', 'email', 1);
    `);
    old.close();

    store = openItemStore({ path, snapshotDir: join(dir, 'snapshots'), migrationsFolder, now: () => clock });

    expect(store.get('todo')?.links).toMatchObject([
      { type: 'made-from', to: { id: 'email', kind: 'email' } },
    ]);
    expect(store.backlinks({ targetType: 'item', id: 'email' })).toHaveLength(1);
  });
});
