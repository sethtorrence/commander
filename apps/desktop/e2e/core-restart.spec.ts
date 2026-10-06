import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { tab } from './frame';
import { launchCommander } from './launch-commander';

// When the Core stops, Commander starts it again and says so (#200). The tests stop the Core as a
// crash would (SIGKILL, found through the test hooks), and shorten the waits before each new Core.

const corePid = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { commanderTestHooks: { corePid: () => number | null } }
    ).commanderTestHooks.corePid(),
  );

// A new Core, once one is running that isn't `previous`.
async function nextCore(app: ElectronApplication, previous: number | null): Promise<number> {
  const found: { pid: number | null } = { pid: null };
  await expect
    .poll(async () => {
      found.pid = await corePid(app);
      return found.pid !== null && found.pid !== previous;
    })
    .toBe(true);
  return found.pid as number;
}

const STOPPED = 'Commander’s core stopped. Starting it again…';

// Days as the app keys them: YYYY-MM-DD in local time.
const today = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });

// The test writes into an empty day.
const emptyDailyTemplate = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }));

const blockTitles = (page: Page) =>
  page.evaluate(() =>
    window.commander
      .itemStore({ op: 'query', query: { kinds: ['block'] } })
      .then((items) => items.map((item) => item.title)),
  );

// An Item store request made now: how long it took to fail, and why (null when it worked).
const tryRequest = (page: Page) =>
  page.evaluate(async () => {
    const started = performance.now();
    try {
      await window.commander.itemStore({ op: 'query', query: { kinds: ['block'] } });
      return null;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ms: performance.now() - started,
      };
    }
  });

test('killing the Core shows the banner, fails requests at once, and a new Core saves what was typed meanwhile', async () => {
  test.setTimeout(90_000);
  const commander = await launchCommander({
    env: { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_CORE_RESTART_DELAYS_MS: '8000,8000,8000' },
  });
  const { app } = commander;
  const window = await commander.window();
  await emptyDailyTemplate(window);
  await tab(window, 'Notes').click();
  const sheet = window.locator(`#day-${await today(window)}`);
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Before the stop');
  await expect.poll(() => blockTitles(window)).toEqual(['Before the stop']);

  const first = await nextCore(app, null);
  process.kill(first, 'SIGKILL');
  const banner = window.getByTestId('core-banner');
  await expect(banner).toHaveText(STOPPED);
  await expect(banner).toHaveAttribute('data-state', 'restarting');

  // While it is down, a request fails at once with that reason, rather than after 10 seconds.
  const failed = await tryRequest(window);
  expect(failed?.error).toContain(STOPPED);
  expect(failed?.ms).toBeLessThan(2_000);

  // Typing goes on: the Daily Note holds it until the Core is back.
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Typed while stopped');
  await expect(banner).toHaveAttribute('data-state', 'restarting');

  // A new Core starts, the banner goes, and it serves requests again, the held edits saved.
  await expect(banner).toBeHidden({ timeout: 30_000 });
  await expect(window.getByText('Commander’s core is running again.')).toBeVisible();
  expect(await nextCore(app, first)).not.toBe(first);
  await expect.poll(() => blockTitles(window)).toEqual(expect.arrayContaining(['Typed while stopped']));
  expect(await tryRequest(window)).toBeNull();
  await expect(sheet.locator('[data-block-text]', { hasText: /^Typed while stopped$/ })).toBeVisible();

  await commander.close();
});

test('stops in a row back off, then stop with Try again and a link to Diagnostics', async () => {
  test.setTimeout(90_000);
  const commander = await launchCommander({
    env: { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_CORE_RESTART_DELAYS_MS: '300,300,300' },
  });
  const { app } = commander;
  const window = await commander.window();
  const banner = window.getByTestId('core-banner');

  // Four stops in a short time: three new Cores, then Commander stops trying.
  let pid: number | null = null;
  for (let stop = 0; stop < 4; stop++) {
    pid = await nextCore(app, pid);
    process.kill(pid, 'SIGKILL');
  }
  await expect(banner).toHaveAttribute('data-state', 'stopped');
  await expect(banner).toContainText('Commander’s core keeps stopping, so it wasn’t started again.');
  expect(await corePid(app)).toBeNull();
  const failed = await tryRequest(window);
  expect(failed?.error).toContain('Commander’s core keeps stopping');
  expect(failed?.ms).toBeLessThan(2_000);

  await banner.getByRole('button', { name: 'Diagnostics' }).click();
  await expect(window.getByTestId('settings')).toBeVisible();
  await expect(window.getByTestId('diagnostics')).toBeInViewport();
  await expect(window.getByTestId('core-restarts')).toContainText(/^3 · last exited/);

  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(banner).toBeHidden({ timeout: 20_000 });
  expect(await tryRequest(window)).toBeNull();
  await expect(window.getByTestId('core-restarts')).toContainText(/^4 · /);
  await expect(window.getByTestId('core-heartbeat')).toHaveText(/^[1-9]\d*$/);

  await commander.close();
});

test('quitting while the Core is starting again quits, without starting another', async () => {
  const commander = await launchCommander({
    env: { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_CORE_RESTART_DELAYS_MS: '5000' },
  });
  const { app } = commander;
  const window = await commander.window();
  const pid = await nextCore(app, null);
  process.kill(pid, 'SIGKILL');
  await expect(window.getByTestId('core-banner')).toBeVisible();

  const main = app.process();
  const quit = new Promise((done) => main.once('exit', done));
  await commander.close();
  await quit;
  expect(main.exitCode ?? main.signalCode).not.toBeNull();
});
