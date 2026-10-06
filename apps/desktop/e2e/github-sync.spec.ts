import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// GitHub sync end to end (#114), against a fake GitHub on this machine (never the real one):
// connecting GitHub brings the watched repos' pull requests, issues, review requests and releases in;
// Settings → Accounts shows the sync, the last hour's use of GitHub's limits and Sync now, which
// costs nothing when every gate answers 304; Ctrl+K finds a pull request by repo#123 and by words in
// its body; and GitHub asking Commander to slow down is shown and waited out. Tokens are stored in
// the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

let github: FakeGitHub;
let commander: LaunchedCommander | undefined;
let emptyPath: string;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  emptyPath = mkdtempSync(join(tmpdir(), 'commander-e2e-path-'));
  github = await startFakeGitHub({ interval: 1 });
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(2) });
  github.addRepo({ owner: 'acme-org', name: 'web', pushedAt: hoursAgo(30) });
  github.install({ login: 'acme-org', type: 'Organization' });
  github.install({ login: 'octocat', type: 'User' });
  // octocat worked in acme-org/api lately, so Commander starts by watching it.
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 12,
    title: 'Retry webhooks with back-off',
    body: 'Retries failed deliveries with exponential back-off and a dead-letter queue.',
    author: 'priya',
    reviewers: ['octocat'],
    updatedAt: hoursAgo(3),
  });
  github.addIssue({
    repo: 'acme-org/api',
    number: 30,
    title: 'Webhooks drop on 502',
    author: 'priya',
    assignees: ['octocat'],
    updatedAt: hoursAgo(4),
  });
  github.addRelease({
    repo: 'acme-org/api',
    tag: 'v1.4.0',
    name: 'Faster lookups',
    publishedAt: hoursAgo(5),
  });
  // web isn't watched: its pull request stays out.
  github.addPullRequest({
    repo: 'acme-org/web',
    number: 7,
    title: 'Dark mode',
    author: 'sam',
    updatedAt: hoursAgo(1),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await github?.close();
  if (emptyPath) rmSync(emptyPath, { recursive: true, force: true });
});

function pointAtFakeGitHub() {
  const config = {
    clientId: github.clientId,
    appSlug: github.appSlug,
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  };
  return { COMMANDER_TEST_GITHUB: JSON.stringify(config), PATH: emptyPath };
}

async function connectGitHub(window: Page) {
  await openSettings(window, 'Accounts');
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-github');
  await accounts.getByRole('button', { name: 'Connect GitHub' }).click();
  const code = window.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(github.enterCode((await code.textContent()) ?? '')).toBe(true);
  await expect(accounts.getByTestId('account-name')).toHaveText(['octocat']);
  return accounts;
}

const gitHubItems = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'query', query: { source: 'github' } }));

test('connecting GitHub brings the watched repos’ work in; Settings shows the sync and its cost; Sync now with nothing changed costs no REST requests; Ctrl+K finds a pull request', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const window = await commander.app.firstWindow();
  const accounts = await connectGitHub(window);

  // The first sync: a pull request, the review asked of octocat, an issue and a release.
  const sync = accounts.getByTestId('account-sync');
  await expect(sync.getByTestId('account-synced')).toHaveText(/^Synced \d\d:\d\d · 4 items$/);
  expect((await gitHubItems(window)).map((item) => `${item.kind} ${item.title}`).sort()).toEqual([
    'github-issue Webhooks drop on 502',
    'github-release api Faster lookups',
    'pull-request Retry webhooks with back-off',
    'review-request Retry webhooks with back-off',
  ]);
  await expect(sync.getByTestId('account-cadence')).toHaveText('Syncs every 15 min');
  await expect(sync.getByTestId('account-hour-use')).toHaveText(
    /^Last hour: \d+ of 5,000 REST requests · \d+ of 5,000 GraphQL points$/,
  );

  // Nothing changed: Sync now asks for open work and gets 304s from every gate. (GitHub wouldn't list
  // the app's token octocat's teams at the first sync: that is asked again tomorrow.)
  const before = github.apiRequests.length;
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await expect
    .poll(() => github.apiRequests.slice(before))
    .toEqual([
      'POST /graphql CommanderOpenWork',
      'GET /orgs/acme-org/repos 304',
      'GET /orgs/acme-org/issues 304',
    ]);

  // Ctrl+K finds the pull request by repo#number and by words in its body.
  await window.keyboard.press('Escape');
  await window.keyboard.press('Control+k');
  const palette = window.getByTestId('palette');
  const input = palette.getByRole('combobox', { name: 'Search Commander' });
  await input.fill('api#12');
  await expect(palette.getByRole('option', { name: /Retry webhooks with back-off/ }).first()).toBeVisible();
  await expect(palette.getByText('GitHub', { exact: true }).first()).toBeVisible();
  await input.fill('dead-letter queue');
  await expect(palette.getByRole('option', { name: /Retry webhooks with back-off/ }).first()).toBeVisible();
});

test('GitHub asking Commander to slow down is shown, and Sync now waits it out', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const window = await commander.app.firstWindow();
  const accounts = await connectGitHub(window);
  const sync = accounts.getByTestId('account-sync');
  await expect(sync.getByTestId('account-synced')).toHaveText(/· 4 items$/);

  github.throttleApi({ status: 429, retryAfter: 3600 });
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await expect(sync.getByTestId('account-sync-problem')).toHaveText('GitHub asked Commander to slow down.');
  await expect(sync.getByTestId('account-next-sync')).toHaveText(/^Trying again at /);

  const before = github.apiRequests.length;
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await window.waitForTimeout(500);
  expect(github.apiRequests.length).toBe(before);
});
