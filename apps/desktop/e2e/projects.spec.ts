import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { launchCommander } from './launch-commander';

// Projects and Badges: create Projects in Settings, file Todos with `b`, filter by Project.

async function createProject(window: Page, name: string, code: string) {
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
}

async function openTodos(window: Page) {
  await tab(window, 'Todos').click();
  return window.getByRole('region', { name: 'Todos' });
}

async function addTodo(todos: Locator, title: string) {
  const field = todos.getByRole('textbox', { name: 'New Todo' });
  await field.fill(title);
  await field.press('Enter');
  await expect(todos.getByRole('checkbox', { name: title })).toBeVisible();
  await field.blur();
}

const row = (todos: Locator, title: string) =>
  todos.getByRole('listitem').filter({ has: todos.page().getByRole('checkbox', { name: title }) });

const shown = (todos: Locator) => todos.getByRole('region', { name: 'Open' }).getByRole('listitem');

const savedTodos = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } }));

const savedProjects = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'projects', query: {} }));

test('create a Project, file a Todo with b, filter by it, and undo the filing', async () => {
  const commander = await launchCommander();
  const window = await commander.window();

  // Settings → Projects: create Longtail and Titanlink; a taken code is refused.
  await openSettings(window);
  const settings = window.getByTestId('settings');
  await expect(settings.getByRole('radio', { name: 'blue' })).toBeChecked();
  await createProject(window, 'Longtail', 'lt');
  const list = settings.getByRole('list', { name: 'Projects' });
  await expect(list.getByRole('listitem')).toHaveText([/LTLongtail/]);
  await createProject(window, 'Lighthouse', 'LT');
  await expect(settings.getByRole('alert')).toHaveText('LT is already the Badge code for Longtail');
  await expect(settings.getByRole('radio', { name: 'teal' })).toBeChecked();
  await createProject(window, 'Titanlink', 'TL');
  await expect(list.getByRole('listitem')).toHaveText([/LTLongtail/, /TLTitanlink/]);
  const [longtail, titanlink] = await savedProjects(window);
  expect([longtail, titanlink]).toMatchObject([
    { name: 'Longtail', code: 'LT', accent: 'blue' },
    { name: 'Titanlink', code: 'TL', accent: 'teal' },
  ]);

  // Two Unfiled Todos, each with a faint — Badge.
  const todos = await openTodos(window);
  await addTodo(todos, 'Ship the beta');
  await addTodo(todos, 'Call the bank');
  await expect(row(todos, 'Ship the beta').getByRole('img', { name: 'Unfiled' })).toHaveText('—');

  // b on the selected Todo opens the picker; typing a code and Enter files it.
  await row(todos, 'Ship the beta').click();
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option')).toHaveText([/Longtail/, /Titanlink/, /Unfiled/]);
  await window.keyboard.type('lt');
  await window.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(row(todos, 'Ship the beta').getByRole('img', { name: 'Longtail' })).toHaveText('LT');
  const history = todos
    .getByRole('region', { name: 'Todo detail' })
    .getByRole('region', { name: 'Activity' });
  await expect(history.getByRole('listitem').first()).toHaveText(/^Filed under LT by you/i);
  expect(await savedTodos(window)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: 'Ship the beta',
        filing: { projectId: longtail?.id, filedBy: 'user' },
      }),
    ]),
  );

  // The filter bar counts open Todos per Project, and p then 1 narrows to Longtail.
  const bar = todos.getByRole('group', { name: 'Project filter' });
  await expect(bar.getByRole('button', { name: /Everything/ })).toHaveText(/02$/);
  await expect(bar.getByRole('button', { name: /^Longtail/ })).toHaveText(/01$/);
  await expect(bar.getByRole('button', { name: /Unfiled/ })).toHaveText(/01$/);
  await window.keyboard.press('p');
  await expect(bar).toHaveAttribute('data-armed', 'true');
  await window.keyboard.press('1');
  await expect(bar.getByRole('button', { name: /^Longtail/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(shown(todos)).toHaveText([/Ship the beta/]);

  // Clicking Unfiled, then p then 0 for Everything.
  await bar.getByRole('button', { name: /Unfiled/ }).click();
  await expect(shown(todos)).toHaveText([/Call the bank/]);
  await window.keyboard.press('p');
  await window.keyboard.press('0');
  await expect(shown(todos)).toHaveText([/Ship the beta/, /Call the bank/]);

  // Undo reverses the filing, and the counts follow.
  await window.keyboard.press('Control+z');
  await expect(row(todos, 'Ship the beta').getByRole('img', { name: 'Unfiled' })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Longtail/ })).toHaveText(/00$/);
  await row(todos, 'Ship the beta').click();
  await expect(history.getByRole('listitem').first()).toHaveText(/^Filing undone by you/i);
  expect((await savedTodos(window)).every((todo) => todo.filing === null)).toBe(true);

  await commander.close();
});

test('a Todo added under a selected Project is filed there, and the filter survives a restart', async () => {
  const first = await launchCommander();
  let window = await first.window();
  await openSettings(window);
  await createProject(window, 'Longtail', 'LT');
  await createProject(window, 'Tactics', 'TX');
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(2);
  const [, tactics] = await savedProjects(window);

  let todos = await openTodos(window);
  await window.keyboard.press('p');
  await window.keyboard.press('2');
  await expect(todos.getByRole('textbox', { name: 'New Todo' })).toHaveAttribute(
    'placeholder',
    'New Todo in Tactics…',
  );
  await addTodo(todos, 'Draft Q4 positioning');
  await expect(row(todos, 'Draft Q4 positioning').getByRole('img', { name: 'Tactics' })).toHaveText('TX');
  expect(await savedTodos(window)).toMatchObject([
    { title: 'Draft Q4 positioning', filing: { projectId: tactics?.id, filedBy: 'user' } },
  ]);
  await first.app.close();

  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.window();
  todos = await openTodos(window);
  const bar = todos.getByRole('group', { name: 'Project filter' });
  await expect(bar.getByRole('button', { name: /^Tactics/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(shown(todos)).toHaveText([/Draft Q4 positioning/]);

  await second.close();
});

test('b and the p keys are in the cheat sheet and never fire while typing', async () => {
  const commander = await launchCommander();
  const window = await commander.window();
  await openSettings(window);
  await createProject(window, 'Longtail', 'LT');
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(1);
  const todos = await openTodos(window);

  // Typing p, 1 and b into the New Todo field types them.
  const field = todos.getByRole('textbox', { name: 'New Todo' });
  await field.click();
  await window.keyboard.type('p1b');
  await expect(field).toHaveValue('p1b');
  await expect(window.getByRole('dialog', { name: 'Badge picker' })).toHaveCount(0);
  const bar = todos.getByRole('group', { name: 'Project filter' });
  await expect(bar.getByRole('button', { name: /Everything/ })).toHaveAttribute('aria-pressed', 'true');
  await field.blur();

  await window.keyboard.press('?');
  const sheet = window.getByTestId('cheat-sheet');
  const todoKeys = sheet.getByRole('region', { name: 'Todos' });
  await expect(todoKeys.getByText('File under a Project', { exact: true })).toBeVisible();
  const filterKeys = sheet.getByRole('region', { name: 'Project filter' });
  for (const label of ['Show everything', 'Only Longtail (LT)', 'Only Unfiled']) {
    await expect(filterKeys.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(filterKeys.getByText('then').first()).toBeVisible();

  await commander.close();
});
