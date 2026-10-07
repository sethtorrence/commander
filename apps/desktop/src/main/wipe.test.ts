import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWipeChannel, wipeDataFolder, wipeLogs, wipeMarkdownCopy } from './wipe';
import { clearSafeStorageKey } from './wipe-keyring';

// Wipe all Commander data (#204), in the main process, always on throwaway folders: what goes from the
// data folder (only Commander's own), from the Markdown copy's folder (only the files it wrote, and
// only when asked), and in what order the Core stops, the files go and Commander relaunches.

const HASH = 'a'.repeat(64);

let root: string;
let userData: string;
let vault: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'commander-wipe-'));
  userData = join(root, 'userData');
  vault = join(root, 'vault');
  mkdirSync(userData);
  mkdirSync(vault);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text = 'x') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

// A data folder as Commander and Electron leave it.
function fillDataFolder() {
  for (const name of [
    'commander.db',
    'commander.db-wal',
    'commander.db-shm',
    'commander.db.restoring',
    'restore-pending.json',
    'secrets.json',
    'secrets.json.0a1b2c.tmp',
    'accounts.json',
    'snapshots/commander-2026-10-06.db',
    'snapshots/commander-before-update-2026-10-05-101500.db',
    'attachments/image.png',
    'email-parts/google:alex/m1/2',
    'compose-files/1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    'models/granite-embedding-97m-multilingual-r2/model.onnx',
    'logs/main.log',
    'logs/core.1.log',
    // Electron's own.
    'Local State',
    'Preferences',
    'Local Storage/leveldb/000003.log',
    'GPUCache/data_0',
    'commander-notes.txt',
  ])
    write(join(userData, name));
}

describe('wipeDataFolder', () => {
  it('deletes everything Commander keeps in its data folder, by name, and nothing of Electron’s', () => {
    fillDataFolder();

    const gone = wipeDataFolder(userData);

    expect(gone).toEqual([
      'accounts.json',
      'attachments',
      'commander.db',
      'commander.db-shm',
      'commander.db-wal',
      'commander.db.restoring',
      'compose-files',
      'email-parts',
      'models',
      'restore-pending.json',
      'secrets.json',
      'secrets.json.0a1b2c.tmp',
      'snapshots',
    ]);
    // The logs go last of all (wipeLogs), as Commander quits.
    expect(readdirSync(userData).sort()).toEqual([
      'GPUCache',
      'Local State',
      'Local Storage',
      'Preferences',
      'commander-notes.txt',
      'logs',
    ]);
    wipeLogs(userData);
    expect(existsSync(join(userData, 'logs'))).toBe(false);
  });

  it('does nothing for a folder that isn’t there', () => {
    expect(wipeDataFolder(join(root, 'missing'))).toEqual([]);
  });
});

describe('wipeMarkdownCopy', () => {
  it('deletes only the day files and images the copy wrote, leaving the rest of a vault as it was', () => {
    write(join(vault, '2026-10-05.md'));
    write(join(vault, '2026-10-06.md'));
    write(join(vault, '.2026-10-06.md.9f8e7d.tmp'));
    write(join(vault, `attachments/${HASH}.png`));
    write(join(vault, 'Ideas.md'));
    write(join(vault, '.obsidian/app.json'));
    write(join(vault, 'attachments/holiday.jpg'));

    expect(wipeMarkdownCopy(vault)).toBe(4);

    expect(readdirSync(vault).sort()).toEqual(['.obsidian', 'Ideas.md', 'attachments']);
    expect(readdirSync(join(vault, 'attachments'))).toEqual(['holiday.jpg']);
  });

  it('removes the folder once nothing else is in it', () => {
    write(join(vault, '2026-10-06.md'));
    write(join(vault, `attachments/${HASH}.webp`));

    wipeMarkdownCopy(vault);

    expect(existsSync(vault)).toBe(false);
  });
});

describe('the wipe channel', () => {
  function channel(overrides: Partial<Parameters<typeof createWipeChannel>[0]> = {}) {
    const steps: string[] = [];
    const wipe = createWipeChannel({
      userData,
      markdownCopyFolder: async () => {
        steps.push('asked where the copy is');
        return vault;
      },
      stopCore: async () => {
        // The Core is stopped before anything is deleted.
        steps.push(`stopped the Core (database there: ${existsSync(join(userData, 'commander.db'))})`);
      },
      clearWindowStorage: async () => {
        steps.push('cleared the window’s storage');
      },
      clearKeyring: async () => {
        steps.push('deleted the keyring entry');
      },
      relaunch: () => steps.push('relaunched'),
      log: () => {},
      relaunchAfterMs: 0,
      ...overrides,
    });
    return { wipe, steps };
  }

  it('refuses without the confirmation word, and touches nothing', async () => {
    fillDataFolder();
    const { wipe, steps } = channel();

    await expect(wipe.request({ confirmation: 'yes', markdownCopy: false })).resolves.toEqual({
      ok: false,
      error: 'Type “wipe” to confirm.',
    });
    await expect(wipe.request({ confirmation: 'wipe' })).resolves.toMatchObject({ ok: false });

    expect(steps).toEqual([]);
    expect(existsSync(join(userData, 'commander.db'))).toBe(true);
  });

  it('stops the Core, deletes everything, clears the window and the keyring entry, then relaunches', async () => {
    vi.useFakeTimers();
    fillDataFolder();
    write(join(vault, '2026-10-06.md'));
    const { wipe, steps } = channel();

    await expect(wipe.request({ confirmation: ' Wipe ', markdownCopy: false })).resolves.toEqual({
      ok: true,
      relaunching: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(steps).toEqual([
      'stopped the Core (database there: true)',
      'cleared the window’s storage',
      'deleted the keyring entry',
      'relaunched',
    ]);
    expect(existsSync(join(userData, 'commander.db'))).toBe(false);
    expect(existsSync(join(userData, 'secrets.json'))).toBe(false);
    // Unticked: the Markdown copy stays.
    expect(existsSync(join(vault, '2026-10-06.md'))).toBe(true);
    // Once only.
    await expect(wipe.request({ confirmation: 'wipe', markdownCopy: false })).resolves.toMatchObject({
      ok: false,
      error: 'Commander is already wiping its data.',
    });
  });

  it('deletes the Markdown copy too when ticked, asking the Core where it is before stopping it', async () => {
    write(join(vault, '2026-10-06.md'));
    write(join(vault, 'Ideas.md'));
    const { wipe, steps } = channel();

    await wipe.request({ confirmation: 'wipe', markdownCopy: true });

    expect(steps.slice(0, 2)).toEqual([
      'asked where the copy is',
      'stopped the Core (database there: false)',
    ]);
    expect(readdirSync(vault)).toEqual(['Ideas.md']);
  });

  it('leaves the keyring entry for a Commander on a data folder of its own, and still relaunches', async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const { wipe, steps } = channel({ clearKeyring: null, log: (message) => logged.push(message) });

    await wipe.request({ confirmation: 'wipe', markdownCopy: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(steps).not.toContain('deleted the keyring entry');
    expect(steps.at(-1)).toBe('relaunched');
    expect(logged).toContain('Left the keyring entry: this Commander runs on a data folder of its own');
  });

  it('relaunches even when the window’s storage or the keyring can’t be cleared', async () => {
    vi.useFakeTimers();
    const { wipe, steps } = channel({
      clearWindowStorage: () => Promise.reject(new Error('busy')),
      clearKeyring: () => Promise.reject(new Error('no secret-tool')),
    });

    await expect(wipe.request({ confirmation: 'wipe', markdownCopy: false })).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(steps.at(-1)).toBe('relaunched');
  });
});

describe('clearSafeStorageKey', () => {
  it('asks the Secret Service to delete the entry stored under the app’s name, on Linux only', async () => {
    const calls: [string, string[]][] = [];
    const command = async (file: string, args: string[]) => {
      calls.push([file, args]);
    };

    await clearSafeStorageKey('@commander/desktop', { platform: 'linux', command });
    await clearSafeStorageKey('@commander/desktop', { platform: 'darwin', command });

    expect(calls).toEqual([['secret-tool', ['clear', 'application', '@commander/desktop']]]);
  });
});
