import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The oversight summary end to end (#119), against a fake GitHub on this machine (never the real
// one): GitHub sync saves the pull requests and each repo's health, and the summary at the top of
// the GitHub Section puts yesterday's merged pull request under Shipped, a pull request with failing
// checks under Stuck and a failing default branch under On fire. Its lines open their Items. Tokens
// are stored in the real keyring, so these need the author's Linux Wayland session.
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
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(2), headChecks: 'FAILURE' });
  github.addRepo({ owner: 'acme-org', name: 'web', pushedAt: hoursAgo(3) });
  github.install({ login: 'acme-org', type: 'Organization' });
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  github.contribute(OCTOCAT.id, 'acme-org/web', 'review');
  // Merged yesterday (or earlier today): Shipped.
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 9,
    title: 'Cache the session lookups',
    author: 'sam',
    state: 'MERGED',
    createdAt: hoursAgo(200),
    updatedAt: hoursAgo(20),
  });
  // Open for days with failing checks: Stuck.
  github.addPullRequest({
    repo: 'acme-org/web',
    number: 7,
    title: 'Flaky deploy',
    author: 'priya',
    checks: 'FAILURE',
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(2),
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
  await openSettings(window);
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-github');
  await accounts.getByRole('button', { name: 'Connect GitHub' }).click();
  const code = window.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(github.enterCode((await code.textContent()) ?? '')).toBe(true);
  await expect(accounts.getByTestId('account-synced')).toHaveText(/· 2 items$/);
}

test('yesterday’s merged pull request, a stuck one and a failing default branch, each in its section', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const window = await commander.window();
  await connectGitHub(window);

  await tab(window, 'GitHub').click();
  const section = window.getByTestId('section-github');
  const summary = section.getByRole('region', { name: 'Oversight summary' });
  await expect(summary.getByRole('button', { name: 'Since yesterday' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    summary.getByRole('region', { name: 'Shipped' }).getByTestId('github-summary-line'),
  ).toHaveText(['acme-org/api: 1 PR merged']);
  await expect(summary.getByRole('region', { name: 'Stuck' }).getByTestId('github-summary-line')).toHaveText([
    'acme-org/web#7 Flaky deploy: checks failing',
  ]);
  await expect(
    summary.getByRole('region', { name: 'On fire' }).getByTestId('github-summary-line'),
  ).toHaveText(['acme-org/api: main is failing its checks']);
  await expect(summary.getByTestId('github-summary-closing')).toHaveCount(0);

  // A line opens its Items in the Section.
  await summary.getByRole('button', { name: 'acme-org/web#7 Flaky deploy: checks failing' }).click();
  const pane = section.getByRole('region', { name: 'Pull request detail' });
  await expect(pane.getByRole('heading', { name: 'Flaky deploy' })).toBeVisible();
  await summary.getByRole('button', { name: 'acme-org/api: 1 PR merged' }).click();
  await expect(pane.getByRole('heading', { name: 'Cache the session lookups' })).toBeVisible();

  // The writer's detail was fetched for the pull requests in the summary, in one batch.
  await expect
    .poll(
      () => github.apiRequests.filter((request) => request === 'POST /graphql CommanderWriterDetail').length,
    )
    .toBeGreaterThan(0);
});
