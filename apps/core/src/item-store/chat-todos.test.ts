import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// A Todo Ares made from a Teams Chat (#110) keeps the message it came from (`fromMessage`), so its
// made-from Link opens the Chat at that message. Every other Todo has none.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ares: ActionContext = { by: { kind: 'ares' } };
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-chat-todos-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a Todo made from a Chat message', () => {
  it('keeps the Chat and the message, through an edit and its undo', () => {
    const from = { itemId: 'chat-1', messageId: 'msg-7' };
    const { itemId } = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Send Omar the TL budget',
          detail: { kind: 'todo', origin: 'ares', dueOn: '2026-10-08', backedBy: null, fromMessage: from },
        },
      },
      ares,
    );
    expect(store.get(itemId)?.item.detail).toEqual({
      kind: 'todo',
      origin: 'ares',
      dueOn: '2026-10-08',
      backedBy: null,
      fromMessage: from,
    });

    const detail = store.get(itemId)?.item.detail;
    if (detail?.kind !== 'todo') throw new Error('Not a Todo');
    const edit = store.record(
      { type: 'update', itemId, changes: { detail: { ...detail, dueOn: null } } },
      user,
    );
    expect(store.get(itemId)?.item.detail).toMatchObject({ dueOn: null, fromMessage: from });
    store.record({ type: 'undo', entryId: edit.id }, user);
    expect(store.get(itemId)?.item.detail).toMatchObject({ dueOn: '2026-10-08', fromMessage: from });
  });

  it('is absent from every other Todo', () => {
    const { itemId } = store.record(
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Renew passport',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
      user,
    );
    expect(store.get(itemId)?.item.detail).toEqual({
      kind: 'todo',
      origin: 'manual',
      dueOn: null,
      backedBy: null,
    });
  });
});
