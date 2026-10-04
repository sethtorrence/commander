import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// People end to end (#117), against a fake Linear and a fake GitHub on this machine (never the real
// ones): Linear's Priya Patel and GitHub's @priya share an address, so they are one Person, shown by
// name in the Linear and GitHub Sections and found with Ctrl+K, which opens Settings → People at
// her. There the User renames her (the name wins everywhere) and splits a handle off, then undoes it.
// The User is one Person across their Linear and GitHub Accounts. Tokens are stored in the real
// keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_people_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };

let linear: FakeLinear;
let github: FakeGitHub;
let commander: LaunchedCommander | undefined;
let emptyPath: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  emptyPath = mkdtempSync(join(tmpdir(), 'commander-e2e-path-'));
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.add(ACME.id, {
    identifier: 'ENG-418',
    title: 'Fix the login loop',
    assignee: ME,
    creator: PRIYA,
  });
  linear.issues.add(ACME.id, {
    identifier: 'OPS-7',
    title: 'Renew the certificate',
    team: OPS,
    assignee: PRIYA,
  });

  github = await startFakeGitHub({ interval: 1 });
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(2) });
  github.install({ login: 'acme-org', type: 'Organization' });
  github.install({ login: 'octocat', type: 'User' });
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  // GitHub shows @priya's public address: Priya's, as Linear has it.
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 12,
    title: 'Retry webhooks with back-off',
    author: 'priya',
    authorEmail: 'Priya@acme.test',
    reviewers: ['octocat'],
    updatedAt: hoursAgo(3),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await github?.close();
  if (emptyPath) rmSync(emptyPath, { recursive: true, force: true });
});

async function connectBoth(window: Page) {
  await openSettings(window);
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced').first()).toHaveText(/2 issues/);

  const accounts = panel.getByTestId('source-github');
  await accounts.getByRole('button', { name: 'Connect GitHub' }).click();
  const code = window.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(github.enterCode((await code.textContent()) ?? '')).toBe(true);
  await expect(accounts.getByTestId('account-synced')).toHaveText(/items$/);
}

const personRow = (people: Locator, name: string) =>
  people.locator(`[data-testid="person-row"][aria-label="${name}"]`);

test('one Person across Linear and GitHub: shown by name, found with Ctrl+K, renamed, split and put back', async () => {
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_LINEAR: JSON.stringify({
        clientId: null,
        port: await freePort(),
        authorizeUrl: linear.authorizeUrl,
        tokenUrl: linear.tokenUrl,
        apiUrl: linear.apiUrl,
      }),
      COMMANDER_TEST_GITHUB: JSON.stringify({
        clientId: github.clientId,
        appSlug: github.appSlug,
        webUrl: github.webUrl,
        apiUrl: github.apiUrl,
      }),
      PATH: emptyPath,
    },
  });
  const window = await commander.window();
  await connectBoth(window);

  // Settings → People: Priya once, with her Linear user, her GitHub login and her address.
  const people = window.getByTestId('people-settings');
  const priya = personRow(people, 'Priya Patel');
  await expect(priya).toHaveCount(1);
  await expect(priya).toContainText('@priya');
  await expect(priya).toContainText('priya@acme.test');
  // The User is one Person across their Accounts: their Linear user and their GitHub login.
  const me = personRow(people, 'Sam Rivera');
  await expect(me).toContainText('You');
  await expect(me).toContainText('@octocat');

  // A rename wins over every Source's name, everywhere.
  await priya.getByRole('button', { name: 'Rename Priya Patel' }).click();
  await people.getByRole('textbox', { name: 'Name for Priya Patel' }).fill('Priya P.');
  await window.keyboard.press('Enter');
  await expect(personRow(people, 'Priya P.')).toContainText('Your name');

  await tab(window, 'Linear').click();
  const section = window.getByTestId('section-linear');
  await section.getByRole('tab', { name: /All tickets/ }).click();
  const rows = section.getByTestId('linear-issue');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'OPS-7' })).toContainText('Priya P.');
  // The assignee filter offers People.
  await pickOption(section.getByRole('combobox', { name: 'Assignee' }), /^Priya P\./, /Assignee Priya P\./);
  await expect(rows).toHaveText([/OPS-7/]);

  // And the GitHub Section shows her pull request's author by the same name.
  await tab(window, 'GitHub').click();
  const githubRows = window.getByTestId('section-github').getByTestId('github-work');
  await expect(githubRows.filter({ hasText: 'Retry webhooks with back-off' })).toContainText('Priya P.');

  // Ctrl+K lists People as their own group; choosing her opens Settings → People at her.
  await window.keyboard.press('Control+k');
  const palette = window.getByTestId('palette');
  await palette.getByRole('combobox', { name: 'Search Commander' }).fill('priya');
  const group = palette.getByRole('group', { name: 'People' });
  await expect(group.getByRole('option')).toHaveText([/Priya P\./]);
  await group.getByRole('option').first().click();
  await expect(window.getByTestId('settings')).toBeVisible();
  const renamed = personRow(people, 'Priya P.');
  await expect(renamed).toHaveAttribute('aria-current', 'true');

  // Split her GitHub login off: a Person of its own, until Undo puts it back.
  await renamed.getByRole('button', { name: 'Split Priya P.' }).click();
  await renamed.getByRole('checkbox', { name: '@priya' }).check();
  await renamed.getByRole('button', { name: 'Split off' }).click();
  await expect(personRow(people, 'priya')).toHaveCount(1);
  await expect(renamed).not.toContainText('@priya');
  const toast = window.locator('[data-sonner-toast]').filter({ hasText: 'Split a handle from Priya P.' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(personRow(people, 'priya')).toHaveCount(0);
  await expect(renamed).toContainText('@priya');
});
