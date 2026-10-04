import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Connecting Teams Accounts end to end, against a fake Microsoft identity platform and Graph on this
// machine (never the real ones). Tokens are stored in the real keyring, so these need the author's
// Linux Wayland session.
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

async function openTeamsAccounts(window: Page) {
  await openSettings(window);
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await expect(teams.getByRole('button', { name: 'Connect Teams' })).toBeVisible();
  return teams;
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

test('without Commander’s Microsoft app in the build, Connect Teams is disabled and points to the README', async () => {
  commander = await launchCommander();
  const window = await commander.app.firstWindow();

  const teams = await openTeamsAccounts(window);

  await expect(teams.getByRole('button', { name: 'Connect Teams' })).toBeDisabled();
  await expect(teams.getByText('See “Connecting Teams” in the README')).toBeVisible();
});

test('Connect Teams signs in through the browser; the Account survives a restart, keeps no token outside the keyring, and can be removed', async () => {
  const env = pointAtFakeMicrosoft(microsoft);
  const first = await launchCommander({ env });
  commander = first;
  const logs: string[] = [];
  first.app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  first.app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  let window = await first.app.firstWindow();
  window.on('console', (message) => logs.push(message.text()));
  await standInForTheBrowser(first.app);
  let teams = await openTeamsAccounts(window);

  await teams.getByRole('button', { name: 'Connect Teams' }).click();

  await expect(teams.getByTestId('account-name')).toHaveText(['Teams · sam@contoso.test']);
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  expect(microsoft.authorizeRequests).toMatchObject([
    {
      client_id: microsoft.clientId,
      code_challenge_method: 'S256',
      redirect_uri: expect.stringMatching(/^http:\/\/localhost:\d+$/),
    },
  ]);

  // Connecting the same user again updates the one Account.
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect.poll(() => microsoft.issuedTokens().length).toBe(4);
  await expect(teams.getByTestId('waiting-for-browser')).toHaveCount(0);
  await expect(teams.getByTestId('account-name')).toHaveText(['Teams · sam@contoso.test']);

  const seen = [
    everyFile(first.userDataDir),
    logs.join('\n'),
    await window.evaluate(() => document.documentElement.outerHTML),
  ].join('\n');
  for (const token of microsoft.issuedTokens()) expect(seen).not.toContain(token);
  await first.app.close();

  // Restart on the same data.
  commander = await launchCommander({ userDataDir: first.userDataDir, env });
  window = await commander.app.firstWindow();
  teams = await openTeamsAccounts(window);
  await expect(teams.getByTestId('account-name')).toHaveText(['Teams · sam@contoso.test']);
  const credential = `account:teams:${microsoft.tenantId}:${SAM.id}:credential`;
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).toContain(credential);

  // Remove, after confirming.
  await teams.getByTestId('account').getByRole('button', { name: 'Remove' }).click();
  await window.getByRole('button', { name: 'Remove Teams · sam@contoso.test' }).click();
  await expect(teams.getByTestId('account')).toHaveCount(0);
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).not.toContain('account:teams');
});

test('a tenant that needs admin consent is explained, with the permissions and the admin consent link', async () => {
  microsoft.requireAdminConsent('AADSTS90094');
  commander = await launchCommander({ env: pointAtFakeMicrosoft(microsoft) });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  const teams = await openTeamsAccounts(window);

  await teams.getByRole('button', { name: 'Connect Teams' }).click();

  const problem = teams.getByTestId('accounts-error');
  await expect(problem).toContainText('needs an administrator to approve Commander');
  await expect(problem.getByTestId('admin-consent-permissions').getByRole('listitem')).toContainText([
    'Chat.ReadWrite',
    'ChatMessage.Send',
    'Team.ReadBasic.All',
    'Channel.ReadBasic.All',
  ]);
  await expect(problem.getByLabel('Admin consent link')).toHaveValue(
    `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
  );
  await expect(teams.getByTestId('account')).toHaveCount(0);
});
