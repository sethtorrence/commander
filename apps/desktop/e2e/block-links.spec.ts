import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { launchCommander } from './launch-commander';

// `[[` links from Blocks to days and Projects: the picker, chips, following them, "Mentioned in" on the
// day's sheet and the Project page, deleting a chip and undoing it, and a restart.

// A day `offset` days from today: its key (YYYY-MM-DD) and its chip label ("Fri 2 Oct").
const dayFrom = (page: Page, offset = 0) =>
  page.evaluate((days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const year = date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`;
    return {
      key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      label: `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}${year}`,
    };
  }, offset);

async function createProject(window: Page, name: string, code: string) {
  await openSettings(window, 'Projects');
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' })).toContainText(name);
}

// These tests write into an empty day: the daily template is emptied before today's Daily Note is made.
async function openNotes(page: Page): Promise<Locator> {
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${(await dayFrom(page)).key}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

// What the first Block of today links to, as "kind title", from the Item store.
const savedLinks = (page: Page, blockId: string) =>
  page.evaluate(
    (id) =>
      window.commander
        .itemStore({ op: 'get', itemId: id })
        .then((view) => (view?.links ?? []).map((link) => `${link.to.kind} ${link.to.title}`)),
    blockId,
  );

test('[[ links a Block to a day and a Project: chips, following them, Mentioned in, undo, and a restart', async () => {
  const first = await launchCommander();
  let window = await first.window();
  await createProject(window, 'Longtail', 'LT');
  let sheet = await openNotes(window);
  const yesterday = await dayFrom(window, -1);

  // [[ opens the picker; typing narrows it, and Enter puts a chip in the Block.
  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Follow up [[');
  const picker = window.getByRole('listbox', { name: 'Link to' });
  await expect(picker.getByRole('group', { name: 'Days' })).toBeVisible();
  await expect(picker.getByRole('group', { name: 'Projects' })).toContainText('Longtail');
  await window.keyboard.type('yest');
  await expect(picker.getByRole('option', { selected: true })).toContainText('Yesterday');
  await window.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  let block = sheet.locator('[data-block-text]').first();
  await expect(block.getByRole('link', { name: yesterday.label })).toBeVisible();

  await window.keyboard.type(' on [[long');
  await window.keyboard.press('Enter');
  await expect(block.getByRole('link', { name: 'Longtail' })).toBeVisible();
  const blockId = (await block.getAttribute('data-block-id')) as string;
  await expect
    .poll(() => savedLinks(window, blockId))
    .toEqual([expect.stringMatching(/^daily-note /), 'project Longtail']);

  // The day chip goes to that day, whose sheet lists the Block under Mentioned in; it jumps back.
  await block.getByRole('link', { name: yesterday.label }).click();
  const yesterdaySheet = window.locator(`#day-${yesterday.key}`);
  await expect(yesterdaySheet).toBeInViewport();
  const mentioned = yesterdaySheet.getByRole('region', { name: 'Mentioned in' });
  await expect(mentioned.getByRole('button')).toHaveText([/Follow up.*Longtail/]);
  await mentioned.getByRole('button').click();
  const row = sheet.locator(`.n-blk[data-block="${blockId}"]`);
  await expect(row).toHaveClass(/\bflash\b/);

  // The Project chip opens the Project page, which lists the Block too.
  await block.getByRole('link', { name: 'Longtail' }).click();
  const page = window.getByTestId('project-page');
  await expect(page).toBeVisible();
  const onPage = page.getByRole('region', { name: 'Mentioned in' });
  await expect(onPage.getByRole('button')).toHaveText([/Follow up/]);
  await onPage.getByRole('button').click();
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  await expect(row).toHaveClass(/\bflash\b/);

  // Backspace just after a chip takes it whole, and its Link; undo brings both back.
  // A click past the end of the text puts the caret after the last chip (a click on a chip would
  // follow it instead).
  const width = (await block.boundingBox())?.width ?? 0;
  await block.click({ position: { x: width - 4, y: 12 } });
  await window.keyboard.press('Backspace');
  await expect(block.getByRole('link', { name: 'Longtail' })).toHaveCount(0);
  await expect.poll(() => savedLinks(window, blockId)).toEqual([expect.stringMatching(/^daily-note /)]);
  await window.keyboard.press('Control+z');
  await expect(block.getByRole('link', { name: 'Longtail' })).toBeVisible();
  await expect.poll(() => savedLinks(window, blockId)).toHaveLength(2);

  // A `#LT` tag and a `[[` chip in one Block: it is filed under LT and links to today, both shown.
  await block.click({ position: { x: 4, y: 12 } });
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Plan #LT for [[tod');
  await window.keyboard.press('Enter');
  const today = await dayFrom(window);
  const planned = sheet.locator('[data-block-text]').nth(1);
  await expect(planned.getByRole('link', { name: today.label })).toBeVisible();
  const secondId = (await planned.getAttribute('data-block-id')) as string;
  const badge = sheet.locator(`.n-blk[data-block="${secondId}"] > .n-row [data-testid="block-badge"]`);
  await expect(badge).toHaveAttribute('data-own', 'true');
  await expect(badge).toContainText('LT');
  await expect.poll(() => savedLinks(window, secondId)).toEqual([expect.stringMatching(/^daily-note /)]);

  await first.app.close();

  // After a restart the chips and Links are still there.
  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.window();
  sheet = await openNotes(window);
  block = sheet.locator(`[data-block-id="${blockId}"]`);
  await expect(block.getByRole('link', { name: yesterday.label })).toBeVisible();
  await expect(block.getByRole('link', { name: 'Longtail' })).toBeVisible();
  expect(await savedLinks(window, blockId)).toHaveLength(2);
  await second.close();
});
