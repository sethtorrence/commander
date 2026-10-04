import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Connecting Google Accounts end to end, against a fake Google on this machine (never the real one).
// Tokens are stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const GMAIL = 'https://www.googleapis.com/auth/gmail.modify';

function pointAtFakeGoogle(google: FakeGoogle) {
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
  };
  return { COMMANDER_TEST_GOOGLE: JSON.stringify(config) };
}

// The system browser, as far as sign-in is concerned: follows Google's consent page (which the fake
// approves at once) back to Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

async function openGoogleAccounts(window: Page) {
  await openSettings(window);
  const google = window.getByTestId('accounts-panel').getByTestId('source-google');
  await expect(google).toBeAttached();
  return google;
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

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
});

test('without Commander’s Google client in the build, Connect Google is hidden and the README is named', async () => {
  commander = await launchCommander();
  const window = await commander.app.firstWindow();

  const section = await openGoogleAccounts(window);

  await expect(section.getByText('See “Connecting Google” in the README')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Connect Google' })).toHaveCount(0);
});

test('Connect Google signs in through the browser; the Account lists Gmail and Google Calendar, keeps no token outside the keyring, and can be removed', async () => {
  const env = pointAtFakeGoogle(google);
  commander = await launchCommander({ env });
  const logs: string[] = [];
  commander.app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  commander.app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const window = await commander.app.firstWindow();
  window.on('console', (message) => logs.push(message.text()));
  await standInForTheBrowser(commander.app);
  const section = await openGoogleAccounts(window);

  await section.getByRole('button', { name: 'Connect Google' }).click();

  await expect(section.getByTestId('account-name')).toHaveText(['Google · alex@gmail.test']);
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  await expect(section.getByRole('switch', { name: 'Gmail' })).toHaveAttribute('aria-checked', 'true');
  await expect(section.getByRole('switch', { name: 'Google Calendar' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(google.authorizeRequests).toMatchObject([
    {
      client_id: google.clientId,
      code_challenge_method: 'S256',
      access_type: 'offline',
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    },
  ]);

  // Connecting the same Google identity again updates the one Account.
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect.poll(() => google.tokenRequests.length).toBe(2);
  await expect(section.getByTestId('waiting-for-browser')).toHaveCount(0);
  await expect(section.getByTestId('account-name')).toHaveText(['Google · alex@gmail.test']);

  const seen = [
    everyFile(commander.userDataDir),
    logs.join('\n'),
    await window.evaluate(() => document.documentElement.outerHTML),
  ].join('\n');
  for (const secret of [...google.issuedTokens(), google.clientSecret]) expect(seen).not.toContain(secret);
  const credential = `account:google:${ALEX.sub}:credential`;
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).toContain(credential);

  // Remove, after confirming.
  await section.getByTestId('account').getByRole('button', { name: 'Remove' }).click();
  await window.getByRole('button', { name: 'Remove Google · alex@gmail.test' }).click();
  await expect(section.getByTestId('account')).toHaveCount(0);
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).not.toContain('account:google');
});

test('a permission unticked on Google’s consent screen leaves that Source off, and Grant access switches it on', async () => {
  google.untick([GMAIL]);
  commander = await launchCommander({ env: pointAtFakeGoogle(google) });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  const section = await openGoogleAccounts(window);

  await section.getByRole('button', { name: 'Connect Google' }).click();

  const gmail = section.getByTestId('carried-source-gmail');
  await expect(gmail.getByRole('switch', { name: 'Gmail' })).toHaveAttribute('aria-checked', 'false');
  await expect(section.getByRole('switch', { name: 'Google Calendar' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  google.untick([]);
  await gmail.getByRole('button', { name: 'Grant access' }).click();

  await expect(gmail.getByRole('switch', { name: 'Gmail' })).toHaveAttribute('aria-checked', 'true');
  await expect(gmail.getByRole('button', { name: 'Grant access' })).toHaveCount(0);
  await expect(section.getByTestId('account')).toHaveCount(1);
});

test('a Workspace whose admin has blocked Commander is explained plainly', async () => {
  google.block('admin_policy_enforced');
  commander = await launchCommander({ env: pointAtFakeGoogle(google) });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  const section = await openGoogleAccounts(window);

  await section.getByRole('button', { name: 'Connect Google' }).click();

  await expect(section.getByTestId('accounts-error')).toHaveText(
    'Your Google Workspace admin hasn’t allowed Commander. Ask them to allow it, or connect a personal account.',
  );
  await expect(section.getByTestId('account')).toHaveCount(0);
});
