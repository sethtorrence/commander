import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The User's open work on GitHub end to end (#116), against a fake GitHub on this machine (never the
// real one): a review asked of octocat arrives, becomes a GitHub Todo and a Dashboard row, and both
// go once the review is submitted on GitHub. Tokens are stored in the real keyring, so this needs the
// author's Linux Wayland session.
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
  github.install({ login: 'acme-org', type: 'Organization' });
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 12,
    title: 'Retry webhooks with back-off',
    author: 'priya',
    reviewers: ['octocat'],
    createdAt: hoursAgo(50),
    updatedAt: hoursAgo(1),
  });
  github.addIssue({
    repo: 'acme-org/api',
    number: 30,
    title: 'Webhooks drop on 502',
    author: 'priya',
    assignees: ['octocat'],
    updatedAt: hoursAgo(5),
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
  // The pull request, the review asked of octocat, and the issue assigned to them.
  await expect(accounts.getByTestId('account-synced')).toHaveText(/· 3 items$/);
  await window.keyboard.press('Escape');
}

test('a review request arrives as a GitHub Todo and a Dashboard row, and both go once the review is submitted', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const window = await commander.window();
  await connectGitHub(window);

  // Todos: the review and the assigned issue, each labelled GitHub with its pull request or issue.
  await tab(window, 'Todos').click();
  const todos = window.getByTestId('section-todos').getByRole('region', { name: 'Open' });
  const review = todos.getByRole('listitem').filter({ hasText: 'Review: Retry webhooks with back-off' });
  await expect(review).toContainText('GitHub · acme-org/api#12');
  await expect(todos.getByRole('listitem').filter({ hasText: 'Webhooks drop on 502' })).toContainText(
    'GitHub · acme-org/api#30',
  );

  // The Dashboard: the review asked of octocat directly, in Today, stamped GH.
  await tab(window, 'Dashboard').click();
  const today = window.getByTestId('section-dashboard').getByRole('region', { name: 'Today' });
  const row = today.getByRole('listitem', { name: 'acme-org/api#12 Retry webhooks with back-off' });
  await expect(row.getByTestId('source-stamp')).toHaveText('GHReview requested');
  await expect(row.getByTestId('row-reason')).toHaveText(/asked for your review/);

  // octocat approves on GitHub. Opening the GitHub Section syncs at once.
  github.updatePullRequest('acme-org/api', 12, {
    reviewers: [],
    reviews: [{ author: 'octocat', state: 'APPROVED', submittedAt: new Date().toISOString() }],
  });
  const before = github.apiRequests.length;
  await tab(window, 'GitHub').click();
  await expect.poll(() => github.apiRequests.slice(before)).toContain('POST /graphql CommanderOpenWork');
  await expect(tab(window, 'GitHub').locator('.tc')).toHaveText('');

  // Both are gone: the Todo (tombstoned, saying why) and the Dashboard row.
  await tab(window, 'Dashboard').click();
  await expect(row).toHaveCount(0);
  await tab(window, 'Todos').click();
  await expect(review).toHaveCount(0);
  await expect(todos.getByRole('listitem').filter({ hasText: 'Webhooks drop on 502' })).toHaveCount(1);
});
