import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { FAKE_LABELS, FAKE_STATES } from '../src/main/linear/fake-linear-issues';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// Changes that didn't reach a Source are never easy to miss (#206), end to end against a fake Linear on
// this machine (never the real one): a change Linear refuses shows Couldn't sync on the issue, in
// Settings → Accounts (counted, and listed with what it was, on which issue, when and why) and in the
// Update ("A change you made didn't reach Linear: moving ENG-418 to In Review…"). Retry from the
// Update's line sends it; Discard in Settings puts the issue back as Linear has it. Tokens are stored
// in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_couldnt_sync_key';
const ME = viewerOf(ACME);
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const STARTED = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let linear: FakeLinear;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.setCatalog(ACME.id, [
    { team: ENG, states: FAKE_STATES, members: [ME], labels: FAKE_LABELS, cycles: [], projects: [] },
  ]);
  linear.issues.add(ACME.id, {
    id: 'issue-418',
    identifier: 'ENG-418',
    title: 'Fix the login loop',
    assignee: ME,
    state: STARTED,
    priority: 2,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

async function environment() {
  return {
    COMMANDER_TEST_LINEAR: JSON.stringify({
      clientId: null,
      port: await freePort(),
      authorizeUrl: linear.authorizeUrl,
      tokenUrl: linear.tokenUrl,
      apiUrl: linear.apiUrl,
    }),
  };
}

async function connect(window: Page) {
  await openSettings(window, 'Accounts');
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/1 issue/);
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

const remote = () => linear.issues.get('issue-418');
const field = (pane: Locator, name: string) => pane.locator(`[data-field="${name}"] dd`);
const updatePanel = (window: Page) => window.getByTestId('update-panel');

async function askForUpdate(window: Page) {
  await window.getByTestId('ares-status').getByRole('button', { name: 'Ask for an update' }).click();
  await expect(updatePanel(window)).toBeVisible();
}

test('a change Linear refuses shows on the issue, in Settings and in the Update; Retry sends it, Discard puts it back', async () => {
  commander = await launchCommander({ env: await environment() });
  const window = await commander.window();
  await connect(window);
  let pane = await openIssue(window);

  // On the issue: Couldn't sync, with the change as the User made it.
  linear.refuseWrites('The issue is locked for editing.');
  await pickOption(pane.getByRole('combobox', { name: 'State', exact: true }), /^In Review$/, /In Review/);
  const alert = pane.getByRole('alert');
  await expect(alert).toContainText('Couldn’t sync');
  await expect(field(pane, 'state')).toHaveText('In Review');

  // In Settings → Accounts: counted beside the Account's sync, and listed with what, where, when and why.
  await openSettings(window);
  await settingsPage(window, 'Accounts');
  const outgoing = window.getByTestId('account-outgoing');
  await expect(outgoing.getByTestId('account-outgoing-counts')).toHaveText('1 change couldn’t sync');
  await outgoing.getByRole('button', { name: 'Show changes' }).click();
  const change = outgoing.getByTestId('outgoing-change');
  await expect(change).toContainText('Move to In Review');
  await expect(change).toContainText('ENG-418');
  await expect(change).toContainText('Fix the login loop');
  await expect(change.getByTestId('outgoing-change-state')).toContainText(
    /Couldn’t sync · Made \d\d:\d\d · Linear refused the change: The issue is locked for editing\./,
  );

  // In the Update: a Needs you now line in Commander's own words, with Retry.
  await askForUpdate(window);
  const now = updatePanel(window).getByRole('region', { name: 'Needs you now' });
  const line = now.getByTestId('update-line').filter({ hasText: 'didn’t reach Linear' });
  await expect(line).toContainText(
    'A change you made didn’t reach Linear (Acme): moving ENG-418 to In Review.',
  );
  await expect(line.getByTestId('update-row')).toContainText('Couldn’t sync: Move to In Review');

  // Retry from the line: it reaches Linear, and the issue no longer says Couldn't sync.
  linear.refuseWrites(null);
  await line.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => remote().state.name).toBe('In Review');
  await window.keyboard.press('Escape');
  pane = await openIssue(window);
  await expect(pane.getByRole('alert')).toBeHidden();

  // Another change refused, then discarded in Settings: the issue goes back to what Linear has.
  linear.refuseWrites('The issue is locked for editing.');
  await pickOption(pane.getByRole('combobox', { name: 'Priority', exact: true }), /^Urgent$/, /Urgent/);
  await expect(pane.getByRole('alert')).toContainText('Couldn’t sync');
  await openSettings(window);
  await settingsPage(window, 'Accounts');
  await expect(outgoing.getByTestId('account-outgoing-counts')).toHaveText('1 change couldn’t sync');
  const shown = outgoing.getByRole('button', { name: 'Show changes' });
  if (await shown.isVisible()) await shown.click();
  await outgoing.getByRole('button', { name: 'Discard: Set the priority to Urgent' }).click();
  const dialog = window.getByTestId('discard-change-dialog');
  await expect(dialog).toContainText('ENG-418 goes back to what the Source has');
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(outgoing).toBeHidden();
  expect(remote().priority).toBe(2);

  pane = await openIssue(window);
  await expect(field(pane, 'priority')).toHaveText(/High/);
  await expect(pane.getByRole('alert')).toBeHidden();
  // Nothing is left to say about it in the Update.
  await askForUpdate(window);
  await expect(
    updatePanel(window).getByTestId('update-line').filter({ hasText: 'didn’t reach Linear' }),
  ).toHaveCount(0);
});
