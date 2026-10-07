import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, attachmentMarkdown } from '@commander/domain';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import {
  applyPendingRestore,
  HELD_AFTER_RESTORE,
  markForRestore,
  pendingRestore,
  RESTORE_MARKER,
  RestoreRefused,
  restoreSnapshot,
} from './restore';

// Restoring a snapshot (#202): marked by the running Core, made by the next one before it opens the
// database. The current database is kept aside first, the chosen one swapped in with its pasted
// images, and changes still waiting to reach a Source are held for the User to check.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const DAY = 24 * 60 * 60 * 1000;
const gmail = { source: 'gmail', account: 'work@example.com' } as const;

let dir: string;
let clock: number;
const stores: ItemStore[] = [];

// Local noon, so snapshot names read the same in every time zone.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-restore-'));
  clock = new Date(2026, 9, 1, 12).getTime();
});

afterEach(() => {
  closeAll();
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
  stores.push(store);
  return store;
}

function closeAll() {
  for (const store of stores.splice(0)) store.close();
}

const titles = (store: ItemStore) =>
  store
    .query({ kinds: ['email'] })
    .map((item) => item.title)
    .sort();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function imageBlock(store: ItemStore, name: string) {
  const note = store.ensureDailyNote('2026-10-01', user);
  const id = randomUUID();
  const text = attachmentMarkdown(name);
  store.record(
    {
      type: 'create',
      item: {
        id,
        kind: 'block',
        title: text,
        detail: { kind: 'block', dailyNoteId: note.id, parentId: null, position: 'a0', text, folded: false },
      },
    },
    user,
  );
  return id;
}

// A change to an email waiting to reach Gmail, as two-way sync queues one.
function queueChange(itemId: string) {
  const sqlite = new Database(join(dir, 'commander.db'));
  sqlite
    .prepare(
      `INSERT INTO outgoing_changes (account, source, item_id, external_id, field, value, synced, made_at, status)
       VALUES ('work@example.com', 'gmail', ?, 'm1', 'read', 'true', 'false', 1, 'pending')`,
    )
    .run(itemId);
  sqlite.close();
}

// The 1 October snapshot: one email, a change on its way to Gmail, and an image Block.
function firstDay() {
  let store = open();
  const [first] = store.saveFromSource({
    ...gmail,
    items: [{ externalId: 'm1', kind: 'email', title: 'From the first day' }],
  }).created;
  const { name: image } = store.saveAttachment(png);
  const block = imageBlock(store, image);
  closeAll();
  queueChange(first as string);
  store = open();
  store.takeDailySnapshot();
  return { store, first: first as string, image, block };
}

describe('restoring a snapshot', () => {
  it('swaps the snapshot in, with its images, keeping the database as it was aside', () => {
    const { store, first, image, block } = firstDay();
    // The next day: more mail, the image Block deleted, and its file tidied away.
    clock += DAY;
    store.saveFromSource({ ...gmail, items: [{ externalId: 'm2', kind: 'email', title: 'Written later' }] });
    store.record({ type: 'delete', itemId: block }, user);
    rmSync(join(dir, 'attachments', image));
    // Commander quits to relaunch: the database is closed.
    closeAll();

    markForRestore(dir, 'commander-2026-10-01.db');
    expect(pendingRestore(dir)).toBe('commander-2026-10-01.db');
    const outcome = applyPendingRestore({ dataDir: dir, now: () => clock });
    expect(outcome).toEqual({
      ok: true,
      name: 'commander-2026-10-01.db',
      at: clock,
      keptAside: join(dir, 'snapshots', 'commander-before-restore-2026-10-02-120000.db'),
      missingImages: 0,
    });
    expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);

    const restored = open();
    expect(titles(restored)).toEqual(['From the first day']);
    // The image the restored Block shows is back in attachments/.
    expect(new Uint8Array(readFileSync(join(dir, 'attachments', image)))).toEqual(png);
    // The change that was on its way may have reached Gmail since: held, for the User to check.
    expect(restored.outgoing.forItem(first).map(({ status, error }) => ({ status, error }))).toEqual([
      { status: 'failed', error: HELD_AFTER_RESTORE },
    ]);

    // Nothing is lost: the database as it was is the newest snapshot.
    const aside = new Database(outcome?.ok ? (outcome.keptAside as string) : '', { readonly: true });
    expect(
      aside.prepare("SELECT title FROM items WHERE kind = 'email' ORDER BY title").pluck().all(),
    ).toEqual(['From the first day', 'Written later']);
    aside.close();
  });

  it('refuses a snapshot that is not one of its own, and marks nothing', () => {
    firstDay();
    closeAll();
    // A copy made by hand, under a name close to Commander's own.
    writeFileSync(join(dir, 'snapshots', 'commander-before-update-2026-10-06.db'), 'theirs');
    for (const name of ['commander-before-update-2026-10-06.db', 'commander-2026-09-01.db'])
      expect(() => markForRestore(dir, name)).toThrow(
        new RestoreRefused('That snapshot is no longer there.'),
      );
    expect(pendingRestore(dir)).toBeNull();
    expect(readFileSync(join(dir, 'snapshots', 'commander-before-update-2026-10-06.db'), 'utf8')).toBe(
      'theirs',
    );
  });

  it('refuses a snapshot that fails its integrity check, leaving the database as it was', () => {
    const { store } = firstDay();
    clock += DAY;
    store.saveFromSource({ ...gmail, items: [{ externalId: 'm2', kind: 'email', title: 'Written later' }] });
    closeAll();
    const failing = () => 'Tree 4 page 9 cell 0: invalid page number';

    expect(() => markForRestore(dir, 'commander-2026-10-01.db', { check: failing })).toThrow(
      /fails its integrity check, so it can’t be restored: Tree 4 page 9/,
    );
    const outcome = restoreSnapshot({ dataDir: dir, name: 'commander-2026-10-01.db', check: failing });
    expect(outcome.ok).toBe(false);
    expect(titles(open())).toEqual(['From the first day', 'Written later']);
    expect(readdirSync(join(dir, 'snapshots')).filter((name) => name.includes('before-restore'))).toEqual([]);
  });

  it('drops the mark of a restore that fails at start-up, so it is never tried again', () => {
    firstDay();
    closeAll();
    markForRestore(dir, 'commander-2026-10-01.db');
    rmSync(join(dir, 'snapshots', 'commander-2026-10-01.db'));

    expect(applyPendingRestore({ dataDir: dir, now: () => clock })).toMatchObject({
      ok: false,
      reason: 'That snapshot is no longer there.',
    });
    expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);
    expect(applyPendingRestore({ dataDir: dir })).toBeNull();
    expect(titles(open())).toEqual(['From the first day']);
  });

  it('keeps a database it cannot read aside as it is, so a broken one is never lost', () => {
    firstDay();
    closeAll();
    for (const suffix of ['-wal', '-shm']) rmSync(join(dir, `commander.db${suffix}`), { force: true });
    writeFileSync(join(dir, 'commander.db'), 'a database that went bad');
    clock += DAY;

    const outcome = restoreSnapshot({ dataDir: dir, name: 'commander-2026-10-01.db', now: () => clock });
    expect(outcome.ok).toBe(true);
    const aside = outcome.ok ? (outcome.keptAside as string) : '';
    expect(readFileSync(aside, 'utf8')).toBe('a database that went bad');
    expect(titles(open())).toEqual(['From the first day']);
  });
});
