import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { configProvider } from '../src/main/summon';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';

// The window has no Electron or system frame: the header is the title bar, and its window controls
// reach main through the preload bridge.

const visible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()));

const minimised = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized());

const summon = (app: ElectronApplication) => process.kill(app.process().pid as number, 'SIGUSR1');

async function beats(window: Page): Promise<number> {
  const heartbeat = window.getByTestId('core-heartbeat');
  await expect(heartbeat).toHaveText(/\d+/, { timeout: 10_000 });
  return Number(await heartbeat.textContent());
}

const hyprctl = (args: string[]) => promisify(execFile)('hyprctl', args).then(({ stdout }) => stdout.trim());

// The workspace Hyprland has the window on, or null while it hasn't mapped it.
async function hyprlandWorkspace(pid: number): Promise<string | null> {
  const clients = JSON.parse(await hyprctl(['clients', '-j'])) as {
    pid: number;
    workspace: { name: string };
  }[];
  return clients.find((client) => client.pid === pid)?.workspace.name ?? null;
}

// Commander shows its window only once the first frame is painted (reveal.ts), and the header can be
// clicked before that. On Hyprland, maximising a window the compositor hasn't mapped yet does
// nothing. And Hyprland un-maximises a window whenever another one opens on its workspace
// (misc:on_focus_under_fullscreen), such as a Commander from another test run. So wait until the
// window is shown and mapped, then give it a hidden workspace of its own.
async function readyToMaximise(app: ElectronApplication): Promise<void> {
  await expect.poll(() => visible(app)).toEqual([true]);
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  const pid = app.process().pid as number;
  await expect.poll(() => hyprlandWorkspace(pid)).not.toBeNull();
  const workspace = `special:commander-e2e-${pid}`;
  // Older Hyprland versions don't know `status`, and those only have the text config.
  const status = await hyprctl(['-j', 'status']).catch(() => '');
  const move =
    configProvider(status) === 'lua'
      ? [
          'dispatch',
          `hl.dsp.window.move({ workspace = "${workspace}", follow = false, window = "pid:${pid}" })`,
        ]
      : ['dispatch', 'movetoworkspacesilent', `${workspace},pid:${pid}`];
  expect(await hyprctl(move)).toBe('ok');
  await expect.poll(() => hyprlandWorkspace(pid)).toBe(workspace);
}

const controls = (window: Page) => window.getByRole('group', { name: 'Window' });

// Every element in the title bar that takes a click, with its app-region, which must be no-drag.
const draggableControls = (window: Page) =>
  window.evaluate(() => {
    const clickable =
      'button, a, input, select, textarea, label, summary, [role="button"], [tabindex], [contenteditable]';
    return [...document.querySelectorAll<HTMLElement>(`:is(.f-hdr, .f-tabs) :is(${clickable})`)]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        what: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
        region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      }))
      .filter(({ region }) => region !== 'no-drag');
  });

test('there is no frame: the header reaches the window’s top edge and is the title bar', async () => {
  const commander = await launchCommander();
  const { app } = commander;
  const window = await app.firstWindow();
  const header = window.locator('header.f-hdr');
  await expect(controls(window)).toBeVisible();

  const { bounds, content } = await app.evaluate(({ BrowserWindow }) => {
    const created = BrowserWindow.getAllWindows()[0];
    return { bounds: created?.getBounds(), content: created?.getContentBounds() };
  });
  expect(content).toEqual(bounds);
  expect((await header.boundingBox())?.y).toBe(0);
  await expect(header).toHaveCSS('-webkit-app-region', 'drag');

  await commander.close();
});

test('the header and the tabs strip move the window, but nothing in them that takes a click starts a drag', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await expect(controls(window)).toBeVisible();
  await expect(window.locator('.f-tabs')).toHaveCSS('-webkit-app-region', 'drag');
  expect(await draggableControls(window)).toEqual([]);

  // Notes puts its week strip in the header.
  await window.keyboard.press('2');
  await expect(window.getByTestId('week-strip')).toBeVisible();
  expect(await draggableControls(window)).toEqual([]);

  // Settings opens as a temporary tab with ×.
  await openSettings(window);
  expect(await draggableControls(window)).toEqual([]);

  await commander.close();
});

test('the window controls have clear labels and are reachable from the keyboard', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const group = controls(window);
  for (const name of ['Minimise', 'Maximise', 'Close']) {
    const button = group.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await button.focus();
    await expect(button).toBeFocused();
  }
  await commander.close();
});

test('Close hides Commander to the tray, and the Core keeps beating', async () => {
  const commander = await launchCommander();
  const { app } = commander;
  const window = await app.firstWindow();
  await beats(window);

  await controls(window).getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => visible(app)).toEqual([false]);
  const atClose = await beats(window);
  await expect.poll(() => beats(window), { timeout: 8_000 }).toBeGreaterThanOrEqual(atClose + 2);

  summon(app);
  await expect.poll(() => visible(app)).toEqual([true]);
  await commander.close();
});

test('Minimise hides Commander to the tray where there is no minimised state, and minimises elsewhere', async () => {
  const commander = await launchCommander();
  const { app } = commander;
  const window = await app.firstWindow();
  const frame = await window.evaluate(() => globalThis.window.commander.windowFrame());

  await controls(window).getByRole('button', { name: 'Minimise' }).click();
  if (frame.minimise === 'hide') await expect.poll(() => visible(app)).toEqual([false]);
  else await expect.poll(() => minimised(app)).toBe(true);

  summon(app);
  await expect.poll(() => visible(app)).toEqual([true]);
  await commander.close();
});

test('Maximise maximises the window, and Restore restores it', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const group = controls(window);
  const maximised = () =>
    window.evaluate(() => globalThis.window.commander.windowFrame().then((frame) => frame.maximised));
  await readyToMaximise(commander.app);
  expect(await maximised()).toBe(false);

  await group.getByRole('button', { name: 'Maximise' }).click();
  await expect(group.getByRole('button', { name: 'Restore' })).toBeVisible();
  expect(await maximised()).toBe(true);

  await group.getByRole('button', { name: 'Restore' }).click();
  await expect(group.getByRole('button', { name: 'Maximise' })).toBeVisible();
  expect(await maximised()).toBe(false);

  await commander.close();
});
