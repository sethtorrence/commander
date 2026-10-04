import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type ElectronApplication, _electron as electron, expect, type Page } from '@playwright/test';
import { configProvider } from '../src/main/summon';

// Launches the built app with its own throwaway userData folder (--user-data-dir), so tests never
// touch the User's real database or secrets. Commander holds a single-instance lock per folder,
// so tests never collide with each other, with runs in other checkouts, or with a running
// Commander; and an instance on a custom folder keeps its commander-show pid file inside it, so
// tests never signal the real one. Pass the folder from an earlier launch to start Commander
// again on the same data. The tests' input never reaches the system, so Commander is told the User
// is at the machine (COMMANDER_TEST_PRESENCE) rather than reading the machine's real idle time.
export type LaunchedCommander = {
  app: ElectronApplication;
  userDataDir: string;
  // The Electron arguments used, for launching a second instance on the same folder.
  args: string[];
  // The window once it is shown, at the size Commander asks for (see placeWindow). Tests use it
  // rather than app.firstWindow(), unless showing or hiding the window is what they test.
  window: () => Promise<Page>;
  // Quits Commander (app.quit(), like the tray's Quit) and deletes the folder.
  close: () => Promise<void>;
};

export async function launchCommander(
  options: { userDataDir?: string; args?: string[]; env?: Record<string, string> } = {},
): Promise<LaunchedCommander> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const args = ['.', `--user-data-dir=${userDataDir}`, ...(options.args ?? [])];
  const app = await electron.launch({
    args,
    env: { ...(process.env as Record<string, string>), COMMANDER_TEST_PRESENCE: 'here', ...options.env },
  });
  return {
    app,
    userDataDir,
    args,
    window: async () => {
      const page = await app.firstWindow();
      await placeWindow(app);
      return page;
    },
    close: async () => {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

const hyprctl = (args: string[]) => promisify(execFile)('hyprctl', args).then(({ stdout }) => stdout.trim());

/** The workspace Hyprland has Commander's window on, or null while it hasn't mapped it. */
async function hyprlandWorkspace(pid: number): Promise<string | null> {
  const clients = JSON.parse(await hyprctl(['clients', '-j'])) as {
    pid: number;
    workspace: { name: string };
  }[];
  return clients.find((client) => client.pid === pid)?.workspace.name ?? null;
}

const shown = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);

// The window size Commander asks for (main/index.ts), which the tests' layouts are written against.
const WINDOW_SIZE = { width: 1280, height: 800 };

/**
 * Waits until Commander's window is shown at the size it asks for. On Hyprland it first gets a
 * hidden workspace of its own, floating.
 *
 * A tiling compositor sizes the window, not Commander: tiled beside every other window on the
 * User's workspace (other suites' Commanders included), it can be a couple of hundred pixels wide,
 * and it changes size whenever a window opens or closes there. Text then wraps, a Block's text a
 * letter or two to a line, so End, the arrow keys and clicks act on a line that isn't the whole
 * Block; and narrow layouts hide or rearrange controls. Floating on a workspace of its own, it keeps
 * the size it is given, keeps rendering, and stays off the User's screen (Hyprland also un-maximises
 * a window whenever another one opens on its workspace). Commander shows its window once the first
 * frame is painted (reveal.ts), and Hyprland can't move a window it hasn't mapped yet.
 */
export async function placeWindow(app: ElectronApplication): Promise<void> {
  await expect.poll(() => shown(app)).toBe(true);
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const pid = app.process().pid as number;
    await expect.poll(() => hyprlandWorkspace(pid)).not.toBeNull();
    const workspace = `special:commander-e2e-${pid}`;
    const window = `pid:${pid}`;
    // Older Hyprland versions don't know `status`, and those only have the text config.
    const lua = configProvider(await hyprctl(['-j', 'status']).catch(() => '')) === 'lua';
    const dispatch = (luaCall: string, ...text: string[]) =>
      hyprctl(lua ? ['dispatch', luaCall] : ['dispatch', ...text]);
    expect(
      await dispatch(
        `hl.dsp.window.move({ workspace = "${workspace}", follow = false, window = "${window}" })`,
        'movetoworkspacesilent',
        `${workspace},${window}`,
      ),
    ).toBe('ok');
    await expect.poll(() => hyprlandWorkspace(pid)).toBe(workspace);
    expect(
      await dispatch(`hl.dsp.window.float({ action = "set", window = "${window}" })`, 'setfloating', window),
    ).toBe('ok');
  }
  // A floating window takes the size it is given; elsewhere this is the size it already has.
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(width, height);
  }, WINDOW_SIZE);
  const page = await app.firstWindow();
  await expect
    .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual(WINDOW_SIZE);
}
