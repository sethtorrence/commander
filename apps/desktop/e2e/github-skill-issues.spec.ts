import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Skill-managed issues end to end (#120), against a fake GitHub on this machine (never the real one):
// a wayfinder map with its tickets (GitHub sub-issues) shows in the oversight summary as one Progress
// line, never as old open issues; once a ticket is claimed and another closed on GitHub, the next sync
// moves the counts, lists the claim under Started and the closed ticket under Shipped. Tokens are
// stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

let github: FakeGitHub;
let commander: LaunchedCommander | undefined;
let emptyPath: string;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const REPO = 'acme-org/api';

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  emptyPath = mkdtempSync(join(tmpdir(), 'commander-e2e-path-'));
  github = await startFakeGitHub({ interval: 1 });
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(2) });
  github.install({ login: 'acme-org', type: 'Organization' });
  github.contribute(OCTOCAT.id, REPO, 'commit');
  // The map, open for a month on purpose.
  github.addIssue({
    repo: REPO,
    number: 1,
    title: 'Commander v1 map',
    author: 'octocat',
    labels: ['wayfinder:map'],
    createdAt: hoursAgo(30 * 24),
    updatedAt: hoursAgo(10 * 24),
  });
  // Its tickets: one decided ten days ago, one waiting for weeks, one opened today.
  github.addIssue({
    repo: REPO,
    number: 3,
    title: 'Gmail research',
    author: 'octocat',
    labels: ['wayfinder:research'],
    parent: 1,
    state: 'CLOSED',
    createdAt: hoursAgo(20 * 24),
    updatedAt: hoursAgo(10 * 24),
  });
  github.addIssue({
    repo: REPO,
    number: 4,
    title: 'Wire the sync engine',
    author: 'octocat',
    labels: ['wayfinder:task'],
    parent: 1,
    createdAt: hoursAgo(20 * 24),
    updatedAt: hoursAgo(20 * 24),
  });
  github.addIssue({
    repo: REPO,
    number: 2,
    title: 'Grill the data model',
    author: 'octocat',
    labels: ['wayfinder:grilling'],
    parent: 1,
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(3),
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
  await expect(accounts.getByTestId('account-synced')).toHaveText(/· 4 items$/);
  await window.keyboard.press('Escape');
}

test('a map shows as progress in the summary, and claiming and closing its tickets moves the counts', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const window = await commander.window();
  await connectGitHub(window);

  await tab(window, 'GitHub').click();
  const section = window.getByTestId('section-github');
  const summary = section.getByRole('region', { name: 'Oversight summary' });
  const linesOf = (name: string) => summary.getByRole('region', { name }).getByTestId('github-summary-line');

  // One line of progress; the ticket opened today isn't Started, and nothing is Stuck.
  await expect(linesOf('Progress')).toHaveText(['acme-org/api#1 Commander v1 map: 1 of 3 decided, 1 opened']);
  await expect(
    summary.getByRole('progressbar', { name: 'acme-org/api#1 Commander v1 map progress' }),
  ).toHaveAttribute('aria-valuenow', '1');
  await expect(summary.getByRole('region', { name: 'Started' })).toContainText('Nothing started.');
  await expect(summary.getByRole('region', { name: 'Stuck' })).toContainText('Nothing stuck.');

  // In the Issues view the tickets sit under their map, collapsed, with the same progress.
  await section.getByRole('tab', { name: /Issues/ }).click();
  const map = section.getByRole('region', { name: 'Map: Commander v1 map' });
  await expect(map.getByTestId('github-progress-line')).toHaveText('1 of 3 decided');
  await expect(map.getByTestId('github-work')).toHaveCount(0);

  // On GitHub, octocat claims #4 and the data model is decided (#2 closed). Coming back to the
  // Section syncs at once.
  github.updateIssue(REPO, 4, { assignees: ['octocat'], assignedAt: new Date().toISOString() });
  github.updateIssue(REPO, 2, { state: 'CLOSED' });
  await tab(window, 'Todos').click();
  const before = github.apiRequests.length;
  await tab(window, 'GitHub').click();
  await expect.poll(() => github.apiRequests.slice(before)).toContain('POST /graphql CommanderSearch');

  await expect(linesOf('Progress')).toHaveText([
    'acme-org/api#1 Commander v1 map: 2 of 3 decided, 1 opened and 1 closed',
  ]);
  await expect(linesOf('Started')).toHaveText(['acme-org/api: claimed #4 Wire the sync engine (octocat)']);
  await expect(linesOf('Shipped')).toHaveText(['acme-org/api: #2 done (map ticket)']);
  await expect(map.getByTestId('github-progress-line')).toHaveText('2 of 3 decided');
});
