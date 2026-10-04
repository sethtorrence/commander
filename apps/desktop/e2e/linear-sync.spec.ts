import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// Linear sync end to end, against a fake Linear on this machine (never the real one): issues arrive
// as Items, Settings → Accounts shows the sync, Sync now picks up changes, the cadence setting
// persists, and a key revoked in Linear shows Reconnect. Tokens are stored in the real keyring, so
// these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_sync_key';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function pointAtFakeLinear(linear: FakeLinear) {
  const config = {
    clientId: null,
    port: await freePort(),
    authorizeUrl: linear.authorizeUrl,
    tokenUrl: linear.tokenUrl,
    apiUrl: linear.apiUrl,
  };
  return { COMMANDER_TEST_LINEAR: JSON.stringify(config) };
}

async function openAccounts(window: Page): Promise<Locator> {
  await openSettings(window);
  const panel = window.getByTestId('accounts-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function connectWithKey(panel: Locator) {
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByTestId('account-name')).toHaveText(['Acme']);
}

// The Linear issues Commander holds, as the window sees them through the Item store.
function linearItems(page: Page) {
  return page.evaluate(async () => {
    const items = await window.commander.itemStore({ op: 'query', query: { kinds: ['linear-issue'] } });
    return items
      .map((item) => ({ title: item.title, status: item.status }))
      .sort((a, b) => a.title.localeCompare(b.title));
  });
}

function everyFile(dir: string): string {
  const contents: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isFile()) contents.push(readFileSync(path).toString('latin1'));
    } catch {
      // Sockets and files that vanish mid-walk.
    }
  }
  return contents.join('\n');
}

let linear: FakeLinear;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.add(ACME.id, { id: 'issue-418', identifier: 'ENG-418', title: 'Fix the login loop' });
  linear.issues.add(ACME.id, {
    id: 'issue-401',
    identifier: 'ENG-401',
    title: 'Rotate the signing keys',
    state: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
    completedAt: new Date().toISOString(),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

test('a connected Account’s issues arrive as Items, and Sync now picks up what changed in Linear', async () => {
  const env = await pointAtFakeLinear(linear);
  commander = await launchCommander({ env });
  const window = await commander.app.firstWindow();
  const panel = await openAccounts(window);

  await connectWithKey(panel);

  const sync = panel.getByTestId('account-sync');
  await expect(sync.getByTestId('account-synced')).toHaveText(/^Synced \d\d:\d\d · 2 issues$/);
  await expect(sync.getByTestId('account-next-sync')).toHaveText(/^Next sync \d\d:\d\d$/);
  expect(await linearItems(window)).toEqual([
    { title: 'Fix the login loop', status: 'open' },
    { title: 'Rotate the signing keys', status: 'done' },
  ]);

  // Changes in Linear arrive with the next sync: a new issue, an edit, and an archived issue.
  linear.issues.add(ACME.id, { id: 'issue-430', identifier: 'ENG-430', title: 'Add audit events' });
  linear.issues.update('issue-418', { title: 'Fix the login loop for good' });
  linear.issues.archive('issue-401');
  await sync.getByRole('button', { name: 'Sync now' }).click();

  await expect
    .poll(() => linearItems(window))
    .toEqual([
      { title: 'Add audit events', status: 'open' },
      { title: 'Fix the login loop for good', status: 'open' },
    ]);
  await expect(sync.getByTestId('account-synced')).toHaveText(/· 2 issues$/);
  expect(linear.graphqlRequests.map((request) => request.operationName)).toContain(
    'CommanderChangedComments',
  );

  // The key never reaches Commander's files: not the database, not the Accounts file.
  expect(everyFile(commander.userDataDir)).not.toContain(API_KEY);
});

test('the sync cadence can be set to 30 or 60 minutes, and stays set after a restart', async () => {
  const env = await pointAtFakeLinear(linear);
  const first = await launchCommander({ env });
  commander = first;
  let window = await first.app.firstWindow();
  let panel = await openAccounts(window);
  await connectWithKey(panel);
  await expect(panel.getByTestId('account-synced')).toHaveText(/2 issues/);

  await pickOption(panel.getByRole('combobox', { name: 'How often to sync Acme' }), 'Every 30 min');
  await first.app.close();

  commander = await launchCommander({ userDataDir: first.userDataDir, env });
  window = await commander.app.firstWindow();
  panel = await openAccounts(window);
  await expect(panel.getByRole('combobox', { name: 'How often to sync Acme' })).toHaveText('Every 30 min');
  await expect(panel.getByTestId('account-synced')).toHaveText(/2 issues/);
});

test('an API key revoked in Linear shows Reconnect', async () => {
  const env = await pointAtFakeLinear(linear);
  commander = await launchCommander({ env });
  const window = await commander.app.firstWindow();
  const panel = await openAccounts(window);
  await connectWithKey(panel);
  await expect(panel.getByTestId('account-synced')).toHaveText(/2 issues/);

  linear.revokeApiKey(API_KEY);
  await panel.getByRole('button', { name: 'Sync now' }).click();

  const account = panel.getByTestId('account');
  await expect(account.getByTestId('account-status')).toHaveText('Needs reconnecting');
  await expect(account.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(panel.getByTestId('account-next-sync')).toHaveText('Paused until reconnected');
});
