import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Connecting Outlook Accounts (mail and calendar on one sign-in) end to end, against a fake Microsoft
// identity platform and Graph on this machine (never the real ones). Tokens are stored in the real
// keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

function pointAtFakeMicrosoft(microsoft: FakeMicrosoft) {
  const config = {
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  };
  return { COMMANDER_TEST_MICROSOFT: JSON.stringify(config) };
}

// The system browser, as far as sign-in is concerned: follows Microsoft's consent page (which the
// fake approves at once) back to Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

async function openOutlookAccounts(window: Page) {
  await openSettings(window, 'Accounts');
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await expect(outlook).toBeAttached();
  return outlook;
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

// The keyring's file (secrets encrypted, key names in the clear), or nothing before the first secret.
function keyringFile(userDataDir: string): string {
  const path = join(userDataDir, 'secrets.json');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
});

test('without Commander’s Microsoft app in the build, Connect Outlook is hidden and the README is named', async () => {
  commander = await launchCommander();
  const window = await commander.window();

  const outlook = await openOutlookAccounts(window);

  await expect(outlook.getByText('See “Connecting Outlook” in the README')).toBeVisible();
  await expect(outlook.getByRole('button', { name: 'Connect Outlook' })).toHaveCount(0);
});

test('Connect Outlook signs in through the browser; the Account lists Outlook and Outlook Calendar, keeps no token outside the keyring, and can be removed', async () => {
  const env = pointAtFakeMicrosoft(microsoft);
  commander = await launchCommander({ env });
  const logs: string[] = [];
  commander.app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  commander.app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const window = await commander.window();
  window.on('console', (message) => logs.push(message.text()));
  await standInForTheBrowser(commander.app);
  const outlook = await openOutlookAccounts(window);

  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();

  await expect(outlook.getByTestId('account-name')).toHaveText(['Outlook · sam@contoso.test']);
  await expect(outlook.getByTestId('account-status')).toHaveText('Connected');
  await expect(outlook.getByRole('switch', { name: 'Outlook', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(outlook.getByRole('switch', { name: 'Outlook Calendar' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(microsoft.authorizeRequests).toMatchObject([
    {
      client_id: microsoft.clientId,
      code_challenge_method: 'S256',
      redirect_uri: expect.stringMatching(/^http:\/\/localhost:\d+$/),
      scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite',
    },
  ]);

  // Connecting the same user again updates the one Account.
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  await expect.poll(() => microsoft.issuedTokens().length).toBe(4);
  await expect(outlook.getByTestId('waiting-for-browser')).toHaveCount(0);
  await expect(outlook.getByTestId('account-name')).toHaveText(['Outlook · sam@contoso.test']);
  // Teams keeps its own Account: connecting Outlook adds none there.
  await expect(window.getByTestId('source-teams').getByTestId('account')).toHaveCount(0);

  const seen = [
    everyFile(commander.userDataDir),
    logs.join('\n'),
    await window.evaluate(() => document.documentElement.outerHTML),
  ].join('\n');
  for (const token of microsoft.issuedTokens()) expect(seen).not.toContain(token);
  const credential = `account:outlook:${microsoft.tenantId}:${SAM.id}:credential`;
  expect(keyringFile(commander.userDataDir)).toContain(credential);

  // Remove, after confirming.
  await outlook.getByTestId('account').getByRole('button', { name: 'Remove' }).click();
  await window.getByRole('button', { name: 'Remove Outlook · sam@contoso.test' }).click();
  await expect(outlook.getByTestId('account')).toHaveCount(0);
  expect(keyringFile(commander.userDataDir)).not.toContain('account:outlook');
});

test('a tenant that needs admin consent is explained, with the mail and calendar permissions and the admin consent link', async () => {
  microsoft.requireAdminConsent('AADSTS90094');
  commander = await launchCommander({ env: pointAtFakeMicrosoft(microsoft) });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  const outlook = await openOutlookAccounts(window);

  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();

  const problem = outlook.getByTestId('accounts-error');
  await expect(problem).toContainText(
    'needs an administrator to approve Commander before you can connect Outlook mail and calendar',
  );
  await expect(problem.getByTestId('admin-consent-permissions').getByRole('listitem')).toContainText([
    'Mail.ReadWrite',
    'Mail.Send',
    'Calendars.ReadWrite',
  ]);
  await expect(problem.getByLabel('Admin consent link')).toHaveValue(
    `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
  );
  await expect(outlook.getByTestId('account')).toHaveCount(0);
  expect(keyringFile(commander.userDataDir)).not.toContain('account:outlook');
});
