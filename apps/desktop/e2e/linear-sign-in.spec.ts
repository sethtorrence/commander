import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Connecting Linear Accounts end to end, against a fake Linear on this machine (never the real
// one). Tokens are stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function pointAtFakeLinear(linear: FakeLinear, clientId: string | null) {
  const config = {
    clientId,
    port: await freePort(),
    authorizeUrl: linear.authorizeUrl,
    tokenUrl: linear.tokenUrl,
    apiUrl: linear.apiUrl,
  };
  return { COMMANDER_TEST_LINEAR: JSON.stringify(config) };
}

// The system browser, as far as sign-in is concerned: follows Linear's consent page (which the fake
// approves at once) back to Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

async function openAccounts(window: Page) {
  await openSettings(window, 'Accounts');
  const panel = window.getByTestId('accounts-panel');
  await expect(panel).toBeVisible();
  return panel;
}

// Every file under a folder, as text, to search for secrets.
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
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

test('with no OAuth app in the build, an API key Account connects, survives a restart and can be removed', async () => {
  linear.addApiKey('lin_api_e2e_acme_key', ACME);
  const env = await pointAtFakeLinear(linear, null);
  const first = await launchCommander({ env });
  commander = first;
  let window = await first.window();
  let panel = await openAccounts(window);

  // Only the API key path is offered.
  await expect(panel.getByRole('button', { name: 'Connect Linear' })).toHaveCount(0);
  await expect(panel.getByText('This build has no Linear sign-in set up')).toBeVisible();

  // A wrong key is refused, with the reason.
  await panel.getByLabel('Linear personal API key').fill('lin_api_typo');
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('accounts-error')).toContainText('didn’t accept that API key');

  await panel.getByLabel('Linear personal API key').fill('lin_api_e2e_acme_key');
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  const account = panel.getByTestId('account');
  await expect(panel.getByTestId('account-name')).toHaveText(['Acme']);
  await expect(account.getByTestId('account-status')).toHaveText('Connected');
  await expect(panel.getByTestId('accounts-error')).toHaveCount(0);
  await first.app.close();

  // Restart on the same data.
  commander = await launchCommander({ userDataDir: first.userDataDir, env });
  window = await commander.window();
  panel = await openAccounts(window);
  await expect(panel.getByTestId('account-name')).toHaveText(['Acme']);
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).toContain(
    'account:linear:org-acme:credential',
  );

  // Remove, after confirming.
  await panel.getByTestId('account').getByRole('button', { name: 'Remove' }).click();
  await window.getByRole('button', { name: 'Remove Acme' }).click();
  await expect(panel.getByTestId('account')).toHaveCount(0);
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).not.toContain('account:linear');
});

test('Connect Linear signs in through the browser, and no token reaches the disk, the logs or the window', async () => {
  const env = await pointAtFakeLinear(linear, linear.clientId);
  commander = await launchCommander({ env });
  const logs: string[] = [];
  commander.app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  commander.app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const window = await commander.window();
  window.on('console', (message) => logs.push(message.text()));
  await standInForTheBrowser(commander.app);
  const panel = await openAccounts(window);

  await panel.getByRole('button', { name: 'Connect Linear' }).click();

  await expect(panel.getByTestId('account-name')).toHaveText(['Acme']);
  await expect(panel.getByText('Signed in with Linear')).toBeVisible();
  expect(linear.authorizeRequests).toMatchObject([
    { client_id: linear.clientId, code_challenge_method: 'S256', scope: 'read,write' },
  ]);

  // Connecting the same workspace again updates the one Account.
  await panel.getByRole('button', { name: 'Connect Linear' }).click();
  await expect.poll(() => linear.issuedTokens().length).toBe(4);
  await expect(panel.getByTestId('waiting-for-browser')).toHaveCount(0);
  await expect(panel.getByTestId('account-name')).toHaveText(['Acme']);

  const tokens = linear.issuedTokens();
  const seen = [
    everyFile(commander.userDataDir),
    logs.join('\n'),
    await window.evaluate(() => document.documentElement.outerHTML),
  ].join('\n');
  for (const token of tokens) expect(seen).not.toContain(token);
});
