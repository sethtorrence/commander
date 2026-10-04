import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { FAKE_LABELS, FAKE_STATES } from '../src/main/linear/fake-linear-issues';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Send to Linear end to end, against a fake Linear on this machine (never the real one). A Block
// filed under LT is sent from its margin menu: the dialog starts on OPS (the team of the Rule filing
// OPS issues under LT), the Block shows the issue's chip, and the issue is in Linear and in the Linear
// Section with LT's Badge, filed as inherited. A Todo sent with `l` is backed by its issue, ticking it
// completes the issue in Linear, and undoing the send deletes the issue in Linear. New Linear issue in
// the Linear Section makes one filed under the Project filter's Project. Tokens are stored in the real
// keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_send_to_linear_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const dayKey = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

let linear: FakeLinear;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  const team = (t: typeof ENG) => ({
    team: t,
    states: FAKE_STATES,
    members: [ME, PRIYA],
    labels: FAKE_LABELS,
    cycles: [],
    projects: [],
  });
  linear.issues.setCatalog(ACME.id, [team(ENG), team(OPS)]);
  linear.issues.add(ACME.id, { identifier: 'ENG-418', title: 'Fix the login loop', assignee: PRIYA });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

// Connects the fake workspace with an API key, makes the Project Longtail (LT) and a Rule filing OPS
// issues under it, and empties the daily template.
async function setUp(): Promise<Page> {
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
  const page = await commander.app.firstWindow();
  await openSettings(page);
  const panel = page.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/1 issue/);
  const form = page.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill('Longtail');
  await form.getByLabel('Badge code').fill('LT');
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(1);
  await page.evaluate(async () => {
    const [longtail] = await window.commander.itemStore({ op: 'projects', query: {} });
    await window.commander.itemStore({
      op: 'change-rule',
      action: {
        type: 'create',
        rule: {
          target: { kind: 'project', projectId: longtail?.id ?? '' },
          when: { join: 'and', terms: [{ field: 'linear.team', op: 'is', value: 'team-ops', label: 'OPS' }] },
        },
      },
    });
    await window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } });
  });
  await page.keyboard.press('Escape');
  return page;
}

const created = () =>
  linear.graphqlRequests.filter((request) => request.operationName === 'CommanderIssueCreate');
const issueItem = (page: Page, title: string) =>
  page.evaluate(
    async (title) =>
      (
        await window.commander.itemStore({
          op: 'query',
          query: { kinds: ['linear-issue'], titleContains: title, includeDeleted: true },
        })
      )[0] ?? null,
    title,
  );

const dialogIn = (page: Page): Locator => page.getByTestId('send-to-linear');

test('a Block sent to Linear from its margin menu shows the issue chip, and the issue is in the Linear Section with its team and Badge', async () => {
  const page = await setUp();
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${dayKey(new Date())}`);
  await expect(sheet).toBeVisible();

  // A Block filed under LT.
  await sheet.locator('[data-block-text]').first().click();
  await page.keyboard.type('Write the deploy runbook #l');
  await expect(page.getByTestId('tag-picker').getByRole('option')).toHaveText([/Longtail/]);
  await page.keyboard.press('Enter');
  const block = sheet.locator('.n-blk').filter({ hasText: 'Write the deploy runbook' });
  await expect(block.locator('[data-testid="block-badge"][data-own]')).toContainText('LT');

  // Its margin menu: Send to Linear…. The dialog starts from the Block's words, on OPS (the Rule's team).
  await block.locator('.n-row').hover();
  await block.getByRole('button', { name: /^Menu for/ }).click();
  await page.getByRole('menuitem', { name: /Send to Linear/ }).click();
  const dialog = dialogIn(page);
  await expect(dialog.getByLabel('Title')).toHaveValue('Write the deploy runbook');
  await expect(dialog.getByRole('combobox', { name: 'Team' })).toHaveText(/OPS · Operations/);
  await expect(dialog.getByRole('combobox', { name: 'Assignee' })).toHaveText(/Sam Rivera \(you\)/);
  await expect(dialog.getByRole('combobox', { name: 'State' })).toHaveText(/Todo/);
  await dialog.getByLabel('Description (optional)').fill('Steps first, then the rollback.');
  await dialog.getByRole('button', { name: /^Send to Linear/ }).click();
  await expect(dialog).toHaveCount(0);

  // The issue is made in Linear, in OPS, once; the Block shows its chip with Linear's number.
  const chip = block.getByTestId('block-issue');
  await expect(chip).toContainText(/OPS-/);
  await expect(chip).toContainText('Todo');
  await expect.poll(() => created().length).toBe(1);
  expect(created()[0]?.variables).toMatchObject({
    input: {
      teamId: 'team-ops',
      title: 'Write the deploy runbook',
      description: 'Steps first, then the rollback.',
      assigneeId: ME.id,
      stateId: 'state-todo',
    },
  });
  await expect(chip).toContainText('OPS-1');

  // The issue carries the Block's Project, filed as inherited, with a made-from Link to the Block.
  const issue = await issueItem(page, 'Write the deploy runbook');
  const [longtail] = await page.evaluate(() => window.commander.itemStore({ op: 'projects', query: {} }));
  expect(issue?.filing).toEqual({ projectId: longtail?.id, filedBy: 'inherited' });

  // The chip opens the issue in the Linear Section: OPS, LT's Badge, and the Link back to the Block.
  await chip.click();
  const section = page.getByTestId('section-linear');
  const pane = section.getByRole('region', { name: 'Issue detail' });
  await expect(pane.getByRole('heading', { name: 'Write the deploy runbook' })).toBeVisible();
  await expect(pane).toContainText('OPS-1');
  await expect(pane).toContainText('Operations');
  await expect(pane).toContainText(/Made from/i);
  const row = section.getByTestId('linear-issue').filter({ hasText: 'Write the deploy runbook' });
  await expect(row.getByRole('img', { name: 'Longtail' })).toBeVisible();
  await expect(row).toContainText('OPS-1');
});

test('a Todo sent with l is backed by its issue: ticking completes it in Linear, and undoing the send deletes it there', async () => {
  const page = await setUp();
  await tab(page, 'Todos').click();
  const section = page.getByTestId('section-todos');
  await page.keyboard.press('n');
  await page.keyboard.type('Rotate the signing keys');
  await page.keyboard.press('Enter');
  const open = section.getByRole('region', { name: 'Open', exact: true });
  const row = open.getByRole('listitem').filter({ hasText: 'Rotate the signing keys' });
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');

  await page.keyboard.press('l');
  const dialog = dialogIn(page);
  await expect(dialog.getByLabel('Title')).toHaveValue('Rotate the signing keys');
  await dialog.getByRole('combobox', { name: 'Team' }).focus();
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0);

  // The Todo is backed by the issue: its origin is Linear, with Linear's number once it is made.
  await expect(row).toContainText(/Linear · ENG-/);
  await expect(row).toContainText('Linear · ENG-419');
  const issue = await issueItem(page, 'Rotate the signing keys');
  const externalId = issue?.externalId as string;
  expect(linear.issues.get(externalId)).toMatchObject({ title: 'Rotate the signing keys', team: ENG });

  // Ticking the Todo completes the issue in Linear.
  await row.click();
  await page.keyboard.press('x');
  await expect.poll(() => linear.issues.get(externalId).state.name).toBe('Done');

  // Ctrl+Z unticks it, and Ctrl+Z again undoes the send: the issue is deleted in Linear.
  await page.keyboard.press('Control+z');
  await expect.poll(() => linear.issues.get(externalId).state.name).toBe('Todo');
  await page.keyboard.press('Control+z');
  await expect.poll(() => linear.issues.get(externalId).trashed).toBe(true);
  await expect(open.getByRole('listitem').filter({ hasText: 'Rotate the signing keys' })).toContainText(
    'Manual',
  );
});

test('New Linear issue in the Linear Section makes the issue in Linear, filed under the Project filter’s Project', async () => {
  const page = await setUp();
  await tab(page, 'Linear').click();
  const section = page.getByTestId('section-linear');
  // The Project filter on Longtail: the new issue is filed there.
  await page.keyboard.press('p');
  await page.keyboard.press('1');

  await section.getByRole('button', { name: /New Linear issue/ }).click();
  const dialog = dialogIn(page);
  await expect(dialog.getByRole('heading', { name: 'New Linear issue' })).toBeVisible();
  // The Project's Rule names OPS.
  await expect(dialog.getByRole('combobox', { name: 'Team' })).toHaveText(/OPS · Operations/);
  await dialog.getByLabel('Title').fill('Renew the certificate');
  await dialog.getByLabel('Title').press('Enter');
  await expect(dialog).toHaveCount(0);

  const pane = section.getByRole('region', { name: 'Issue detail' });
  await expect(pane.getByRole('heading', { name: 'Renew the certificate' })).toBeVisible();
  await expect(pane).toContainText('OPS-1');
  const issue = await issueItem(page, 'Renew the certificate');
  expect(linear.issues.get(issue?.externalId as string)).toMatchObject({
    team: OPS,
    assignee: { id: ME.id },
  });
  const [longtail] = await page.evaluate(() => window.commander.itemStore({ op: 'projects', query: {} }));
  expect(issue?.filing).toEqual({ projectId: longtail?.id, filedBy: 'user' });
});
