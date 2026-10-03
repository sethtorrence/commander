import type { LinkType } from '@commander/domain';
import { expect, type Page, test } from '@playwright/test';
import { tab } from './frame';
import { launchCommander } from './launch-commander';

async function openTodos(window: Page) {
  await tab(window, 'Todos').click();
  return window.getByRole('region', { name: 'Todos' });
}

const savedTodos = (page: Page) =>
  page.evaluate(() =>
    window.commander.itemStore({ op: 'query', query: { kinds: ['todo'], includeDeleted: true } }),
  );

// Makes a Todo straight through the Item store, as another part of Commander would.
const makeTodo = (page: Page, title: string) =>
  page.evaluate(
    (title) =>
      window.commander.itemStore({
        op: 'record',
        action: {
          type: 'create',
          item: {
            kind: 'todo',
            title,
            detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
          },
        },
      }),
    title,
  );

// Links two Items through the Item store.
const link = (page: Page, from: string, linkType: LinkType, to: string) =>
  page.evaluate(
    (action) => window.commander.itemStore({ op: 'record', action: { type: 'link', ...action } }),
    { from, linkType, to },
  );

test('a Todo typed in the Todos Section is saved as a manual, Unfiled Todo and listed after a restart', async () => {
  const first = await launchCommander();
  let window = await first.app.firstWindow();
  let todos = await openTodos(window);

  await todos.getByRole('textbox', { name: 'New Todo' }).fill('Book the dentist');
  await todos.getByRole('textbox', { name: 'New Todo' }).press('Enter');
  await expect(todos.getByRole('checkbox', { name: 'Book the dentist' })).not.toBeChecked();
  await expect(todos.getByRole('textbox', { name: 'New Todo' })).toHaveValue('');
  expect(await savedTodos(window)).toMatchObject([
    { kind: 'todo', title: 'Book the dentist', status: 'open', filing: null, detail: { origin: 'manual' } },
  ]);
  await first.app.close();

  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  todos = await openTodos(window);
  const row = todos.getByRole('region', { name: 'Open' }).getByRole('listitem');
  await expect(row).toHaveText([/Book the dentist.*Manual/]);
  await expect(tab(window, 'Todos').locator('.tc')).toHaveText('01');

  await second.close();
});

test('Todos: move with j/k, open with Enter, edit the title, tick into Done, delete, and undo each', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const todos = await openTodos(window);
  const count = tab(window, 'Todos').locator('.tc');
  const open = todos.getByRole('region', { name: 'Open' });
  const done = todos.getByRole('region', { name: 'Done' });
  const selected = open.locator('li[aria-current]');
  const detail = todos.getByRole('region', { name: 'Todo detail' });
  const title = detail.getByRole('textbox', { name: 'Title' });
  const activity = detail.getByRole('region', { name: 'Activity' }).getByRole('listitem');

  const add = todos.getByRole('textbox', { name: 'New Todo' });
  for (const todo of ['Book the dentist', 'Renew passport', 'Water the plants']) {
    await add.fill(todo);
    await add.press('Enter');
  }
  await expect(count).toHaveText('03');

  // Keys don't move the selection while typing; Esc leaves the field, then j/k move it.
  await add.press('k');
  await expect(add).toHaveValue('k');
  await add.fill('');
  await add.press('Escape');
  await expect(selected).toContainText('Water the plants');
  await window.keyboard.press('k');
  await window.keyboard.press('k');
  await expect(selected).toContainText('Book the dentist');
  await window.keyboard.press('j');
  await expect(selected).toContainText('Renew passport');

  // Enter opens the selected Todo in the detail pane, with its origin, Links and history.
  await expect(detail).toBeHidden();
  await window.keyboard.press('Enter');
  await expect(title).toHaveValue('Renew passport');
  await expect(detail.getByText('Origin').locator('xpath=..')).toHaveText(/Origin\s*Manual/);
  await expect(detail.getByRole('region', { name: 'Links' })).toContainText('No Links yet.');
  await expect(activity).toHaveText([/^Added by you/]);

  // Edit the title: Enter saves it and the activity log records it; undo puts it back.
  await title.fill('Renew passport before June');
  await title.press('Enter');
  await expect(open.getByRole('listitem').nth(1)).toContainText('Renew passport before June');
  await expect(activity).toHaveText([/^Title changed by you/, /^Added by you/]);
  await window.keyboard.press('Control+z');
  await expect(title).toHaveValue('Renew passport');
  await expect(activity).toHaveText([
    /^Title change undone by you/,
    /^Title changed by you/,
    /^Added by you/,
  ]);

  // x ticks it into the collapsed Done group, and the selection moves on.
  await window.keyboard.press('x');
  await expect(done.getByRole('button', { name: /Done/ })).toContainText('01');
  await expect(done.getByRole('listitem')).toHaveCount(0);
  await expect(open.getByRole('listitem')).toHaveText([/Book the dentist/, /Water the plants/]);
  await expect(count).toHaveText('02');
  await expect(selected).toContainText('Water the plants');

  // Esc closes the detail pane.
  await window.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  // Delete removes the selected Todo.
  await window.keyboard.press('Delete');
  await expect(open.getByRole('listitem')).toHaveText([/Book the dentist/]);
  await expect(count).toHaveText('01');

  // Undo brings it back with its history intact.
  await window.keyboard.press('Control+z');
  await expect(open.getByRole('listitem')).toHaveText([/Book the dentist/, /Water the plants/]);
  await open.getByText('Water the plants').click();
  await expect(title).toHaveValue('Water the plants');
  await expect(activity).toHaveText([/^Delete undone by you/, /^Deleted by you/, /^Added by you/]);

  // Undo again unticks the ticked Todo, which returns to the open list.
  await window.keyboard.press('Control+z');
  await expect(open.getByRole('listitem')).toHaveText([
    /Book the dentist/,
    /Renew passport/,
    /Water the plants/,
  ]);
  await expect(done.getByRole('button', { name: /Done/ })).toContainText('00');
  await expect(count).toHaveText('03');

  // Ticked Todos show when the Done group is opened, and unticking one there returns it.
  // (The checkbox is visually hidden behind its drawn box, hence `force`; ticked, its row leaves.)
  await todos.getByRole('checkbox', { name: 'Book the dentist' }).click({ force: true });
  await expect(done.getByRole('button', { name: /Done/ })).toContainText('01');
  await done.getByRole('button', { name: /Done/ }).click();
  await expect(done.getByRole('listitem')).toHaveText([/Book the dentist/]);
  await done.getByRole('checkbox', { name: 'Book the dentist' }).click({ force: true });
  await expect(done.getByRole('listitem')).toHaveCount(0);
  await expect(open.getByRole('listitem').first()).toContainText('Book the dentist');

  expect(
    (await savedTodos(window)).map((todo) => [todo.title, todo.status, todo.deletedAt === null]),
  ).toEqual(
    expect.arrayContaining([
      ['Book the dentist', 'open', true],
      ['Renew passport', 'open', true],
      ['Water the plants', 'open', true],
    ]),
  );

  await commander.close();
});

test('the detail pane lists a Todo’s Links both ways, and a Link jumps to the Todo at its other end', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();

  const prep = await makeTodo(window, 'Prep for the Acme call');
  const deck = await makeTodo(window, 'Send the deck');
  await link(window, deck.itemId, 'caused-by', prep.itemId);

  const todos = await openTodos(window);
  await todos.getByText('Prep for the Acme call').click();
  const detail = todos.getByRole('region', { name: 'Todo detail' });
  const links = detail.getByRole('region', { name: 'Links' });
  await expect(links.getByRole('button')).toHaveText([/Led to\s*Send the deck/]);

  await links.getByRole('button', { name: /Send the deck/ }).click();
  await expect(detail.getByRole('textbox', { name: 'Title' })).toHaveValue('Send the deck');
  await expect(links.getByRole('button')).toHaveText([/Caused by\s*Prep for the Acme call/]);
  await expect(detail.getByRole('region', { name: 'Activity' }).getByRole('listitem')).toHaveText([
    /^Linked by you/,
    /^Added by you/,
  ]);

  await commander.close();
});

test('the Todos keys are in the cheat sheet', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await openTodos(window);

  await window.keyboard.press('?');
  const keys = window.getByTestId('cheat-sheet').getByRole('region', { name: 'Todos' });
  for (const label of [
    'Next Todo',
    'Previous Todo',
    'Open the Todo',
    'Close the Todo',
    'Tick or untick',
    'Delete the Todo',
    'Undo',
  ])
    await expect(keys.getByText(label, { exact: true })).toBeVisible();

  await commander.close();
});
