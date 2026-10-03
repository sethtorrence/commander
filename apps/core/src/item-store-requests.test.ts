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

  it('ignores messages that are not Item store requests', () => {
    expect(answerItemStoreRequest(store, { type: 'heartbeat' })).toBeNull();
    expect(answerItemStoreRequest(store, 'hello')).toBeNull();
  });
});
