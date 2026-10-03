import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

const user: ActionContext = { by: { kind: 'user' } };
let dir: string;
const stores: ItemStore[] = [];

function open() {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  stores.push(store);
  return store;
}

const todo = (title: string) =>
  ({
    type: 'create',
    item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null } },
  }) as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-item-store-'));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('transaction', () => {
  it('keeps every change made inside it when it finishes', () => {
    const store = open();
    const ids = store.transaction(() => [store.record(todo('One'), user), store.record(todo('Two'), user)]);
    expect(ids).toHaveLength(2);
    expect(store.query().map((item) => item.title)).toEqual(expect.arrayContaining(['One', 'Two']));
  });

  it('keeps none of them when it throws', () => {
    const store = open();
    expect(() =>
      store.transaction(() => {
        store.record(todo('One'), user);
        store.record({ type: 'update', itemId: 'missing', changes: { title: 'x' } }, user);
      }),
    ).toThrow(/No Item missing/);
    expect(store.query()).toEqual([]);
    expect(store.activity()).toEqual([]);
  });
});

describe('undone entries', () => {
  it('says which activity entries have been undone', () => {
    const store = open();
    const first = store.record(todo('One'), user);
    const second = store.record(todo('Two'), user);
    store.record({ type: 'undo', entryId: second.id }, user);
    expect(store.undone([first.id, second.id])).toEqual([second.id]);
    expect(store.entry(first.id)).toMatchObject({ id: first.id, action: 'create' });
    expect(store.entry(999)).toBeNull();
  });
});
