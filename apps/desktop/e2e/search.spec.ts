import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Global search and the Ctrl+K palette end to end: finding a Block by its words and opening it in
// Notes, a Todo in its detail pane, a Linear issue by its identifier, jumping, commands, `/` in a
// Section, and Search in Linear opening the browser.

let commander: LaunchedCommander | undefined;
let linear: FakeLinear | undefined;

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  linear = undefined;
});

// Days as the app keys them: YYYY-MM-DD in local time, `offset` days from today.
const dayFrom = (page: Page, offset = 0) =>
  page.evaluate((days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }, offset);

// An earlier day's Daily Note with top-level Blocks, and a Todo, through the Item store as the window would.
async function seed(page: Page, day: string) {
  await page.evaluate(
    async ({ day }) => {
      await window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } });
      const note = await window.commander.itemStore({ op: 'daily-note', day });
      const texts = ['Standup notes', 'Call Priya about the rate limiter', 'Book the venue'];
      await window.commander.itemStore({
        op: 'record-all',
        actions: texts.map((text, i) => ({
          type: 'create' as const,
          item: {
            kind: 'block' as const,
            title: text,
            detail: {
              kind: 'block' as const,
              dailyNoteId: note.id,
              parentId: null,
              position: `a${i}`,
              text,
              folded: false,
            },
          },
        })),
      });
      await window.commander.itemStore({
        op: 'record',
        action: { type: 'create', item: { kind: 'todo', title: 'Renew the passport' } },
      });
    },
    { day },
  );
}

const palette = (page: Page) => page.getByTestId('palette');
const paletteInput = (page: Page) => palette(page).getByRole('combobox', { name: 'Search Commander' });
const selectedRow = (page: Page) => palette(page).getByRole('option', { selected: true });

async function find(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await paletteInput(page).fill(text);
}

test('Ctrl+K finds a Block by its words and opens it in Notes, and a Todo in its detail pane', async () => {
  commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const earlier = await dayFrom(window, -5);
  await seed(window, earlier);

  // From inside the Notes editor, Ctrl+K still opens the palette.
  await tab(window, 'Notes').click();
  const today = window.locator(`#day-${await dayFrom(window)}`);
  await expect(today).toBeVisible();
  await today.locator('[data-block-text]').first().click();
  await find(window, 'rate lim');
  await expect(palette(window).getByRole('group', { name: 'Notes' })).toContainText(
    'Call Priya about the rate limiter',
  );
  await expect(selectedRow(window)).toContainText('Call Priya about the rate limiter');
  await window.keyboard.press('Enter');
  await expect(palette(window)).toBeHidden();

  // Notes, scrolled to that day, with the Block highlighted.
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  const block = window.locator(`#day-${earlier}`).locator('.n-blk', {
    has: window.locator('[data-block-text]', { hasText: /^Call Priya about the rate limiter$/ }),
  });
  await expect(block).toHaveClass(/\bflash\b/);
  await expect(block).toBeInViewport();

  // A Todo opens in the Todos detail pane.
  await find(window, 'passport');
  await expect(selectedRow(window)).toContainText('Renew the passport');
  await window.keyboard.press('Enter');
  const todos = window.getByTestId('section-todos');
  await expect(todos).toBeVisible();
  await expect(todos.getByRole('region', { name: 'Todo detail' }).getByLabel('Title')).toHaveValue(
    'Renew the passport',
  );

  // A Daily Note, by its day, opens Notes scrolled to it.
  await find(window, earlier);
  await expect(selectedRow(window)).toContainText('Daily Note');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  await expect(window.locator(`#day-${earlier}`)).toBeInViewport();
});

test('the palette jumps to Sections, runs commands, and / searches the open Section', async () => {
  commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await seed(window, await dayFrom(window, -2));

  // Jump to a Section.
  await find(window, 'lin');
  await expect(selectedRow(window)).toContainText('Linear');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('header-title')).toHaveText('Linear');

  // Run a command.
  const theme = await window.locator('html').getAttribute('data-theme');
  await find(window, 'switch theme');
  await window.keyboard.press('Enter');
  await expect(window.locator('html')).not.toHaveAttribute('data-theme', theme ?? '');

  // Esc closes it, and Ctrl+K again toggles it.
  await window.keyboard.press('Control+k');
  await expect(palette(window)).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(palette(window)).toBeHidden();

  // `/` in Todos searches Todos only.
  await tab(window, 'Todos').click();
  await window.keyboard.press('/');
  await expect(palette(window)).toBeVisible();
  await expect(paletteInput(window)).toHaveValue('in:todos ');
  await expect(palette(window).getByText('Find', { exact: true })).toBeVisible();
  await paletteInput(window).pressSequentially('re');
  await expect(palette(window).getByRole('group')).toHaveCount(1);
  await expect(palette(window).getByRole('group', { name: 'Todos' })).toContainText('Renew the passport');
  await window.keyboard.press('Escape');

  // `/` is just typing in a field.
  const add = window.getByTestId('section-todos').getByRole('textbox', { name: 'New Todo' });
  await add.click();
  await window.keyboard.type('a/b');
  await expect(add).toHaveValue('a/b');
  await expect(palette(window)).toBeHidden();
  await window.keyboard.press('Escape');

  // Both keys are in the cheat sheet.
  await window.keyboard.press('?');
  const general = window.getByTestId('cheat-sheet').getByRole('region', { name: 'General' });
  await expect(general.getByText('Search, jump and commands', { exact: true })).toBeVisible();
  await expect(general.getByText('Search this Section', { exact: true })).toBeVisible();
});

// Linear: tokens are stored in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_search_key';
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Links leave for the system browser: here, a list of what was sent there.
async function catchTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

test('ENG-418 opens the issue in Linear, and Search in Linear opens the browser', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  // Assigned to someone else, so the Section's default view (Assigned to me) would hide it.
  linear.issues.add(ACME.id, { identifier: 'ENG-418', title: 'Fix the login loop', assignee: PRIYA });
  linear.issues.add(ACME.id, {
    identifier: 'ENG-4180',
    title: 'Mentions ENG-418 in the title',
    assignee: PRIYA,
  });
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_LINEAR: JSON.stringify({
        clientId: null,
        port: await freePort(),
        authorizeUrl: linear.authorizeUrl,
        tokenUrl: linear.tokenUrl,
        apiUrl: linear.apiUrl,
      }),
    },
  });
  const { app } = commander;
  const window = await app.firstWindow();
  const openedExternally = await catchTheBrowser(app);
  await openSettings(window);
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/2 issues/);

  await find(window, 'ENG-418');
  await expect(selectedRow(window)).toContainText('Fix the login loop');
  await window.keyboard.press('Enter');
  const section = window.getByTestId('section-linear');
  await expect(section).toBeVisible();
  const pane = section.getByRole('region', { name: 'Issue detail' });
  await expect(pane.getByRole('heading', { name: 'Fix the login loop' })).toBeVisible();

  // Nothing local matches: the palette offers Linear's own search for the workspace.
  await find(window, 'okta rollout');
  const searchInLinear = palette(window).getByRole('group', { name: 'Search in Linear' });
  await expect(searchInLinear).toContainText('Search “okta rollout” in Linear');
  await searchInLinear.getByRole('option').click();
  await expect(palette(window)).toBeHidden();
  await expect.poll(openedExternally).toEqual([`https://linear.app/${ACME.urlKey}/search?q=okta%20rollout`]);
});
