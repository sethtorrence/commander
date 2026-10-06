import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The Dashboard end to end: Todos made in Commander and Linear issues from a fake Linear (never the
// real one) are ranked into bands; a Todo is ticked, a row cleared (and back when its band changes
// after a sync), the list narrowed by the Project filter, a row opened in its Section, and the
// Project page shows its ranked list. Linear tokens go in the real keyring, so this needs the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_dashboard_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const STARTED = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const REVIEW = { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' };
const BACKLOG = { id: 'state-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8' };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A Todo due on a day `offset` days from today (local), made straight through the Item store.
const makeTodo = (page: Page, title: string, offset: number) =>
  page.evaluate(
    ({ title, offset }) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const pad = (n: number) => String(n).padStart(2, '0');
      const dueOn = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return window.commander.itemStore({
        op: 'record',
        action: {
          type: 'create',
          item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'manual', dueOn, backedBy: null } },
        },
      });
    },
    { title, offset },
  );

// The Items whose title holds the text, from the Item store.
const titled = (page: Page, text: string) =>
  page.evaluate((text) => window.commander.itemStore({ op: 'query', query: { titleContains: text } }), text);

// Syncs every Account now, as the 15-minute sync would, without leaving the open Section.
const syncNow = (page: Page) =>
  page.evaluate(async () => {
    const { state } = await window.commander.accounts({ op: 'list' });
    for (const account of state.accounts)
      await window.commander.accounts({ op: 'sync-now', accountId: account.id });
  });

let linear: FakeLinear;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.add(ACME.id, {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the outage',
    assignee: ME,
    priority: 1,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-2',
    identifier: 'ENG-2',
    title: 'Write the runbook',
    assignee: ME,
    state: STARTED,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-3',
    identifier: 'ENG-3',
    title: 'Rate limiter',
    assignee: ME,
    state: REVIEW,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-4',
    identifier: 'ENG-4',
    title: 'Audit log export',
    creator: ME,
    assignee: PRIYA,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-5',
    identifier: 'ENG-5',
    title: 'Someday cleanup',
    assignee: ME,
    state: BACKLOG,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

const band = (dashboard: Locator, name: string) => dashboard.getByRole('region', { name, exact: true });
const rows = (scope: Locator) => scope.getByTestId('dashboard-row');

test('seeded Todos and Linear issues are ranked into bands; tick, clear, filter and open', async () => {
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
  const window = await commander.window();
  await makeTodo(window, 'Send the invoice', -1);
  await makeTodo(window, 'Book the dentist', 0);

  // Connect Linear and make a Project.
  await openSettings(window, 'Accounts');
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/5 issues/);
  await settingsPage(window, 'Projects');
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill('Longtail');
  await form.getByLabel('Badge code').fill('LT');
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' })).toContainText('Longtail');
  await window.keyboard.press('Escape');

  // The Dashboard: four bands, each row with its reason and Source stamp; the backlog issue is left off.
  const dashboard = window.getByTestId('section-dashboard');
  await expect(dashboard).toBeVisible();
  await expect(rows(band(dashboard, 'Now'))).toHaveText([
    /ENG-1Fix the outage.*Urgent · ENG/,
    /Send the invoice.*Overdue since yesterday/,
  ]);
  await expect(rows(band(dashboard, 'Today'))).toHaveText([
    /Book the dentist.*Due today/,
    /ENG-2Write the runbook.*In Progress · ENG/,
  ]);
  await expect(rows(band(dashboard, 'Waiting on others'))).toHaveText([
    /ENG-3Rate limiter.*In review, waiting on reviewers/,
  ]);
  await expect(rows(band(dashboard, 'FYI'))).toHaveText([/ENG-4Audit log export.*Priya Patel has it/]);
  await expect(rows(dashboard).first().getByTestId('source-stamp')).toHaveText('LINTodo');
  await expect(rows(dashboard).nth(1).getByTestId('source-stamp')).toHaveText(/^TODOManual/);
  await expect(dashboard).not.toContainText('Someday cleanup');
  const meter = window.getByRole('navigation', { name: 'What needs you, by band' }).getByRole('button');
  await expect(meter).toHaveText(['Now02', 'Today02', 'Waiting01', 'FYI01']);
  await expect(tab(window, 'Dashboard').locator('.tc')).toHaveText('04');

  // x ticks the overdue Todo: it stays, struck through, and is ticked in the Item store.
  await window.keyboard.press('j');
  await expect(rows(dashboard).nth(1)).toHaveAttribute('aria-current', 'true');
  await window.keyboard.press('x');
  await expect(band(dashboard, 'Now').getByTestId('band-count')).toHaveText('01 open · 01 done');
  await expect(meter.first()).toHaveText('Now01');
  await expect.poll(async () => (await titled(window, 'invoice'))[0]?.status).toBe('done');

  // e clears the in-progress issue: off the Dashboard, still in the Linear Section.
  await rows(dashboard).getByText('Write the runbook').click();
  await window.keyboard.press('e');
  await expect(rows(band(dashboard, 'Today'))).toHaveText([/Book the dentist/]);
  await expect(dashboard).toContainText('1 cleared');
  await tab(window, 'Linear').click();
  await expect(
    window.getByTestId('section-linear').getByTestId('linear-issue').filter({ hasText: 'Write the runbook' }),
  ).toBeVisible();
  await tab(window, 'Dashboard').click();
  await expect(rows(dashboard).filter({ hasText: 'Send the invoice' })).toHaveCount(0);
  await expect(dashboard).not.toContainText('Write the runbook');

  // It becomes urgent in Linear: after the next sync (the Dashboard still open) it is back, in Now,
  // first as the most recently changed of the two urgent issues.
  linear.issues.update('issue-2', { priority: 1 });
  await syncNow(window);
  await expect(rows(band(dashboard, 'Now'))).toHaveText([/Write the runbook/, /Fix the outage/]);

  // b files the outage under Longtail; the Project filter then narrows the list, with its counts.
  await rows(dashboard).getByText('Fix the outage').click();
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('lt');
  await picker.getByRole('combobox').press('Enter');
  const filter = dashboard.getByRole('group', { name: 'Project filter' });
  await expect(filter.getByRole('button', { name: 'Longtail Longtail' })).toContainText('01');
  await filter.getByRole('button', { name: 'Longtail Longtail' }).click();
  await expect(rows(dashboard)).toHaveText([/Fix the outage/]);
  await expect(band(dashboard, 'Today')).toContainText('Nothing for Longtail in this band.');
  await expect(meter).toHaveText(['Now01', 'Today00', 'Waiting00', 'FYI00']);

  // Enter opens it in the Linear Section, selected and open in the detail pane.
  await rows(dashboard).getByText('Fix the outage').click();
  await window.keyboard.press('Enter');
  const pane = window.getByTestId('section-linear').getByRole('region', { name: 'Issue detail' });
  await expect(pane.getByRole('heading', { name: 'Fix the outage' })).toBeVisible();

  // The Longtail page shows its ranked list.
  await window.keyboard.press('p');
  await window.keyboard.press('o');
  const page = window.getByTestId('project-page');
  const ranked = page.getByRole('region', { name: 'Ranked for you in Longtail' });
  await expect(rows(ranked)).toHaveText([/Fix the outage.*Urgent · ENG/]);

  // Everything again: the ticked Todo has gone once the Dashboard was left.
  await window.keyboard.press('Escape');
  await window.keyboard.press('p');
  await window.keyboard.press('0');
  await tab(window, 'Dashboard').click();
  await expect(rows(band(dashboard, 'Now'))).toHaveText([/Write the runbook/, /Fix the outage/]);
});
