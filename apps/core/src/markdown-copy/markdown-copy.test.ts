import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type BlockDetail,
  blockLinkToken,
  type CoreMarkdownCopyReply,
  type CoreMessage,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGate } from '../autonomy/gate';
import { type ItemStore, openItemStore } from '../item-store';
import { type MarkdownCopy, READ_ONLY_NOTICE, setUpMarkdownCopy } from '.';

// The Markdown copy (#53) against a real Item store: what gets written where, and when.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const user: ActionContext = { by: { kind: 'user' } };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let dataDir: string;
let folder: string;
let store: ItemStore;
let copy: MarkdownCopy;
let sent: (CoreMessage | CoreMarkdownCopyReply)[];

function setUp(debounceMs = 30) {
  copy = setUpMarkdownCopy({
    store,
    dataDir,
    attachmentsDir: join(dataDir, 'attachments'),
    send: (message) => sent.push(message),
    debounceMs,
    retryMs: 60_000,
  });
  return copy;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'commander-markdown-copy-data-'));
  folder = mkdtempSync(join(tmpdir(), 'commander-markdown-copy-vault-'));
  store = openItemStore({
    path: join(dataDir, 'commander.db'),
    snapshotDir: join(dataDir, 'snapshots'),
    migrationsFolder,
  });
  store.saveDailyTemplate({ blocks: [] });
  sent = [];
  setUp();
});

afterEach(() => {
  copy.stop();
  store.close();
  chmodSync(folder, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

function detail(dailyNoteId: string, fields: Partial<BlockDetail> = {}): BlockDetail {
  return { kind: 'block', dailyNoteId, parentId: null, position: 'a0', text: '', folded: false, ...fields };
}

function addBlock(day: string, text: string, fields: Partial<BlockDetail> = {}) {
  const noteId = store.ensureDailyNote(day, user).id;
  const id = randomUUID();
  store.record(
    { type: 'create', item: { id, kind: 'block', title: text, detail: detail(noteId, { text, ...fields }) } },
    user,
  );
  return id;
}

function setText(blockId: string, text: string) {
  const current = store.get(blockId)?.item.detail;
  if (current?.kind !== 'block') throw new Error('Not a Block');
  store.record({ type: 'update', itemId: blockId, changes: { detail: { ...current, text } } }, user);
}

let requests = 0;
function chooseFolder(chosen: string | null) {
  requests += 1;
  copy.handle({ type: 'markdown-copy-request', id: requests, request: { op: 'set-folder', folder: chosen } });
  return sent.find(
    (message): message is CoreMarkdownCopyReply =>
      message.type === 'markdown-copy-reply' && message.id === requests,
  )?.response;
}

const files = (dir = folder) => readdirSync(dir).sort();
const read = (name: string) => readFileSync(join(folder, name), 'utf8');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the Markdown copy', () => {
  it('writes nothing while no folder is chosen', async () => {
    const id = addBlock('2026-10-01', 'Hello');
    copy.itemsChanged([id]);
    await copy.flush();
    expect(files()).toEqual([]);
    expect(copy.status()).toEqual({ folder: null, state: 'off', problem: null, lastWrittenAt: null });
  });

  it('writes one YYYY-MM-DD.md per day with something written when a folder is chosen', async () => {
    addBlock('2026-10-01', '# Morning');
    addBlock('2026-10-03', 'Stand-up notes');
    store.ensureDailyNote('2026-10-05', user); // only a [[day]] link's target: nothing written

    expect(chooseFolder(folder)).toMatchObject({ ok: true, status: { folder, state: 'writing' } });
    await copy.flush();

    expect(files()).toEqual(['2026-10-01.md', '2026-10-03.md']);
    expect(read('2026-10-03.md')).toBe(`${READ_ONLY_NOTICE}\n\n- Stand-up notes\n`);
    expect(copy.status()).toMatchObject({ folder, state: 'ok', problem: null });
    expect(sent).toContainEqual({ type: 'markdown-copy-status', status: copy.status() });
  });

  it('keeps the folder across restarts, and catches up at start-up', async () => {
    chooseFolder(folder);
    await copy.flush();
    copy.stop();
    addBlock('2026-10-02', 'Written while the copy was stopped');

    setUp().start();
    expect(copy.status()).toMatchObject({ folder, state: 'writing' });
    await copy.flush();
    expect(files()).toEqual(['2026-10-02.md']);
  });

  it('rewrites a day’s file a moment after its Blocks change, today or past', async () => {
    const id = addBlock('2026-09-20', 'First draft');
    chooseFolder(folder);
    await copy.flush();

    setText(id, 'Second draft');
    copy.itemsChanged([id]);
    expect(read('2026-09-20.md')).toContain('First draft');
    await wait(150);
    expect(read('2026-09-20.md')).toContain('- Second draft');
  });

  it('writes atomically, leaving no partial files, and touches nothing else in the folder', async () => {
    writeFileSync(join(folder, 'My note.md'), 'mine');
    mkdirSync(join(folder, '.obsidian'));
    writeFileSync(join(folder, '.obsidian', 'app.json'), '{}');
    const id = addBlock('2026-10-01', 'One');
    chooseFolder(folder);
    await copy.flush();
    setText(id, 'Two');
    copy.itemsChanged([id]);
    await copy.flush();

    expect(files()).toEqual(['.obsidian', '2026-10-01.md', 'My note.md']);
    expect(read('My note.md')).toBe('mine');
    expect(readFileSync(join(folder, '.obsidian', 'app.json'), 'utf8')).toBe('{}');
  });

  it('overwrites a file edited by hand on its next write, and reads nothing back', async () => {
    const id = addBlock('2026-10-01', 'From Commander');
    chooseFolder(folder);
    await copy.flush();
    writeFileSync(join(folder, '2026-10-01.md'), '- Edited by hand\n');

    expect(store.blocks([store.ensureDailyNote('2026-10-01', user).id])[0]?.detail).toMatchObject({
      text: 'From Commander',
    });
    setText(id, 'From Commander, again');
    copy.itemsChanged([id]);
    await copy.flush();
    expect(read('2026-10-01.md')).toBe(`${READ_ONLY_NOTICE}\n\n- From Commander, again\n`);
  });

  it('rewrites a day when one of its Todos is ticked', async () => {
    const blockId = addBlock('2026-10-01', 'Send the deck');
    const todoId = randomUUID();
    store.recordAll(
      [
        {
          type: 'create',
          item: {
            id: todoId,
            kind: 'todo',
            title: 'Send the deck',
            detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: todoId, linkType: 'made-from', to: blockId },
      ],
      user,
    );
    chooseFolder(folder);
    await copy.flush();
    expect(read('2026-10-01.md')).toContain('- [ ] Send the deck');

    store.record({ type: 'update', itemId: todoId, changes: { status: 'done' } }, user);
    copy.itemsChanged([todoId]);
    await copy.flush();
    expect(read('2026-10-01.md')).toContain('- [x] Send the deck');
  });

  it('rewrites a day when Ares adds a Todo for one of its Blocks, from what the gate says it changed', async () => {
    const blockId = addBlock('2026-10-01', 'need to send Dana the Q3 numbers');
    chooseFolder(folder);
    await copy.flush();
    expect(read('2026-10-01.md')).toContain('- need to send Dana the Q3 numbers');

    // As the Core wires it: the gate's changes go to the copy as well as to the window.
    const gate = openGate({ itemStore: store, onChange: (itemIds) => copy.itemsChanged(itemIds) });
    gate.registerAction({ action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' });
    gate.propose({
      actionKind: 'organise',
      action: 'suggest-todos',
      section: 'notes',
      itemId: blockId,
      itemActions: [
        {
          type: 'create',
          item: {
            kind: 'todo',
            title: 'Send Dana the Q3 numbers',
            detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: { step: 0 }, linkType: 'made-from', to: blockId },
      ],
      confidence: 0.95,
      reason: 'You wrote it in your Daily Note.',
    });
    await copy.flush();
    expect(read('2026-10-01.md')).toContain('- [ ] need to send Dana the Q3 numbers');
  });

  it('rewrites every day when a Project is renamed, with links to merged Projects by the one kept', async () => {
    const longtail = store.changeProject({
      type: 'create',
      project: { name: 'Longtail', code: 'LT', accent: 'blue' },
    }).project?.id as string;
    const old = store.changeProject({ type: 'create', project: { name: 'Old', code: 'OL', accent: 'red' } })
      .project?.id as string;
    addBlock('2026-10-01', `On ${blockLinkToken({ type: 'project', projectId: longtail })}`);
    addBlock('2026-10-02', `On ${blockLinkToken({ type: 'project', projectId: old })}`);
    store.changeProject({ type: 'merge', projectId: old, into: longtail });
    chooseFolder(folder);
    await copy.flush();
    expect(read('2026-10-02.md')).toContain('- On [[Longtail]]');

    const action = { type: 'update', projectId: longtail, changes: { name: 'Long Tail' } } as const;
    store.changeProject(action);
    copy.afterRequest({ op: 'change-project', action });
    await copy.flush();
    expect(read('2026-10-01.md')).toContain('- On [[Long Tail]]');
    expect(read('2026-10-02.md')).toContain('- On [[Long Tail]]');
  });

  it('writes a new day made from the template', async () => {
    store.saveDailyTemplate({
      blocks: [{ id: 't1', parentId: null, position: 'a0', text: '# Morning', folded: false }],
    });
    chooseFolder(folder);
    await copy.flush();
    store.ensureDailyNote('2026-10-04', user, { fromTemplate: true });
    copy.afterRequest({ op: 'daily-note', day: '2026-10-04', fromTemplate: true });
    await copy.flush();
    expect(read('2026-10-04.md')).toBe(`${READ_ONLY_NOTICE}\n\n# Morning\n`);
  });

  it('copies a day’s images into attachments/ beside the files', async () => {
    const { name } = store.saveAttachment(PNG);
    addBlock('2026-10-01', `![](attachments/${name})`);
    chooseFolder(folder);
    await copy.flush();
    expect(read('2026-10-01.md')).toContain(`- ![](attachments/${name})`);
    expect(files(join(folder, 'attachments'))).toEqual([name]);
    expect(readFileSync(join(folder, 'attachments', name))).toEqual(Buffer.from(PNG));
  });

  it('rewrites a day whose Blocks were all deleted, and never deletes its file', async () => {
    const id = addBlock('2026-10-01', 'Gone soon');
    chooseFolder(folder);
    await copy.flush();
    store.record({ type: 'delete', itemId: id }, user);
    copy.itemsChanged([id]);
    await copy.flush();
    expect(read('2026-10-01.md')).toBe(`${READ_ONLY_NOTICE}\n`);
  });

  it('writes everything again into a new folder, and nothing once turned off', async () => {
    const id = addBlock('2026-10-01', 'One');
    chooseFolder(folder);
    await copy.flush();
    const other = mkdtempSync(join(tmpdir(), 'commander-markdown-copy-other-'));
    try {
      chooseFolder(other);
      await copy.flush();
      expect(files(other)).toEqual(['2026-10-01.md']);

      expect(chooseFolder(null)).toMatchObject({ ok: true, status: { folder: null, state: 'off' } });
      setText(id, 'Two');
      copy.itemsChanged([id]);
      await copy.flush();
      expect(readFileSync(join(other, '2026-10-01.md'), 'utf8')).toContain('- One');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses the app’s own data folder, a folder in it, the whole disk and relative paths', () => {
    for (const refused of [dataDir, join(dataDir, 'attachments'), '/', 'notes']) {
      expect(chooseFolder(refused)).toMatchObject({ ok: false, status: { state: 'off' } });
    }
    expect(store.markdownCopyFolder.read()).toBeNull();
  });

  it('says why when the folder can’t be written, keeps the change, and writes it once fixed', async () => {
    const id = addBlock('2026-10-01', 'One');
    chooseFolder(folder);
    await copy.flush();
    rmSync(folder, { recursive: true, force: true });

    setText(id, 'Two');
    copy.itemsChanged([id]);
    await copy.flush();
    expect(copy.status()).toMatchObject({
      state: 'failed',
      problem: expect.stringContaining('can’t be found'),
    });
    expect(sent.at(-1)).toEqual({ type: 'markdown-copy-status', status: copy.status() });

    mkdirSync(folder);
    await copy.flush();
    expect(copy.status()).toMatchObject({ state: 'ok', problem: null });
    expect(read('2026-10-01.md')).toContain('- Two');
  });

  it.skipIf(process.getuid?.() === 0)('says so when Commander may not write in the folder', async () => {
    addBlock('2026-10-01', 'One');
    chmodSync(folder, 0o500);
    chooseFolder(folder);
    await copy.flush();
    expect(copy.status()).toMatchObject({
      state: 'failed',
      problem: expect.stringContaining('isn’t allowed'),
    });
  });
});
