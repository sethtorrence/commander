import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { FAKE_LABELS, FAKE_STATES } from '../src/main/linear/fake-linear-issues';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// Two-way sync end to end, against a fake Linear on this machine (never the real one): editing an
// issue's fields and commenting from the Linear Section's detail pane, the change reaching Linear,
// undo writing the old value back, changes made offline surviving a restart and sending on
// reconnect, a newer change in Linear winning with a note, and Couldn't sync with Retry. Tokens are
// stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_two_way_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const STARTED = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const LOGIN = { id: 'lp-login', name: 'Login revamp' };
const AUDIT = { id: 'lp-audit', name: 'Audit trail' };
const DAY = 86_400_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Links leave for the system browser: here, a list of what was sent there.
async function catchTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

// Takes the machine offline or back online, as far as Commander can tell (a main-process test hook).
function setOnline(app: ElectronApplication, online: boolean) {
  return app.evaluate((_electron, value) => {
    (
      globalThis as unknown as { commanderTestHooks: { setOnline(online: boolean): void } }
    ).commanderTestHooks.setOnline(value);
  }, online);
}

// What the window knows of the Account's syncing, through Settings → Accounts' channel.
function syncActivity(page: Page) {
  return page.evaluate(async () => {
    const { state } = await window.commander.accounts({ op: 'list' });
    return state.accounts[0]?.sync?.activity ?? null;
  });
}

let linear: FakeLinear;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  const now = Date.now();
  const current = {
    id: 'cycle-41',
    number: 41,
    name: null,
    startsAt: new Date(now - 3 * DAY).toISOString(),
    endsAt: new Date(now + 4 * DAY).toISOString(),
  };
  const next = {
    id: 'cycle-42',
    number: 42,
    name: 'Polish',
    startsAt: new Date(now + 4 * DAY).toISOString(),
    endsAt: new Date(now + 11 * DAY).toISOString(),
  };
  linear.issues.setCatalog(ACME.id, [
    {
      team: ENG,
      states: FAKE_STATES,
      members: [ME, PRIYA],
      labels: FAKE_LABELS,
      cycles: [current, next],
      projects: [LOGIN, AUDIT],
    },
  ]);
  linear.issues.add(ACME.id, {
    id: 'issue-418',
    identifier: 'ENG-418',
    title: 'Fix the login loop',
    assignee: ME,
    creator: PRIYA,
    state: STARTED,
    priority: 2,
    estimate: 3,
    dueDate: '2026-10-09',
    cycle: current,
    project: LOGIN,
    labels: { nodes: [FAKE_LABELS[0] as (typeof FAKE_LABELS)[number]] },
    description: 'The login page **loops** after SSO.',
  });
  linear.issues.add(ACME.id, {
    id: 'issue-420',
    identifier: 'ENG-420',
    title: 'Rotate the keys',
    assignee: ME,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

async function environment(extra: Record<string, string> = {}) {
  return {
    COMMANDER_TEST_LINEAR: JSON.stringify({
      clientId: null,
      port: await freePort(),
      authorizeUrl: linear.authorizeUrl,
      tokenUrl: linear.tokenUrl,
      apiUrl: linear.apiUrl,
    }),
    ...extra,
  };
}

async function connect(window: Page) {
  await openSettings(window);
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/2 issues/);
}

// Opens ENG-418 in the Linear Section's detail pane.
async function openIssue(window: Page): Promise<Locator> {
  await tab(window, 'Linear').click();
  const section = window.getByTestId('section-linear');
  await section.getByTestId('linear-issue').filter({ hasText: 'Fix the login loop' }).click();
  const pane = section.getByRole('region', { name: 'Issue detail' });
  await expect(pane.getByRole('heading', { name: 'Fix the login loop' })).toBeVisible();
  return pane;
}

// Picks a choice from one of the pane's pickers (retried: pop-ups close when focus is lost).
async function pick(pane: Locator, field: string, option: RegExp, shows: RegExp) {
  await pickOption(pane.getByRole('combobox', { name: field, exact: true }), option, shows);
}

const field = (pane: Locator, name: string) => pane.locator(`[data-field="${name}"] dd`);
const updates = () =>
  linear.graphqlRequests.filter((request) => request.operationName === 'CommanderIssueUpdate');
const lastInput = () => updates().at(-1)?.variables;
const remote = () => linear.issues.get('issue-418');

test('edit every writable field and comment from the detail pane, and undo writes the old value back', async () => {
  commander = await launchCommander({ env: await environment() });
  const window = await commander.window();
  const openedExternally = await catchTheBrowser(commander.app);
  await connect(window);
  const pane = await openIssue(window);

  // Each change shows at once and reaches Linear, sending only the field that changed.
  await pick(pane, 'State', /^In Review$/, /In Review/);
  await expect(field(pane, 'state')).toHaveText('In Review');
  await expect.poll(() => remote().state.name).toBe('In Review');
  expect(lastInput()).toEqual({ id: 'issue-418', input: { stateId: 'state-review' } });

  await pick(pane, 'Priority', /^Urgent$/, /Urgent/);
  await expect.poll(() => remote().priority).toBe(1);
  expect(lastInput()).toEqual({ id: 'issue-418', input: { priority: 1 } });

  await pick(pane, 'Assignee', /^Priya Patel$/, /Priya Patel/);
  await expect.poll(() => remote().assignee?.id).toBe(PRIYA.id);

  await pick(pane, 'Linear project', /^Audit trail$/, /Audit trail/);
  await expect.poll(() => remote().project?.id).toBe(AUDIT.id);

  await pick(pane, 'Cycle', /Cycle 42/, /Cycle 42/);
  await expect.poll(() => remote().cycle?.id).toBe('cycle-42');

  // Labels go as add and remove deltas.
  await pick(pane, 'Labels', /^Customer/, /Customer/);
  await expect
    .poll(() =>
      remote()
        .labels.nodes.map((label) => label.name)
        .sort(),
    )
    .toEqual(['Bug', 'Customer']);
  expect(lastInput()).toEqual({ id: 'issue-418', input: { addedLabelIds: ['label-customer'] } });

  await pane.getByLabel('Due date').fill('2026-10-16');
  await expect.poll(() => remote().dueDate).toBe('2026-10-16');

  const estimate = pane.getByLabel('Estimate');
  await estimate.fill('5');
  await estimate.press('Enter');
  await expect.poll(() => remote().estimate).toBe(5);
  expect(lastInput()).toEqual({ id: 'issue-418', input: { estimate: 5 } });

  // A comment, posted with Ctrl+Enter under Commander's own id for it.
  const box = pane.getByRole('textbox', { name: 'New comment' });
  await box.fill('Fixed the redirect on staging.');
  await box.press('Control+Enter');
  const comments = pane.getByRole('region', { name: 'Comments' });
  await expect(comments).toContainText('Fixed the redirect on staging.');
  await expect
    .poll(() => remote().comments.map((comment) => comment.body))
    .toEqual(['Fixed the redirect on staging.']);
  const posted = linear.graphqlRequests.filter(
    (request) => request.operationName === 'CommanderCommentCreate',
  );
  expect(posted).toHaveLength(1);
  expect(posted[0]?.variables.input).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  await expect(pane.getByTestId('issue-sync')).toBeHidden();

  // Undo, one change at a time: the comment comes off in Linear, then the estimate goes back.
  await pane.getByRole('heading', { name: 'Fix the login loop' }).click();
  await window.keyboard.press('Control+z');
  await expect(comments).not.toContainText('Fixed the redirect on staging.');
  await expect.poll(() => remote().comments).toEqual([]);
  await window.keyboard.press('Control+z');
  await expect(estimate).toHaveValue('3');
  await expect.poll(() => remote().estimate).toBe(3);
  const activity = pane.getByRole('region', { name: 'Activity' });
  await expect(
    activity.getByRole('listitem').filter({ hasText: 'Estimate change undone by you' }),
  ).toBeVisible();

  // The description can't be edited here: Edit in Linear opens the issue in the browser.
  const description = pane.getByRole('region', { name: 'Description' });
  await expect(description.locator('textarea, input, [contenteditable]')).toHaveCount(0);
  await description.getByRole('link', { name: /Edit in Linear/ }).click();
  await expect.poll(openedExternally).toEqual(['https://linear.app/fake/issue/ENG-418']);
});

test('changes made offline keep their edit time, survive a restart, and send on reconnect; Linear’s newer change wins', async () => {
  const env = await environment({ COMMANDER_TEST_HOOKS: '1' });
  const first = await launchCommander({ env });
  commander = first;
  let window = await first.window();
  await connect(window);
  let pane = await openIssue(window);

  await setOnline(first.app, false);
  await expect.poll(() => syncActivity(window)).toBe('offline');
  await pick(pane, 'Priority', /^Urgent$/, /Urgent/);
  const estimate = pane.getByLabel('Estimate');
  await estimate.fill('8');
  await estimate.press('Enter');
  await expect(pane.getByTestId('issue-sync')).toHaveText('Offline · saves to Linear when back online');
  await window.waitForTimeout(1500);
  expect(updates()).toEqual([]);
  await first.app.close();

  // Back, still offline: the changes are still there, still waiting.
  commander = await launchCommander({
    userDataDir: first.userDataDir,
    env: { ...env, COMMANDER_TEST_OFFLINE: '1' },
  });
  window = await commander.window();
  pane = await openIssue(window);
  await expect(field(pane, 'priority')).toHaveText('Urgent');
  await expect(pane.getByLabel('Estimate')).toHaveValue('8');
  await expect(pane.getByTestId('issue-sync')).toHaveText('Offline · saves to Linear when back online');
  expect(updates()).toEqual([]);

  // Meanwhile Priya changes the estimate in Linear: newer than the User's edit, so hers wins. The
  // priority, which nobody changed in Linear, goes through.
  linear.issues.update('issue-418', { estimate: 13 }, PRIYA);
  await setOnline(commander.app, true);

  await expect.poll(() => remote().priority).toBe(1);
  expect(updates().map((request) => request.variables)).toEqual([
    { id: 'issue-418', input: { priority: 1 } },
  ]);
  expect(remote().estimate).toBe(13);
  await expect(pane.getByLabel('Estimate')).toHaveValue('13');
  await expect(pane.getByTestId('issue-sync')).toHaveText(/^Changed in Linear by Priya Patel at \d\d:\d\d$/);
  await expect(
    pane
      .getByRole('region', { name: 'Activity' })
      .getByRole('listitem')
      .filter({ hasText: 'Changed in Linear by Priya Patel' }),
  ).toBeVisible();
});

test('a change Linear refuses shows Couldn’t sync, and Retry sends it again', async () => {
  commander = await launchCommander({ env: await environment() });
  const window = await commander.window();
  await connect(window);
  const pane = await openIssue(window);

  linear.refuseWrites('The issue is locked for editing.');
  await pick(pane, 'State', /^In Review$/, /In Review/);
  const alert = pane.getByRole('alert');
  await expect(alert).toContainText('Couldn’t sync');
  await expect(alert).toContainText('The issue is locked for editing.');
  const row = window.getByTestId('linear-issue').filter({ hasText: 'Fix the login loop' });
  await expect(row).toContainText('Couldn’t sync');
  // The change stays as the User made it until it gets through or is undone.
  await expect(field(pane, 'state')).toHaveText('In Review');
  expect(remote().state.name).toBe('In Progress');

  linear.refuseWrites(null);
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => remote().state.name).toBe('In Review');
  await expect(alert).toBeHidden();
  await expect(row).not.toContainText('Couldn’t sync');
});
