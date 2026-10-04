import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Connecting GitHub Accounts end to end, against a fake GitHub on this machine (never the real one):
// the device flow with Commander's GitHub App, a classic token and gh's sign-in (a stand-in gh on
// the PATH, so the real gh is never run). Tokens are stored in the real keyring, so these need the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const MONA = { id: 1_000_002, login: 'mona', name: 'Mona Lisa' };

let github: FakeGitHub;
let commander: LaunchedCommander | undefined;
let ghDir: string;
let ghToken: string;

// COMMANDER_TEST_GITHUB points Commander at the fake; `app: false` for a build without the GitHub
// App. The stand-in gh comes first on the PATH.
function pointAtFakeGitHub({ app = true } = {}) {
  const config = {
    clientId: app ? github.clientId : null,
    appSlug: app ? github.appSlug : null,
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  };
  return {
    COMMANDER_TEST_GITHUB: JSON.stringify(config),
    PATH: `${ghDir}${delimiter}${process.env.PATH ?? ''}`,
  };
}

// The system browser: remembers every page Commander opens, without going anywhere.
async function recordTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedUrls: opened });
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

const openedUrls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls);

async function openGitHubAccounts(window: Page) {
  await openSettings(window);
  const section = window.getByTestId('accounts-panel').getByTestId('source-github');
  await expect(section).toBeVisible();
  return section;
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

function captureLogs(launched: LaunchedCommander, window: Page): string[] {
  const logs: string[] = [];
  launched.app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  launched.app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  window.on('console', (message) => logs.push(message.text()));
  return logs;
}

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  github = await startFakeGitHub({ interval: 1 });
  ghToken = github.personalToken({ kind: 'oauth', scopes: ['gist', 'read:org', 'repo', 'workflow'] });
  ghDir = mkdtempSync(join(tmpdir(), 'commander-e2e-gh-'));
  const gh = join(ghDir, 'gh');
  writeFileSync(gh, `#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo ${ghToken} || exit 1\n`);
  chmodSync(gh, 0o755);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await github?.close();
  if (ghDir) rmSync(ghDir, { recursive: true, force: true });
});

test('Connect GitHub shows a code to enter on GitHub; the Account lists where the app is installed, survives a restart, keeps no token outside the keyring, and can be removed', async () => {
  github.install({ login: 'octocat', type: 'User' });
  github.install({ login: 'acme-org', type: 'Organization' });
  const env = pointAtFakeGitHub();
  const first = await launchCommander({ env });
  commander = first;
  let window = await first.window();
  const logs = captureLogs(first, window);
  await recordTheBrowser(first.app);
  let section = await openGitHubAccounts(window);

  await section.getByRole('button', { name: 'Connect GitHub' }).click();

  const dialog = window.getByTestId('github-device-code');
  const code = dialog.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const userCode = (await code.textContent()) ?? '';
  expect(github.userCodes()).toEqual([userCode]);
  await dialog.getByRole('button', { name: 'Copy code' }).click();
  await expect.poll(() => first.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(userCode);
  await dialog.getByRole('link', { name: 'Open GitHub' }).click();
  await expect.poll(() => openedUrls(first.app)).toEqual([`${github.webUrl}/login/device`]);
  // Polling at GitHub's interval, nothing yet.
  await expect.poll(() => github.tokenRequests.length).toBeGreaterThan(0);
  await expect(section.getByTestId('account')).toHaveCount(0);

  // The User enters the code on GitHub and approves.
  expect(github.enterCode(userCode)).toBe(true);

  await expect(dialog).toHaveCount(0);
  await expect(section.getByTestId('account-name')).toHaveText(['octocat']);
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  await expect(section.getByText('GitHub user · The Octocat · Signed in with the GitHub App')).toBeVisible();
  const installations = section.getByTestId('github-installations');
  await expect(installations).toContainText('Installed on octocat, acme-org');
  await installations.getByRole('link', { name: 'Install on another org…' }).click();
  await expect
    .poll(() => openedUrls(first.app))
    .toContain(`${github.webUrl}/apps/${github.appSlug}/installations/new`);

  // Installed on another org: Check again shows it.
  github.install({ login: 'globex', type: 'Organization' });
  await installations.getByRole('button', { name: 'Check again' }).click();
  await expect(installations).toContainText('Installed on octocat, acme-org, globex');

  for (const request of [...github.deviceCodeRequests, ...github.tokenRequests])
    expect(Object.keys(request)).not.toContain('client_secret');
  const seen = [
    everyFile(first.userDataDir),
    logs.join('\n'),
    await window.evaluate(() => document.documentElement.outerHTML),
  ].join('\n');
  for (const secret of github.secrets()) expect(seen).not.toContain(secret);
  await first.app.close();

  // Restart on the same data.
  commander = await launchCommander({ userDataDir: first.userDataDir, env });
  window = await commander.window();
  section = await openGitHubAccounts(window);
  await expect(section.getByTestId('account-name')).toHaveText(['octocat']);
  const credential = `account:github:${OCTOCAT.id}:credential`;
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).toContain(credential);

  // Remove, after confirming.
  await section.getByTestId('account').getByRole('button', { name: 'Remove' }).click();
  await window.getByRole('button', { name: 'Remove octocat' }).click();
  await expect(section.getByTestId('account')).toHaveCount(0);
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).not.toContain('account:github');
});

test('a code declined on GitHub is explained, and nothing is connected', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const window = await commander.window();
  await recordTheBrowser(commander.app);
  const section = await openGitHubAccounts(window);

  await section.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(window.getByTestId('github-user-code')).toBeVisible();
  github.deny();

  await expect(section.getByTestId('accounts-error')).toContainText('You declined Commander on GitHub');
  await expect(window.getByTestId('github-device-code')).toHaveCount(0);
  await expect(section.getByTestId('account')).toHaveCount(0);
});

test('without Commander’s GitHub App, only a classic token and gh’s sign-in are offered; both connect, survive a restart unrefreshed, and can be removed', async () => {
  const env = pointAtFakeGitHub({ app: false });
  const first = await launchCommander({ env });
  commander = first;
  let window = await first.window();
  const logs = captureLogs(first, window);
  let section = await openGitHubAccounts(window);

  await expect(section.getByText('This build has no GitHub App set up')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);

  // gh's sign-in.
  await section.getByRole('button', { name: 'Use my gh sign-in' }).click();
  await expect(section.getByTestId('account-name')).toHaveText(['octocat']);
  await expect(section.getByText('GitHub user · The Octocat · Signed in with gh')).toBeVisible();

  // A token missing a scope is turned away, saying which.
  const field = section.getByLabel('GitHub classic personal access token');
  await field.fill(github.personalToken({ user: MONA, kind: 'classic', scopes: ['repo'] }));
  await section.getByRole('button', { name: 'Connect with token' }).click();
  await expect(section.getByTestId('accounts-error')).toContainText('missing the read:org scope');

  // A classic token with what Commander needs.
  await field.fill(github.personalToken({ user: MONA, kind: 'classic' }));
  await section.getByRole('button', { name: 'Connect with token' }).click();
  await expect(section.getByTestId('account-name')).toHaveText(['octocat', 'mona']);
  await expect(section.getByText('GitHub user · Mona Lisa · Classic personal access token')).toBeVisible();
  await expect(section.getByTestId('github-installations')).toHaveCount(0);

  const seen = [
    everyFile(first.userDataDir),
    logs.join('\n'),
    await window.evaluate(() => document.documentElement.outerHTML),
  ].join('\n');
  for (const secret of github.secrets()) expect(seen).not.toContain(secret);
  await first.app.close();

  // Restart on the same data: both still there, and neither was ever refreshed.
  commander = await launchCommander({ userDataDir: first.userDataDir, env });
  window = await commander.window();
  section = await openGitHubAccounts(window);
  await expect(section.getByTestId('account-name')).toHaveText(['octocat', 'mona']);
  await expect(section.getByTestId('account-status')).toHaveText(['Connected', 'Connected']);
  expect(github.tokenRequests).toEqual([]);

  for (const [name, left] of [
    ['octocat', 1],
    ['mona', 0],
  ] as const) {
    await section.getByTestId('account').first().getByRole('button', { name: 'Remove' }).click();
    await window.getByRole('button', { name: `Remove ${name}` }).click();
    await expect(section.getByTestId('account')).toHaveCount(left);
  }
  expect(readFileSync(join(commander.userDataDir, 'secrets.json'), 'utf8')).not.toContain('account:github');
});
