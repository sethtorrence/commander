import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { launchCommander } from './launch-commander';

// Commander is always there: closing the window hides it to the tray, the Core keeps running,
// and commander-show (SIGUSR1) or a second launch brings the window back.

const electronBinary = createRequire(import.meta.url)('electron') as string;
const commanderShow = resolve(import.meta.dirname, '../bin/commander-show');

const windows = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()));

const closeWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());

async function beats(window: Page): Promise<number> {
  const heartbeat = window.getByTestId('core-heartbeat');
  await expect(heartbeat).toHaveText(/\d+/, { timeout: 10_000 });
  return Number(await heartbeat.textContent());
}

// The Core runs as a utilityProcess: a child of the main process running Node.
function corePid(mainPid: number): number | undefined {
  const children = execFileSync('pgrep', ['-P', String(mainPid)], { encoding: 'utf8' })
    .trim()
    .split('\n');
  return children.map(Number).find((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('node.mojom.NodeService');
    } catch {
      return false;
    }
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('closing the window hides Commander to the tray, and the Core keeps beating', async () => {
  const commander = await launchCommander();
  const { app } = commander;
  const window = await app.firstWindow();
  await beats(window);

  await closeWindow(app);
  await expect.poll(() => windows(app)).toEqual([false]);
  const atClose = await beats(window);

  await new Promise((done) => setTimeout(done, 3_000));
  expect(await windows(app)).toEqual([false]);

  // SIGUSR1 is what commander-show sends.
  process.kill(app.process().pid as number, 'SIGUSR1');
  await expect.poll(() => windows(app)).toEqual([true]);
  await expect.poll(() => beats(window), { timeout: 5_000 }).toBeGreaterThanOrEqual(atClose + 3);

  await commander.close();
});

test('commander-show brings back a Commander waiting in the tray', async () => {
  test.skip(process.platform !== 'linux', 'commander-show is for Linux');
  // Started at login, Commander waits hidden in the tray.
  const commander = await launchCommander({ args: ['--hidden'] });
  const { app } = commander;
  await app.firstWindow();
  expect(await windows(app)).toEqual([false]);

  // Outside Hyprland's focus step, so the test run doesn't switch the User's workspace.
  const { HYPRLAND_INSTANCE_SIGNATURE: _hyprland, ...outsideHyprland } = process.env;
  const env = { ...outsideHyprland, COMMANDER_PID_FILE: join(commander.userDataDir, 'commander.pid') };
  await new Promise<void>((done, fail) =>
    execFile(commanderShow, [], { env }, (error) => (error ? fail(error) : done())),
  );
  await expect.poll(() => windows(app)).toEqual([true]);

  await commander.close();
});

test('a second launch shows the running window instead of starting another Commander', async () => {
  const commander = await launchCommander();
  const { app } = commander;
  await app.firstWindow();
  await closeWindow(app);
  await expect.poll(() => windows(app)).toEqual([false]);

  const second = spawn(electronBinary, commander.args, { cwd: resolve(import.meta.dirname, '..') });
  const exitCode = await new Promise((done) => second.on('exit', done));
  expect(exitCode).toBe(0);

  await expect.poll(() => windows(app)).toEqual([true]);
  await commander.close();
});

test('Quit stops the Core cleanly and removes the commander-show pid file', async () => {
  test.skip(process.platform !== 'linux', 'reads /proc');
  const commander = await launchCommander();
  const { app } = commander;
  await beats(await app.firstWindow());
  const mainPid = app.process().pid as number;
  const core = corePid(mainPid);
  expect(core).toBeDefined();
  const pidFile = join(commander.userDataDir, 'commander.pid');
  expect(existsSync(pidFile)).toBe(true);

  await app.close(); // app.quit(), as the tray's Quit does

  expect(alive(core as number)).toBe(false);
  expect(alive(mainPid)).toBe(false);
  expect(existsSync(pidFile)).toBe(false);
  // The Core closed its database on the way out: the WAL was checkpointed into commander.db.
  expect(existsSync(join(commander.userDataDir, 'commander.db'))).toBe(true);
  expect(existsSync(join(commander.userDataDir, 'commander.db-wal'))).toBe(false);
  rmSync(commander.userDataDir, { recursive: true, force: true });
});

test('Start at login is off by default and toggles an autostart entry', async () => {
  test.skip(process.platform !== 'linux', 'XDG autostart is for Linux');
  const config = mkdtempSync(join(tmpdir(), 'commander-e2e-config-'));
  const entry = join(config, 'autostart', 'commander.desktop');
  const commander = await launchCommander({ env: { XDG_CONFIG_HOME: config } });
  const toggle = (await commander.app.firstWindow()).getByTestId('start-at-login');

  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  expect(existsSync(entry)).toBe(false);

  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(readFileSync(entry, 'utf8')).toMatch(/^Exec=.* --hidden$/m);

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(existsSync(entry)).toBe(false);

  await commander.close();
  rmSync(config, { recursive: true, force: true });
});
