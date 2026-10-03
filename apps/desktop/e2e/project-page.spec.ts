import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { launchCommander } from './launch-commander';

// The Project page and managing Projects: open the page (p then o, the filter bar, Settings), rename
// the Project from it, and archive it.

async function createProject(window: Page, name: string, code: string) {
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
  // The form clears itself once the Project is made; wait for that before filling it again.
  await expect(window.getByRole('list', { name: 'Projects' })).toContainText(name);
  await expect(form.getByLabel('Name')).toHaveValue('');
}

async function addTodo(todos: Locator, title: string) {
  const field = todos.getByRole('textbox', { name: 'New Todo' });
  await field.fill(title);
  await field.press('Enter');
  await expect(todos.getByRole('checkbox', { name: title })).toBeVisible();
  await field.blur();
}

const row = (scope: Locator, title: string) =>
  scope.getByRole('listitem').filter({ has: scope.page().getByRole('checkbox', { name: title }) });

const savedProjects = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'projects', query: { includeArchived: true } }));

test('open a Project page, rename the Project from it, and archive it', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const tabs = window.getByRole('navigation', { name: 'Sections' });
  const page = window.getByTestId('project-page');

  await openSettings(window);
  await createProject(window, 'Longtail', 'LT');
  await createProject(window, 'Titanlink', 'TL');
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(2);

  // A Todo filed under Longtail, added with Longtail selected (p then 1).
  await tab(window, 'Todos').click();
  const todos = window.getByRole('region', { name: 'Todos' });
  await window.keyboard.press('p');
  await window.keyboard.press('1');
  await addTodo(todos, 'Ship the beta');

  // p then o opens the selected Project's page as a temporary tab after the numbered ones.
  await window.keyboard.press('p');
  await window.keyboard.press('o');
  await expect(page).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'Longtail page', exact: true })).toBeVisible();
  await expect(tabs.locator('[data-section="project-page"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Longtail/);
  await expect(page.getByText(/^PRJ-LT-\d{3}$/)).toBeVisible();
  const inSections = page.getByRole('group', { name: 'In each Section' });
  await expect(inSections.getByRole('button', { name: /Todos/ })).toHaveText(/01$/);
  const openTodos = page.getByRole('region', { name: 'Open Todos' });
  await expect(openTodos.getByRole('listitem')).toHaveText([/Ship the beta/]);
  const filed = window.getByRole('region', { name: 'How its Items were filed' });
  await expect(filed.getByText('Set by you').locator('..')).toHaveText(/01$/);

  // Esc goes back to Todos.
  await window.keyboard.press('Escape');
  await expect(todos).toBeVisible();
  await expect(tab(window, 'Todos')).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('button', { name: 'Longtail page', exact: true })).toHaveCount(0);

  // The filter bar's open control opens it too, and × closes it.
  await todos
    .getByRole('group', { name: 'Project filter' })
    .getByRole('button', { name: 'Open the Longtail page' })
    .click();
  await expect(page).toBeVisible();
  await tabs.getByRole('button', { name: 'Close the Longtail page' }).click();
  await expect(todos).toBeVisible();

  // So does Settings → Projects; Esc goes back to Settings.
  await openSettings(window);
  await window.getByTestId('settings').getByRole('button', { name: 'Open the Longtail page' }).click();
  await expect(page).toBeVisible();

  // Rename and recode it from the page: a code another Project has is refused.
  const details = window.getByRole('form', { name: 'Name, code and accent' });
  await details.getByLabel('Name').fill('Longtail Labs');
  await details.getByLabel('Badge code').fill('TL');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('alert')).toHaveText('TL is already the Badge code for Titanlink');
  await details.getByLabel('Badge code').fill('LL');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Longtail Labs/);
  // Every Badge follows at once: the page's Todo row, the tab and the filter bar.
  await expect(row(openTodos, 'Ship the beta').getByRole('img', { name: 'Longtail Labs' })).toHaveText('LL');
  await expect(tabs.getByRole('button', { name: 'Longtail Labs page', exact: true })).toBeVisible();
  const bar = page.getByRole('group', { name: 'Project filter' });
  await expect(bar.getByRole('img', { name: 'Longtail Labs' })).toHaveText('LL');

  // Archive it: it leaves the filter bar, but its Todo keeps its Badge.
  await window
    .getByRole('region', { name: 'Manage the Project' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(bar.getByRole('img', { name: 'Longtail Labs' })).toHaveCount(0);
  await expect(page.getByText(/Archived: off the filter bar/).first()).toBeVisible();
  expect(await savedProjects(window)).toMatchObject([
    { name: 'Longtail Labs', code: 'LL', archived: true },
    { name: 'Titanlink', code: 'TL', archived: false },
  ]);

  await window.keyboard.press('Escape');
  await expect(window.getByTestId('settings')).toBeVisible();
  const archived = window.getByRole('list', { name: 'Archived' });
  await expect(archived.getByRole('listitem')).toHaveText([/Longtail Labs/]);

  await tab(window, 'Todos').click();
  await expect(row(todos, 'Ship the beta').getByRole('img', { name: 'Longtail Labs' })).toHaveText('LL');
  await expect(
    todos.getByRole('group', { name: 'Project filter' }).getByRole('img', { name: 'Longtail Labs' }),
  ).toHaveCount(0);
  await row(todos, 'Ship the beta').click();
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await expect(picker.getByRole('option')).toHaveText([/Titanlink/, /Unfiled/]);
  await window.keyboard.press('Escape');

  // Unarchive brings it back to the filter bar.
  await openSettings(window);
  await archived.getByRole('button', { name: 'Unarchive' }).click();
  await tab(window, 'Todos').click();
  await expect(
    todos.getByRole('group', { name: 'Project filter' }).getByRole('img', { name: 'Longtail Labs' }),
  ).toBeVisible();

  await commander.close();
});

test('merge one Project into another from its page, and undo it', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await openSettings(window);
  await createProject(window, 'Longtail', 'LT');
  await createProject(window, 'Tactics', 'TX');
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(2);

  await tab(window, 'Todos').click();
  const todos = window.getByRole('region', { name: 'Todos' });
  await window.keyboard.press('p');
  await window.keyboard.press('2');
  await addTodo(todos, 'Draft Q4 positioning');
  await addTodo(todos, 'Book the offsite');

  await window.keyboard.press('p');
  await window.keyboard.press('1');
  await window.keyboard.press('p');
  await window.keyboard.press('o');
  const page = window.getByTestId('project-page');
  const merge = window.getByRole('form', { name: 'Merge' });
  await merge.getByLabel('Merge with').selectOption({ label: 'TX · Tactics' });
  await merge.getByRole('radio', { name: 'Keep Longtail' }).check();
  await merge.getByRole('button', { name: 'Merge…' }).click();
  const confirm = window.getByRole('dialog', { name: 'Merge Tactics into Longtail?' });
  await expect(confirm).toContainText('2 Items move into Longtail');
  await confirm.getByRole('button', { name: 'Merge', exact: true }).click();

  const openTodos = page.getByRole('region', { name: 'Open Todos' });
  await expect(openTodos.getByRole('listitem')).toHaveCount(2);
  await expect(
    page.getByRole('group', { name: 'Project filter' }).getByRole('img', { name: 'Tactics' }),
  ).toHaveCount(0);

  await window.getByRole('button', { name: 'Undo' }).click();
  await expect(openTodos.getByRole('listitem')).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Project filter' }).getByRole('img', { name: 'Tactics' }),
  ).toBeVisible();

  await commander.close();
});
