import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from './item-store';
import { answerItemStoreRequest } from './item-store-requests';

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-requests-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../drizzle'),
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = (id: number, request: unknown) =>
  answerItemStoreRequest(store, { type: 'item-store-request', id, request });

describe('answering Item store requests from the window', () => {
  it('records actions as the User and answers queries', () => {
    const created = ask(1, {
      op: 'record',
      action: { type: 'create', item: { kind: 'todo', title: 'Book flights' } },
      why: 'Typed into the Todos Section',
    });
    const queried = ask(2, { op: 'query', query: { kinds: ['todo'] } });

    expect(created).toMatchObject({
      type: 'item-store-reply',
      id: 1,
      response: {
        ok: true,
        result: { action: 'create', by: { kind: 'user' }, why: 'Typed into the Todos Section' },
      },
    });
    expect(queried).toMatchObject({ id: 2, response: { ok: true, result: [{ title: 'Book flights' }] } });
  });

  it('cannot be used to act as Ares, a Rule or a Source', () => {
    ask(1, {
      op: 'record',
      action: { type: 'create', item: { kind: 'todo', title: 'x' } },
      by: { kind: 'ares' },
    });

    expect(store.activity()[0]?.by).toEqual({ kind: 'user' });
  });

  it('creates and lists Projects, and answers a refused one with its reason', () => {
    const project = { name: 'Longtail', code: 'lt', accent: 'blue' };
    const created = ask(1, { op: 'change-project', action: { type: 'create', project } });
    const again = ask(2, { op: 'change-project', action: { type: 'create', project } });

    expect(created).toMatchObject({
      response: { ok: true, result: { action: 'create', project: { name: 'Longtail', code: 'LT' } } },
    });
    expect(again).toMatchObject({
      response: { ok: false, error: 'LT is already the Badge code for Longtail' },
    });
    expect(ask(3, { op: 'projects' })).toMatchObject({ response: { ok: true, result: [{ code: 'LT' }] } });
  });

  it('answers a failed action with its reason', () => {
    expect(ask(3, { op: 'record', action: { type: 'delete', itemId: 'missing' } })).toEqual({
      type: 'item-store-reply',
      id: 3,
      response: { ok: false, error: 'No Item missing' },
    });
  });

  it('answers a malformed request with an error', () => {
    expect(ask(4, { op: 'drop-table' })).toMatchObject({ id: 4, response: { ok: false } });
  });

  it('keeps Daily Notes and their Blocks, as the User', () => {
    const note = ask(1, { op: 'daily-note', day: '2026-10-03' });
    if (!note?.response.ok) throw new Error('No Daily Note');
    const noteId = (note.response.result as { id: string }).id;
    const blockId = '0b7c2a8e-4f7d-4c11-9a52-0d6b6f0a1e01';

    const recorded = ask(2, {
      op: 'record-all',
      actions: [
        {
          type: 'create',
          item: {
            id: blockId,
            kind: 'block',
            title: '',
            detail: {
              kind: 'block',
              dailyNoteId: noteId,
              parentId: null,
              position: 'a0',
              text: 'Hi',
              folded: false,
            },
          },
        },
      ],
      why: 'Typed in the Daily Note',
    });

    expect(recorded).toMatchObject({
      response: { ok: true, result: [{ action: 'create', itemId: blockId, by: { kind: 'user' } }] },
    });
    expect(ask(3, { op: 'blocks', dailyNoteIds: [noteId] })).toMatchObject({
      response: { ok: true, result: [{ id: blockId, title: 'Hi' }] },
    });
    expect(ask(4, { op: 'daily-notes', query: { withContent: true } })).toMatchObject({
      response: { ok: true, result: { notes: [{ day: '2026-10-03', blocks: 1 }], total: 1 } },
    });
    expect(store.activity({ itemId: noteId })[0]?.by).toEqual({ kind: 'user' });
  });

  it('reads and saves the daily template, and fills a Daily Note made as today from it', () => {
    const template = {
      blocks: [{ id: 'focus', parentId: null, position: 'a0', text: 'Focus', folded: false }],
    };
    expect(ask(1, { op: 'daily-template' })).toMatchObject({
      response: { ok: true, result: { blocks: [{ text: 'Morning' }, {}, {}, {}, { text: 'Evening' }] } },
    });
    expect(ask(2, { op: 'save-daily-template', template })).toMatchObject({
      response: { ok: true, result: template },
    });
    expect(ask(3, { op: 'save-daily-template', template: { blocks: [{ id: 'x' }] } })).toMatchObject({
      response: { ok: false },
    });

    const today = ask(4, { op: 'daily-note', day: '2026-10-03', fromTemplate: true });
    const past = ask(5, { op: 'daily-note', day: '2026-09-28' });
    const idOf = (reply: typeof today) =>
      reply?.response.ok ? (reply.response.result as { id: string }).id : '';

    expect(store.blocks([idOf(today)]).map((item) => item.title)).toEqual(['Focus']);
    expect(store.blocks([idOf(past)])).toEqual([]);
  });

  it('says which Items changed after each recorded change, and nothing after queries or failures', () => {
    const changed: string[][] = [];
    const tell = (request: unknown) =>
      answerItemStoreRequest(store, { type: 'item-store-request', id: 1, request }, (ids) =>
        changed.push(ids),
      );
    const todo = '0b7c2a8e-4f7d-4c11-9a52-0d6b6f0a1e02';
    const other = '0b7c2a8e-4f7d-4c11-9a52-0d6b6f0a1e03';

    tell({ op: 'record', action: { type: 'create', item: { id: todo, kind: 'todo', title: 'A' } } });
    tell({
      op: 'record-all',
      actions: [
        { type: 'create', item: { id: other, kind: 'todo', title: 'B' } },
        { type: 'link', from: todo, linkType: 'refers-to', to: other },
        { type: 'update', itemId: todo, changes: { status: 'done' } },
      ],
    });
    tell({ op: 'query', query: {} });
    tell({ op: 'record', action: { type: 'delete', itemId: 'missing' } });

    expect(changed).toEqual([[todo], [other, todo]]);
  });

  it('finds the Todos made from Blocks', () => {
    const note = store.ensureDailyNote('2026-10-03', { by: { kind: 'user' } });
    const blockId = '0b7c2a8e-4f7d-4c11-9a52-0d6b6f0a1e04';
    const todoId = '0b7c2a8e-4f7d-4c11-9a52-0d6b6f0a1e05';
    const detail = {
      kind: 'block',
      dailyNoteId: note.id,
      parentId: null,
      position: 'a0',
      text: 'Call Dana',
      folded: false,
    };
    ask(1, {
      op: 'record-all',
      actions: [
        { type: 'create', item: { id: blockId, kind: 'block', title: '', detail } },
        {
          type: 'create',
          item: {
            id: todoId,
            kind: 'todo',
            title: 'Call Dana',
            detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: todoId, linkType: 'made-from', to: blockId },
      ],
    });

    expect(ask(2, { op: 'block-todos', query: { dailyNoteIds: [note.id] } })).toMatchObject({
      response: { ok: true, result: [{ todo: { id: todoId }, block: { id: blockId }, day: '2026-10-03' }] },
    });
  });

  it('ignores messages that are not Item store requests', () => {
    expect(answerItemStoreRequest(store, { type: 'heartbeat' })).toBeNull();
    expect(answerItemStoreRequest(store, 'hello')).toBeNull();
  });
});
