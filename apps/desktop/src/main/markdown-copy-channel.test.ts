import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreMarkdownCopyReply, CoreMarkdownCopyRequest, MarkdownCopyStatus } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCopyFolder, createMarkdownCopyChannel } from './markdown-copy-channel';

let root: string;
let userData: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'commander-markdown-copy-main-')));
  userData = join(root, 'userData');
  mkdirSync(userData);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const off: MarkdownCopyStatus = { folder: null, state: 'off', problem: null, lastWrittenAt: null };

type Answer = (request: CoreMarkdownCopyRequest['request']) => CoreMarkdownCopyReply['response'];

// Sets the folder it's given, and says the copy is off otherwise.
const setsFolder: Answer = (request) =>
  request.op === 'set-folder'
    ? { ok: true, status: { ...off, folder: request.folder, state: request.folder ? 'writing' : 'off' } }
    : { ok: true, status: off };

// A channel whose Core answers every request at once, as `answer` says.
function channel(chosen: string | null, answer: Answer = setsFolder) {
  const sent: CoreMarkdownCopyRequest[] = [];
  const copy = createMarkdownCopyChannel({
    userData,
    chooseFolder: async () => chosen,
    send(message) {
      sent.push(message);
      queueMicrotask(() =>
        copy.settle({ type: 'markdown-copy-reply', id: message.id, response: answer(message.request) }),
      );
    },
  });
  return { copy, sent };
}

describe('checking the folder chosen for the Markdown copy', () => {
  it('takes an existing folder, by its real path', () => {
    const vault = join(root, 'vault');
    mkdirSync(vault);
    symlinkSync(vault, join(root, 'link'));
    expect(checkCopyFolder(vault, userData)).toEqual({ ok: true, folder: vault });
    expect(checkCopyFolder(join(root, 'link'), userData)).toEqual({ ok: true, folder: vault });
  });

  it('refuses Commander’s own data folder and anything in it, even through a link', () => {
    mkdirSync(join(userData, 'attachments'));
    symlinkSync(userData, join(root, 'sneaky'));
    for (const path of [userData, join(userData, 'attachments'), join(root, 'sneaky')]) {
      expect(checkCopyFolder(path, userData)).toEqual({
        ok: false,
        error: expect.stringContaining('Commander’s own data folder'),
      });
    }
  });

  it('refuses the whole disk, a file, a missing folder and a relative path', () => {
    writeFileSync(join(root, 'file.md'), '');
    expect(checkCopyFolder('/', userData)).toMatchObject({
      ok: false,
      error: expect.stringContaining('whole disk'),
    });
    expect(checkCopyFolder(join(root, 'file.md'), userData)).toMatchObject({ ok: false });
    expect(checkCopyFolder(join(root, 'nowhere'), userData)).toMatchObject({ ok: false });
    expect(checkCopyFolder('notes', userData)).toMatchObject({ ok: false });
  });
});

describe('the Markdown copy channel in the main process', () => {
  it('hands a folder chosen in the picker to the Core, checked', async () => {
    const vault = join(root, 'vault');
    mkdirSync(vault);
    const { copy, sent } = channel(vault);

    await expect(copy.request({ op: 'choose-folder' })).resolves.toEqual({
      ok: true,
      status: { ...off, folder: vault, state: 'writing' },
    });
    expect(sent.map((message) => message.request)).toEqual([{ op: 'set-folder', folder: vault }]);
  });

  it('changes nothing when the picker is cancelled', async () => {
    const { copy, sent } = channel(null);
    await expect(copy.request({ op: 'choose-folder' })).resolves.toEqual({ ok: true, status: off });
    expect(sent.map((message) => message.request)).toEqual([{ op: 'status' }]);
  });

  it('refuses a clearly wrong folder with the reason, without setting it', async () => {
    const { copy, sent } = channel(userData);
    await expect(copy.request({ op: 'choose-folder' })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('Commander’s own data folder'),
      status: off,
    });
    expect(sent.map((message) => message.request)).toEqual([{ op: 'status' }]);
  });

  it('turns the copy off, and reads how it stands', async () => {
    const { copy, sent } = channel(null);
    await expect(copy.request({ op: 'turn-off' })).resolves.toMatchObject({ ok: true, status: off });
    await expect(copy.request({ op: 'status' })).resolves.toMatchObject({ ok: true, status: off });
    expect(sent.map((message) => message.request)).toEqual([
      { op: 'set-folder', folder: null },
      { op: 'status' },
    ]);
  });

  it('never lets the window name a folder itself', async () => {
    const { copy, sent } = channel(null);
    await expect(copy.request({ op: 'set-folder', folder: root })).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it('passes on the Core’s refusal', async () => {
    const vault = join(root, 'vault');
    mkdirSync(vault);
    const { copy } = channel(vault, () => ({ ok: false, error: 'No', status: off }));
    await expect(copy.request({ op: 'choose-folder' })).resolves.toEqual({
      ok: false,
      error: 'No',
      status: off,
    });
  });

  it('ignores messages that are not its replies', () => {
    const { copy } = channel(null);
    expect(copy.settle({ type: 'heartbeat', beats: 1, at: 1 })).toBe(false);
  });
});
