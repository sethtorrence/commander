import { expect, type Page, test } from '@playwright/test';
import { openSettings, settingsPage, tab } from './frame';
import { launchCommander } from './launch-commander';

const SECTIONS = ['Dashboard', 'Notes', 'Todos', 'Linear', 'Email', 'Calendar', 'GitHub', 'Teams', 'Ares'];

const openSection = (window: Page) => window.locator('main > section:not([hidden])');

async function expectOpen(window: Page, label: string) {
  await expect(tab(window, label)).toHaveAttribute('aria-current', 'page');
  await expect(openSection(window)).toHaveAccessibleName(label);
  await expect(window.getByTestId('header-title')).toHaveText(label === 'Notes' ? 'Daily Notes' : label);
}

test('the notebook tabs switch Sections on click and on the number keys', async () => {
  const commander = await launchCommander();
  const window = await commander.window();

  await expectOpen(window, 'Dashboard');
  await tab(window, 'Todos').click();
  await expectOpen(window, 'Todos');
  await expect(tab(window, 'Dashboard')).not.toHaveAttribute('aria-current');

  for (const [index, label] of SECTIONS.entries()) {
    await window.keyboard.press(String(index + 1));
    await expectOpen(window, label);
  }

  await commander.close();
});

test('every Section shows a sheet with its title and part number', async () => {
  const commander = await launchCommander();
  const window = await commander.window();
  const year = new Date().getFullYear();

  for (const [index, label] of SECTIONS.entries()) {
    // Notes shows a stream of Daily Note sheets instead (notes.spec.ts).
    if (label === 'Notes') continue;
    await tab(window, label).click();
    const sheet = openSection(window);
    await expect(sheet.getByRole('heading', { level: 1 })).toHaveText(
      label === 'Dashboard' ? 'What needs you' : label,
    );
    await expect(sheet.locator('[data-slot=part-number]')).toHaveText(
      new RegExp(`^[A-Z]{2,3}-${year}-\\d{3}$`),
    );
    await expect(sheet.locator('[data-slot=sheet-strip]')).toContainText(
      `Sheet ${String(index + 1).padStart(2, '0')} / ${String(SECTIONS.length).padStart(2, '0')}`,
    );
  }

  await commander.close();
});

test('the header shows the Ares status module', async () => {
  const commander = await launchCommander();
  const window = await commander.window();

  const ares = window.getByTestId('ares-status');
  await expect(ares).toBeVisible();
  await expect(ares.getByTestId('ares-queued')).toHaveText('00');
  await expect(ares.getByTestId('ares-presence')).toHaveText('You’re here');
  await expect(ares).toContainText('Ares has nothing for you right now');

  await commander.close();
});

test('? opens the cheat sheet listing every shortcut registered', async () => {
  const commander = await launchCommander();
  const window = await commander.window();
  await expectOpen(window, 'Dashboard');

  await window.keyboard.press('?');
  const sheet = window.getByTestId('cheat-sheet');
  await expect(sheet).toBeVisible();
  const sections = sheet.getByRole('region', { name: 'Sections' });
  for (const [index, label] of SECTIONS.entries()) {
    await expect(sections.getByText(label, { exact: true })).toBeVisible();
    await expect(sections.locator('kbd', { hasText: String(index + 1) })).toBeVisible();
  }
  const general = sheet.getByRole('region', { name: 'General' });
  await expect(general.getByText('Keyboard shortcuts', { exact: true })).toBeVisible();
  await expect(general.getByText('Open Settings', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('region', { name: 'Settings' }).getByText('Close Settings')).toBeVisible();

  // Number keys stay with the open sheet (the page behind it is out of the accessibility tree,
  // so read the header); ? closes it again.
  await window.keyboard.press('3');
  await expect(window.getByTestId('header-title')).toHaveText('Dashboard');
  await window.keyboard.press('?');
  await expect(sheet).toBeHidden();
  await expectOpen(window, 'Dashboard');

  await window.keyboard.press('?');
  await expect(sheet).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  await commander.close();
});

test('typing digits into a field or an editor never switches Sections', async () => {
  const commander = await launchCommander();
  const window = await commander.window();

  await openSettings(window, 'General');
  const hex = window.getByRole('textbox', { name: 'Hex colour' });
  await hex.fill('');
  await hex.pressSequentially('#12345');
  await expect(hex).toHaveValue('#12345');
  await expect(window.getByTestId('settings')).toBeVisible();
  await expect(window.getByTestId('header-title')).toHaveText('Settings');

  // An editor (contenteditable), as the Notes Section will have.
  await window.keyboard.press('Escape'); // leaves the field
  await window.keyboard.press('Escape'); // closes Settings
  await expectOpen(window, 'Dashboard');
  await window.evaluate(() => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.dataset.testid = 'scratch-editor';
    editor.style.minHeight = '40px';
    document.querySelector('main section:not([hidden]) [data-slot=sheet]')?.append(editor);
  });
  const editor = window.getByTestId('scratch-editor');
  await editor.click();
  await window.keyboard.type('2 3 4 ? ,');
  await expect(editor).toHaveText('2 3 4 ? ,');
  await expectOpen(window, 'Dashboard');
  await expect(window.getByTestId('cheat-sheet')).toHaveCount(0);

  await commander.close();
});

test('Settings opens from the header and with the comma key, and Esc goes back', async () => {
  const commander = await launchCommander();
  const window = await commander.window();

  await tab(window, 'Linear').click();
  await openSettings(window);
  await expect(window.getByTestId('header-title')).toHaveText('Settings');
  await window.keyboard.press('Escape');
  await expectOpen(window, 'Linear');

  await window.keyboard.press(',');
  await expect(window.getByTestId('settings')).toBeVisible();
  await window.getByRole('button', { name: 'Close Settings' }).click();
  await expectOpen(window, 'Linear');

  // The design gallery is for development builds: a built Commander has no way to it in Settings.
  await window.keyboard.press(',');
  await settingsPage(window, 'General');
  await expect(window.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(window.getByRole('link', { name: /design gallery/i })).toHaveCount(0);

  await commander.close();
});

test('Settings in pages: the sidebar, j and k, the palette, and links that open a page at a group', async () => {
  const commander = await launchCommander();
  const window = await commander.window();
  const pages = window.getByRole('navigation', { name: 'Settings pages' });
  const current = pages.locator('[aria-current="page"]');

  // It opens on General; choosing a page shows only that page.
  await openSettings(window);
  await expect(current).toHaveText(/General$/);
  await expect(window.getByTestId('start-at-login')).toBeVisible();
  await settingsPage(window, 'Security');
  await expect(window.getByTestId('security-panel')).toBeVisible();
  await expect(window.getByTestId('start-at-login')).toBeHidden();

  // The keyboard: j and k step through the pages, and the arrows move along the sidebar.
  await window.keyboard.press('j');
  await expect(current).toHaveText(/Diagnostics$/);
  await window.keyboard.press('k');
  await window.keyboard.press('k');
  await expect(current).toHaveText(/Data$/);
  await current.focus();
  await window.keyboard.press('ArrowUp');
  await expect(current).toHaveText(/Teams$/);
  await expect(current).toBeFocused();

  // Settings opens again where it was left.
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('settings')).toBeHidden();
  await window.keyboard.press(',');
  await expect(current).toHaveText(/Teams$/);
  await window.keyboard.press('Escape');

  // The palette lists the pages.
  await window.keyboard.press('Control+k');
  await window.getByRole('combobox', { name: 'Search Commander' }).fill('settings acc');
  await expect(window.getByRole('option', { name: /Accounts/ })).toBeVisible();
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('settings')).toBeVisible();
  await expect(current).toHaveText(/Accounts$/);
  await window.keyboard.press('Escape');

  // An empty Section's way to Settings opens it at Accounts.
  await tab(window, 'Linear').click();
  await window.getByTestId('section-linear').getByRole('button', { name: 'Settings → Accounts' }).click();
  await expect(current).toHaveText(/Accounts$/);
  await expect(window.getByTestId('accounts-panel')).toBeInViewport();

  await commander.close();
});

test('the window appears as soon as its first frame is painted', async () => {
  const commander = await launchCommander();
  await commander.app.firstWindow();

  // Well inside the 3 s fallback, so it was the painted frame that showed it.
  await expect
    .poll(
      () => commander.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
      {
        timeout: 2_000,
      },
    )
    .toBe(true);

  await commander.close();
});
