import { expect, type Locator, type Page, test } from '@playwright/test';
import { tab } from './frame';
import { launchCommander } from './launch-commander';

// `[]` turns a Block into a Todo: one and the same Todo in the Daily Note and in the Todos Section.

const today = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      label: `${date.getDate()} ${months[date.getMonth()]}`,
    };
  });

// These tests write into an empty day: the daily template is emptied before today's Daily Note is made.
async function openNotes(page: Page): Promise<Locator> {
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${(await today(page)).key}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

async function openTodos(window: Page): Promise<Locator> {
  await tab(window, 'Todos').click();
  const todos = window.getByTestId('section-todos');
  await expect(todos).toBeVisible();
  return todos;
}

// The Block whose text is `text`, as its whole (.n-blk) element.
const blockRow = (sheet: Locator, text: string) =>
  sheet.locator('.n-blk').filter({
    has: sheet.page().locator(':scope > .n-row [data-block-text]', { hasText: new RegExp(`^${text}$`) }),
  });

const savedTodos = (page: Page) =>
  page.evaluate(() =>
    window.commander.itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['open', 'done'] } }),
  );

test('[] makes a Todo: tick it in Todos, see it ticked in the note, jump back to the Block, and it all survives a restart', async () => {
  const first = await launchCommander();
  let window = await first.app.firstWindow();
  let sheet = await openNotes(window);
  const day = await today(window);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Morning');
  await window.keyboard.press('Enter');
  await window.keyboard.type('[] Call Dana');

  // The Block shows a checkbox in place of its bullet, and the mark is gone from its text.
  const call = blockRow(sheet, 'Call Dana');
  await expect(call.getByRole('checkbox', { name: 'Tick the Todo' })).toBeVisible();
  await expect(call.locator('.n-pill')).toHaveText('Todo');
  await expect(tab(window, 'Todos').locator('.tc')).toHaveText('01');
  await expect
    .poll(() => savedTodos(window).then((todos) => todos.map((t) => [t.title, t.detail])))
    .toEqual([['Call Dana', expect.objectContaining({ kind: 'todo', origin: 'daily-note' })]]);

  // In Todos it is the same Todo, from the Daily Note, and ticking it there ticks it in the note.
  const todos = await openTodos(window);
  const open = todos.getByRole('region', { name: 'Open' });
  const done = todos.getByRole('region', { name: 'Done' });
  await expect(open.getByRole('listitem')).toHaveText([new RegExp(`Call Dana.*Daily Note · ${day.label}`)]);
  await window.keyboard.press('x');
  await expect(open.getByRole('listitem')).toHaveCount(0);

  sheet = await openNotes(window);
  await expect(call).toHaveClass(/\bdone\b/);
  await expect(call.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');

  // Undo in Todos unticks it in the note too; Ctrl+Enter in the note ticks it again.
  await openTodos(window);
  await window.keyboard.press('Control+z');
  await expect(open.getByRole('listitem')).toHaveCount(1);
  sheet = await openNotes(window);
  await expect(call).not.toHaveClass(/\bdone\b/);
  await call.locator('[data-block-text]').click();
  await window.keyboard.press('Control+Enter');
  await expect(call).toHaveClass(/\bdone\b/);

  // From the Todo's made-from Link, Notes opens at the Block, highlighted.
  await openTodos(window);
  await done.getByRole('button', { name: /Done/ }).click();
  await done.getByText('Call Dana').click();
  const links = todos.getByRole('region', { name: 'Todo detail' }).getByRole('region', { name: 'Links' });
  await links.getByRole('button', { name: /Made from.*Call Dana/ }).click();
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  await expect(call).toHaveClass(/\bflash\b/);
  await expect(call).toBeInViewport();

  await first.app.close();

  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  sheet = await openNotes(window);
  await expect(blockRow(sheet, 'Call Dana')).toHaveClass(/\bdone\b/);
  await expect(blockRow(sheet, 'Morning').getByRole('checkbox')).toHaveCount(0);
  await second.close();
});

test('the Block and its Todo follow each other: title, removing the checkbox, and deleting the Todo', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  let sheet = await openNotes(window);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('[ ] Book flights');
  const flights = blockRow(sheet, 'Book flights');
  await expect(flights.getByRole('checkbox')).toBeVisible();

  // Renamed in Todos, the Block's text changes with it.
  const todos = await openTodos(window);
  const detail = todos.getByRole('region', { name: 'Todo detail' });
  await todos.getByRole('region', { name: 'Open' }).getByText('Book flights').click();
  const title = detail.getByRole('textbox', { name: 'Title' });
  await title.fill('Book flights to Lisbon');
  await title.press('Enter');
  sheet = await openNotes(window);
  const lisbon = blockRow(sheet, 'Book flights to Lisbon');
  await expect(lisbon.getByRole('checkbox')).toBeVisible();

  // Backspace right after the checkbox makes it a plain Block, and the Todo goes; undo brings it back.
  await lisbon.locator('[data-block-text]').click();
  await window.keyboard.press('Home');
  await window.keyboard.press('Backspace');
  await expect(lisbon.getByRole('checkbox')).toHaveCount(0);
  await expect(tab(window, 'Todos').locator('.tc')).toHaveText('00');
  await window.keyboard.press('Control+z');
  await expect(lisbon.getByRole('checkbox')).toBeVisible();

  // Deleted in Todos, the checkbox goes and the text stays.
  await openTodos(window);
  await todos.getByRole('region', { name: 'Open' }).getByText('Book flights to Lisbon').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('Delete');
  sheet = await openNotes(window);
  await expect(lisbon).toBeVisible();
  await expect(lisbon.getByRole('checkbox')).toHaveCount(0);

  await commander.close();
});
