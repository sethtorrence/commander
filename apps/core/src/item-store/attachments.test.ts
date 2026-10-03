import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, attachmentMarkdown, attachmentMaxBytes } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Pasted images: saved by the Core into attachments/ next to the database, named by their content,
// covered by the daily snapshot, and kept after their Block is deleted until no snapshot needs them.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let clock: number;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-attachments-'));
  clock = Date.UTC(2026, 9, 3, 9);
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// The smallest valid PNG and JPEG headers, with something after them to tell images apart.
const png = (extra = 'pixels') =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(extra)]);
const jpeg = (extra = 'pixels') => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(extra)]);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const attachments = () => (existsSync(join(dir, 'attachments')) ? readdirSync(join(dir, 'attachments')) : []);
const snapshotted = () =>
  existsSync(join(dir, 'snapshots', 'attachments')) ? readdirSync(join(dir, 'snapshots', 'attachments')) : [];

// Puts an image Block in today's Daily Note and returns its id.
function imageBlock(name: string): string {
  const note = store.ensureDailyNote('2026-10-03', user);
  const id = randomUUID();
  const text = attachmentMarkdown(name);
  const detail = {
    kind: 'block' as const,
    dailyNoteId: note.id,
    parentId: null,
    position: 'a0',
    text,
    folded: false,
  };
  store.record({ type: 'create', item: { id, kind: 'block', title: text, detail } }, user);
  return id;
}

describe('saving a pasted image', () => {
  it('writes it to attachments/ next to the database, named by the SHA-256 of its bytes', () => {
    const bytes = png();
    const { name } = store.saveAttachment(bytes);

    expect(name).toBe(`${sha256(bytes)}.png`);
    expect(attachments()).toEqual([name]);
    expect(new Uint8Array(readFileSync(join(dir, 'attachments', name)))).toEqual(bytes);
  });

  it('names a JPEG .jpg, by what the bytes are rather than what the window said', () => {
    expect(store.saveAttachment(jpeg()).name).toMatch(/^[0-9a-f]{64}\.jpg$/);
  });

  it('keeps one file for the same image pasted twice', () => {
    const first = store.saveAttachment(png());
    const again = store.saveAttachment(png());
    expect(again).toEqual(first);
    expect(attachments()).toEqual([first.name]);
  });

  it.each([
    ['text', new Uint8Array(Buffer.from('not an image'))],
    ['SVG', new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))],
    ['nothing', new Uint8Array()],
  ])('refuses %s', (_kind, bytes) => {
    expect(() => store.saveAttachment(bytes)).toThrow(/PNG, JPEG, GIF or WebP/);
    expect(attachments()).toEqual([]);
  });

  it('refuses an image over the size limit', () => {
    const big = new Uint8Array(attachmentMaxBytes + 1);
    big.set(png());
    expect(() => store.saveAttachment(big)).toThrow(/20 MB/);
    expect(attachments()).toEqual([]);
  });
});

describe('attachments and the daily snapshot', () => {
  it('copies the images the snapshot uses next to it', () => {
    const { name } = store.saveAttachment(png());
    imageBlock(name);

    store.takeDailySnapshot();

    expect(snapshotted()).toEqual([name]);
    expect(readFileSync(join(dir, 'snapshots', 'attachments', name))).toEqual(
      readFileSync(join(dir, 'attachments', name)),
    );
  });

  it("keeps a deleted image Block's file, so undo brings the image back, until no snapshot needs it", () => {
    const { name } = store.saveAttachment(png());
    const id = imageBlock(name);
    store.takeDailySnapshot();

    clock += DAY;
    const deleted = store.record({ type: 'delete', itemId: id }, user);
    store.takeDailySnapshot();
    expect(attachments()).toEqual([name]);

    store.record({ type: 'undo', entryId: deleted.id }, user);
    expect(store.blocks([store.ensureDailyNote('2026-10-03', user).id])).toHaveLength(1);
    expect(attachments()).toEqual([name]);

    // Deleted for good: kept while the first day's snapshot is, then gone with it.
    store.record({ type: 'delete', itemId: id }, user);
    for (let day = 0; day < 5; day++) {
      clock += DAY;
      store.takeDailySnapshot();
    }
    expect(attachments()).toEqual([name]);
    expect(snapshotted()).toEqual([name]);

    clock += DAY;
    store.takeDailySnapshot();
    expect(attachments()).toEqual([]);
    expect(snapshotted()).toEqual([]);
  });

  it('keeps an image no Block uses yet for a day after it was pasted', () => {
    const { name } = store.saveAttachment(png());
    clock += DAY / 2;
    store.takeDailySnapshot();
    expect(attachments()).toEqual([name]);

    clock += DAY;
    store.takeDailySnapshot();
    expect(attachments()).toEqual([]);
  });

  it('keeps images still in use', () => {
    const { name } = store.saveAttachment(png());
    imageBlock(name);
    for (let day = 0; day < 10; day++) {
      store.takeDailySnapshot();
      clock += DAY;
    }
    expect(attachments()).toEqual([name]);
    expect(snapshotted()).toEqual([name]);
  });

  it('leaves files it did not make alone', () => {
    store.saveAttachment(png());
    const stray = join(dir, 'attachments', 'notes.txt');
    writeFileSync(stray, 'mine');
    clock += 3 * DAY;
    store.takeDailySnapshot();
    expect(existsSync(stray)).toBe(true);
  });
});
