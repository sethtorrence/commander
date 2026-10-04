import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Rules end to end, with issues from a fake Linear on this machine (never the real one) arriving
// through Linear sync: make a Rule in Settings, see the re-file preview, accept it and watch the
// Badges change, undo it, then see a new issue filed by the Rule as it arrives. Tokens are stored
// in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_rules_key';
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

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
  linear.issues.add(ACME.id, { identifier: 'ENG-418', title: 'Fix the login loop' });
  linear.issues.add(ACME.id, { identifier: 'ENG-420', title: 'Rotate the signing keys' });
  linear.issues.add(ACME.id, { identifier: 'OPS-7', title: 'Renew the certificate', team: OPS });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

const rows = (section: Locator) => section.getByTestId('linear-issue');
const row = (section: Locator, title: string) => rows(section).filter({ hasText: title });

// Leaves the Linear Section and comes back, which reads its issues again (and syncs).
async function reopenLinear(window: Page): Promise<Locator> {
  await tab(window, 'Todos').click();
  await tab(window, 'Linear').click();
  const section = window.getByTestId('section-linear');
  await section.getByRole('tab', { name: /All tickets/ }).click();
  return section;
}

test('create a Rule, preview and accept re-filing, see the Badges change, undo; new issues arrive filed', async () => {
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
  await openSettings(window);
  const accounts = window.getByTestId('accounts-panel');
  await accounts.getByLabel('Linear personal API key').fill(API_KEY);
  await accounts.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(accounts.getByTestId('account-synced')).toHaveText(/3 issues/);
  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Titanlink');
  await newProject.getByLabel('Badge code').fill('TL');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /TLTitanlink/,
  ]);

  // Settings → Rules: New Rule, team is ENG → TL, with a live count as it is written.
  await window.getByRole('button', { name: 'New Rule', exact: true }).click();
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await editor.getByRole('combobox', { name: 'Files into' }).selectOption({ label: 'TL · Titanlink' });
  await expect(
    editor.getByRole('combobox', { name: 'Value 1' }).getByRole('option', { name: 'ENG' }),
  ).toBeAttached();
  await editor.getByRole('combobox', { name: 'Value 1' }).selectOption({ label: 'ENG' });
  await expect(editor.getByRole('region', { name: 'Matching Items' })).toContainText('Matches 2 Items');
  await editor.getByRole('button', { name: 'Save Rule' }).click();

  // "Also re-file 2 existing items?", each with its current and new Badge.
  const offer = window.getByRole('dialog', { name: 'Re-file existing items' });
  await expect(offer).toContainText('Also re-file 2 existing items?');
  const preview = offer.getByRole('list', { name: 'Re-file preview' }).getByRole('listitem');
  await expect(preview).toHaveText([
    /Fix the login loop|Rotate the signing keys/,
    /Fix the login loop|Rotate the signing keys/,
  ]);
  await expect(preview.first().getByRole('img', { name: 'Unfiled' })).toBeVisible();
  await expect(preview.first().getByRole('img', { name: 'Titanlink' })).toBeVisible();
  await offer.getByRole('button', { name: 'Re-file 2 items' }).click();
  const refiled = window.locator('li[data-sonner-toast]').filter({ hasText: 'Re-filed 2 items' });
  await expect(refiled).toBeVisible();
  await expect(window.getByRole('list', { name: 'Rules' }).getByRole('listitem')).toHaveText([/team is ENG/]);

  // The Badges change in the Linear Section.
  const section = await reopenLinear(window);
  await expect(row(section, 'Fix the login loop').getByRole('img', { name: 'Titanlink' })).toBeVisible();
  await expect(row(section, 'Rotate the signing keys').getByRole('img', { name: 'Titanlink' })).toBeVisible();
  await expect(row(section, 'Renew the certificate').getByRole('img', { name: 'Unfiled' })).toBeVisible();

  // One Undo puts both back.
  await refiled.getByRole('button', { name: 'Undo' }).click();
  await expect(window.locator('li[data-sonner-toast]').filter({ hasText: 'Re-filing undone' })).toBeVisible();
  const after = await reopenLinear(window);
  await expect(row(after, 'Fix the login loop').getByRole('img', { name: 'Unfiled' })).toBeVisible();
  await expect(row(after, 'Rotate the signing keys').getByRole('img', { name: 'Unfiled' })).toBeVisible();

  // A new ENG issue arriving by sync is filed by the Rule, and its activity log says which.
  linear.issues.add(ACME.id, { identifier: 'ENG-430', title: 'Add audit events' });
  const synced = await reopenLinear(window);
  const added = row(synced, 'Add audit events');
  await expect(added.getByRole('img', { name: 'Titanlink' })).toBeVisible();
  await added.click();
  const activity = synced
    .getByRole('region', { name: 'Issue detail' })
    .getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('listitem').first()).toContainText('Filed under TL by Rule: team is ENG');
});
