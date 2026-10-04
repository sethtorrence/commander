import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { launchCommander } from './launch-commander';

// Block Projects: `#LT` files a Block, its children inherit, a Todo made from one shows the Badge in
// Todos, and the Project filter narrows Notes.

const dayKey = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

async function createProject(page: Page, name: string, code: string) {
  const form = page.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
}

// The Block whose text is `text`, as its whole (.n-blk) element.
const blockRow = (sheet: Locator, text: string | RegExp) =>
  sheet.locator('.n-blk').filter({
    has: sheet.page().locator(':scope > .n-row [data-block-text]', {
      hasText: typeof text === 'string' ? new RegExp(`^${text}$`) : text,
    }),
  });

const savedBlocks = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['block'] } }));

test('tag a parent with #LT, its child inherits, the child’s Todo shows the Badge, and the filter narrows Notes', async () => {
  const commander = await launchCommander();
  const page = await commander.window();
  await openSettings(page);
  await createProject(page, 'Longtail', 'LT');
  await createProject(page, 'Tactics', 'TX');
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(2);
  const [longtail] = await page.evaluate(() => window.commander.itemStore({ op: 'projects', query: {} }));

  // Today starts empty, and yesterday has something written that isn't in any Project.
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  await page.evaluate(async (day) => {
    await window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } });
    const note = await window.commander.itemStore({ op: 'daily-note', day });
    const detail = {
      kind: 'block' as const,
      dailyNoteId: note.id,
      parentId: null,
      position: 'a0',
      text: 'Old idea',
      folded: false,
    };
    await window.commander.itemStore({
      op: 'record',
      action: { type: 'create', item: { kind: 'block', title: 'Old idea', detail } },
    });
  }, dayKey(yesterday));

  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${dayKey(today)}`);
  await expect(sheet).toBeVisible();

  // `#` and a letter offer the Projects; Enter puts the code in, and the Block is filed under it.
  await sheet.locator('[data-block-text]').first().click();
  await page.keyboard.type('Longtail planning #l');
  const picker = page.getByTestId('tag-picker');
  await expect(picker.getByRole('option')).toHaveText([/Longtail/]);
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  const parent = blockRow(sheet, /^Longtail planning #LT\s?$/);
  await expect(parent.locator(':scope > .n-row [data-testid="block-badge"][data-own]')).toContainText('LT');
  await expect
    .poll(() =>
      savedBlocks(page).then((blocks) => blocks.find((b) => b.title.startsWith('Longtail'))?.filing),
    )
    .toEqual({ projectId: longtail?.id, filedBy: 'user' });

  // A child under it inherits: a faint accent bar, and filed as inherited.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Call Dana');
  const child = blockRow(sheet, 'Call Dana');
  await expect(child.locator(':scope > .n-row .n-pbar.inherited')).toBeVisible();
  await expect
    .poll(() => savedBlocks(page).then((blocks) => blocks.find((b) => b.title === 'Call Dana')?.filing))
    .toEqual({ projectId: longtail?.id, filedBy: 'inherited' });

  // `[]` makes it a Todo, which shows LT's Badge in Todos.
  await page.keyboard.press('Control+Enter');
  await expect(child.getByRole('checkbox')).toBeVisible();
  await tab(page, 'Todos').click();
  const todos = page.getByRole('region', { name: 'Todos' });
  const todo = todos.getByRole('listitem').filter({ hasText: 'Call Dana' });
  await expect(todo.getByRole('img', { name: 'Longtail' })).toHaveText('LT');

  // Back in Notes, a Block outside the Project, then the filter: `p` then 1 is Longtail.
  await tab(page, 'Notes').click();
  await child.locator('[data-block-text]').click();
  // Enter after a Todo makes another; Enter on that empty one makes it plain.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('Groceries');
  await page.keyboard.press('Escape');
  const groceries = blockRow(sheet, 'Groceries');
  await expect(groceries).toBeVisible();

  await page.keyboard.press('p');
  await page.keyboard.press('1');
  const bar = page.getByTestId('section-notes').getByRole('group', { name: 'Project filter' });
  await expect(bar.getByRole('button', { name: /^Longtail/ })).toHaveAttribute('aria-pressed', 'true');
  // Counts are Daily Notes: today has Longtail Blocks; today and yesterday have Unfiled ones.
  await expect(bar.getByRole('button', { name: /^Longtail/ })).toContainText('01');
  await expect(bar.getByRole('button', { name: /^Unfiled/ })).toContainText('02');
  await expect(bar.getByRole('button', { name: /^Everything/ })).toContainText('02');
  await expect(groceries).toHaveCount(0);
  await expect(parent).toBeVisible();
  await expect(child).toBeVisible();
  // Yesterday has nothing in Longtail: one line.
  const earlier = page.locator(`#day-${dayKey(yesterday)}`);
  await expect(earlier).toHaveAttribute('data-collapsed', '');
  await expect(earlier).toContainText('Nothing in Longtail');

  // Everything again.
  await page.keyboard.press('p');
  await page.keyboard.press('0');
  await expect(groceries).toBeVisible();
  await expect(earlier).not.toHaveAttribute('data-collapsed', '');

  await commander.close();
});

test('removing #LT returns the Block to inheriting, and undo files it again', async () => {
  const commander = await launchCommander();
  const page = await commander.window();
  await openSettings(page);
  await createProject(page, 'Longtail', 'LT');
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${dayKey(new Date())}`);
  await expect(sheet).toBeVisible();

  await sheet.locator('[data-block-text]').first().click();
  await page.keyboard.type('Pricing #lt');
  const badge = sheet.locator('[data-testid="block-badge"]').first();
  await expect(badge).toHaveAttribute('data-own', 'true');
  // Saved after a pause in typing: removing the code is then a step of its own to undo.
  await expect
    .poll(() => savedBlocks(page).then((blocks) => blocks.map((b) => b.filing?.filedBy)))
    .toEqual(['user']);

  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Backspace');
  await expect(badge).not.toHaveAttribute('data-own');
  await expect.poll(() => savedBlocks(page).then((blocks) => blocks.map((b) => b.filing))).toEqual([null]);

  await page.keyboard.press('Control+z');
  await expect(badge).toHaveAttribute('data-own', 'true');
  await expect
    .poll(() => savedBlocks(page).then((blocks) => blocks.map((b) => b.filing?.filedBy)))
    .toEqual(['user']);

  await commander.close();
});
