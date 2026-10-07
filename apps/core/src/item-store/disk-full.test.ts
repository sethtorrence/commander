import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, DISK_FULL } from '@commander/domain';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerItemStoreRequest } from '../item-store-requests';
import { type ItemStore, openItemStore } from '.';
import { DiskFull, guardWrites, isDiskFull, watchDiskFull } from './disk-full';

// A full disk (#203): a write that fails for want of space changes nothing, the Item store stops
// writing (reads go on), the failure reaches the window as DISK_FULL, and writing starts again by
// itself once there is space. The disk is "filled" by capping the connection's size, which makes
// SQLite fail exactly as a full disk does (SQLITE_FULL).

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const CHECK_MS = 1_000;
const BLOCK = randomUUID();

let dir: string;
let store: ItemStore;
let connection: Database.Database;
let space: boolean;
let heard: boolean[];

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'commander-disk-full-'));
  space = true;
  heard = [];
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    hasSpace: () => space,
    diskCheckMs: CHECK_MS,
    onDiskFull: (full) => heard.push(full),
    onConnection: (sqlite) => {
      connection = sqlite;
    },
  });
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

// Fills the "disk": the database can't grow by another page.
function fillDisk() {
  space = false;
  connection.pragma(`max_page_count = ${connection.pragma('page_count', { simple: true })}`);
}
function freeSpace() {
  connection.pragma('max_page_count = 1073741823');
  space = true;
}

let requests = 0;
const ask = (request: unknown) => {
  requests += 1;
  return answerItemStoreRequest(store, { type: 'item-store-request', id: requests, request })?.response;
};

// A Block too big to fit in the pages the database has.
const createBlock = (noteId: string, id: string, text = 'x'.repeat(64 * 1024)) => ({
  op: 'record',
  action: {
    type: 'create',
    item: {
      id,
      kind: 'block',
      title: text,
      detail: { kind: 'block', dailyNoteId: noteId, parentId: null, position: 'a0', text, folded: false },
    },
  },
});

describe('a full disk', () => {
  it('fails the write with nothing changed, and tells the window in its words', () => {
    const note = store.ensureDailyNote('2026-10-06', user);
    const entries = store.activity().length;
    fillDisk();

    expect(ask(createBlock(note.id, BLOCK))).toEqual({ ok: false, error: DISK_FULL });
    expect(store.get(BLOCK)).toBeNull();
    expect(store.activity()).toHaveLength(entries);
    expect(store.diskFull()).toBe(true);
    expect(heard).toEqual([true]);
  });

  it('stops writing until there is space, while reads go on', () => {
    const note = store.ensureDailyNote('2026-10-06', user);
    fillDisk();
    expect(() => store.record(createBlock(note.id, BLOCK).action as never, user)).toThrow(DiskFull);

    // Even a write that would fit is refused at once now: the store is holding writes.
    connection.pragma('max_page_count = 1073741823');
    expect(() => store.saveDailyTemplate({ blocks: [] })).toThrow(DISK_FULL);
    expect(store.query({ kinds: ['daily-note'] }).map((item) => item.id)).toEqual([note.id]);
    expect(heard).toEqual([true]);
  });

  it('starts writing again by itself once there is space, and says so', () => {
    const note = store.ensureDailyNote('2026-10-06', user);
    fillDisk();
    expect(ask(createBlock(note.id, BLOCK))).toMatchObject({ ok: false, error: DISK_FULL });

    vi.advanceTimersByTime(CHECK_MS * 3);
    expect(store.diskFull()).toBe(true);
    expect(ask(createBlock(note.id, BLOCK))).toMatchObject({ ok: false, error: DISK_FULL });

    freeSpace();
    vi.advanceTimersByTime(CHECK_MS);
    expect(store.diskFull()).toBe(false);
    expect(heard).toEqual([true, false]);
    // The same write, made again (as the window does with what it held), goes through.
    expect(ask(createBlock(note.id, BLOCK))).toMatchObject({ ok: true });
    expect(store.get(BLOCK)?.item.title).toHaveLength(64 * 1024);
  });

  it('leaves every other failure as it was', () => {
    expect(ask({ op: 'record', action: { type: 'delete', itemId: 'nowhere' } })).toMatchObject({
      ok: false,
      error: expect.not.stringContaining(DISK_FULL),
    });
    expect(store.diskFull()).toBe(false);
    expect(heard).toEqual([]);
  });
});

describe('guardWrites', () => {
  const sqlite = () => ({ pragma: vi.fn() }) as unknown as Database.Database;

  it('notices a full disk whichever store hit it, sync or async, and passes everything else on', async () => {
    const connection = sqlite();
    const watch = watchDiskFull({ sqlite: connection, hasSpace: () => false });
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const guarded = guardWrites(
      {
        read: () => 'read',
        refuses: () => {
          throw new Error('not that');
        },
        nested: {
          saveImage: () => {
            throw enospc;
          },
        },
        later: async () => {
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
        },
        value: { ok: true },
      },
      (error) => watch.failed(error),
    );

    expect(guarded.read()).toBe('read');
    expect(guarded.value).toEqual({ ok: true });
    expect(() => guarded.refuses()).toThrow('not that');
    expect(watch.full()).toBe(false);
    expect(() => guarded.nested.saveImage()).toThrow(DiskFull);
    expect(watch.full()).toBe(true);
    expect(connection.pragma).toHaveBeenCalledWith('query_only = ON');
    await expect(guarded.later()).rejects.toThrow(DISK_FULL);
    watch.stop();
  });

  it('knows a full disk by its codes', () => {
    expect(isDiskFull(Object.assign(new Error('x'), { code: 'SQLITE_FULL' }))).toBe(true);
    expect(isDiskFull(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(true);
    expect(isDiskFull(new DiskFull())).toBe(true);
    expect(isDiskFull(Object.assign(new Error('x'), { code: 'SQLITE_READONLY' }))).toBe(false);
    expect(isDiskFull(null)).toBe(false);
  });
});
