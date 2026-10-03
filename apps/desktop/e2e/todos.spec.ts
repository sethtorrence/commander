import { expect, type Page, test } from '@playwright/test';
import { tab } from './frame';
import { launchCommander } from './launch-commander';

async function openTodos(window: Page) {
  await tab(window, 'Todos').click();
  return window.getByRole('region', { name: 'Todos' });
}

const savedTodos = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } }));

test('a Todo typed in the Todos Section is saved, listed after a restart, ticked with x and the tick undone', async () => {
  const first = await launchCommander();
  let window = await first.app.firstWindow();
  let todos = await openTodos(window);

  // Add: type it and press Enter.
  await todos.getByRole('textbox', { name: 'New Todo' }).fill('Book the dentist');
  await todos.getByRole('textbox', { name: 'New Todo' }).press('Enter');
  await expect(todos.getByRole('checkbox', { name: 'Book the dentist' })).not.toBeChecked();
  await expect(todos.getByRole('textbox', { name: 'New Todo' })).toHaveValue('');
  let history = window.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveText([/^Added by you/]);

  // It's a Todo Item of manual origin, Unfiled.
  expect(await savedTodos(window)).toMatchObject([
    {
      kind: 'todo',
      title: 'Book the dentist',
      status: 'open',
      filing: null,
      detail: { origin: 'manual' },
    },
  ]);
  await first.app.close();

  // Restart on the same data: it's still there.
  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  todos = await openTodos(window);
  history = window.getByRole('region', { name: 'History' });
  const todo = todos.getByRole('checkbox', { name: 'Book the dentist' });
  await expect(todo).not.toBeChecked();

  // x ticks the selected Todo, and the tick shows in its history.
  const row = todos
    .getByRole('region', { name: 'Yours' })
    .getByRole('listitem')
    .filter({ hasText: 'Book the dentist' });
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await window.keyboard.press('x');
  await expect(todo).toBeChecked();
  await expect(history.getByRole('listitem')).toHaveText([/^Ticked by you/, /^Added by you/]);
  expect(await savedTodos(window)).toMatchObject([{ status: 'done' }]);

  // Undo reverses the tick.
  await window.keyboard.press('Control+z');
  await expect(todo).not.toBeChecked();
  await expect(history.getByRole('listitem')).toHaveText([
    /^Tick undone by you/,
    /^Ticked by you/,
    /^Added by you/,
  ]);
  expect(await savedTodos(window)).toMatchObject([{ status: 'open' }]);

  await second.close();
});
