import { expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Search by meaning (#73) end to end, in the built app with its Core in Electron's utilityProcess
// (sqlite-vec loaded there): the model "downloads" with progress in Settings → Ares, every Item is
// embedded in the background, Ctrl+K merges in what meaning finds (marked related), and switching
// it off leaves search by words. The stand-in model replaces the real one, so nothing is downloaded.

let commander: LaunchedCommander | undefined;

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
});

async function addTodos(page: Page, titles: string[]) {
  await page.evaluate(async (all) => {
    await window.commander.itemStore({
      op: 'record-all',
      actions: all.map((title) => ({ type: 'create' as const, item: { kind: 'todo' as const, title } })),
    });
  }, titles);
}

const palette = (page: Page) => page.getByTestId('palette');
const status = (page: Page) => page.getByTestId('search-by-meaning-status');
const choice = (page: Page, name: 'On' | 'Off') =>
  page.getByTestId('search-by-meaning').getByRole('radio', { name });

test('the model gets ready in Settings → Ares, and Ctrl+K finds by meaning, marked related', async () => {
  commander = await launchCommander();
  const window = await commander.window();
  await addTodos(window, ['Throttle bursts on /sync', 'Rate the new coffee place', 'Renew the passport']);

  await openSettings(window, 'Ares');
  await expect(status(window)).toHaveText('Ready. All 3 Items and memories are indexed', { timeout: 20_000 });
  await expect(choice(window, 'On')).toHaveAttribute('aria-checked', 'true');

  await window.keyboard.press('Control+k');
  await palette(window).getByRole('combobox', { name: 'Search Commander' }).fill('rate ');
  const throttle = palette(window).getByRole('option', { name: /Throttle bursts on \/sync/ });
  await expect(throttle).toBeVisible();
  await expect(throttle.getByTestId('palette-related')).toBeVisible();
  await expect(
    palette(window)
      .getByRole('option', { name: /Rate the new coffee place/ })
      .getByTestId('palette-related'),
  ).toHaveCount(0);
  await expect(palette(window).getByRole('option', { name: /Renew the passport/ })).toHaveCount(0);
});

test('switched off, search is by words alone, and stays off after a restart', async () => {
  commander = await launchCommander();
  const window = await commander.window();
  await addTodos(window, ['Throttle bursts on /sync']);
  await openSettings(window, 'Ares');
  await expect(status(window)).toHaveText(/Ready/, { timeout: 20_000 });
  await choice(window, 'Off').click();
  await expect(status(window)).toHaveText('Off. Search finds things by their words.');

  const meaning = await window.evaluate(() =>
    globalThis.window.commander.models({ op: 'search-meaning', query: { text: 'rate limiter' } }),
  );
  expect(meaning).toEqual({ ok: true, result: null });

  const userDataDir = commander.userDataDir;
  await commander.app.close();
  commander = await launchCommander({ userDataDir });
  const reopened = await commander.window();
  await openSettings(reopened, 'Ares');
  await expect(status(reopened)).toHaveText('Off. Search finds things by their words.');
  await expect(choice(reopened, 'Off')).toHaveAttribute('aria-checked', 'true');
});
