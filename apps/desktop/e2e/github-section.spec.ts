import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// The GitHub Section end to end (#115), against a fake GitHub on this machine (never the real one).
// Pull requests and issues come in through GitHub sync, which saves them with saveFromSource:
// switching views, filtering, opening a pull request with its discussion (fetched once, and again
// when the pull request changes), and filing it into a Project. Tokens are stored in the real
// keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

// Somewhere for a remote image to live, counting every request for it.
async function imageHost(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { 'content-type': 'image/png' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/uploads/graph.png`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Links leave for the system browser: here, a list of what was sent there.
async function catchTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

let github: FakeGitHub;
let image: Awaited<ReturnType<typeof imageHost>>;
let commander: LaunchedCommander | undefined;
let emptyPath: string;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  emptyPath = mkdtempSync(join(tmpdir(), 'commander-e2e-path-'));
  github = await startFakeGitHub({ interval: 1 });
  image = await imageHost();
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(2) });
  github.addRepo({ owner: 'acme-org', name: 'web', pushedAt: hoursAgo(3) });
  github.install({ login: 'acme-org', type: 'Organization' });
  // octocat worked in both lately, so Commander starts by watching them.
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  github.contribute(OCTOCAT.id, 'acme-org/web', 'review');
  github.addIssue({
    repo: 'acme-org/api',
    number: 30,
    title: 'Webhooks drop on 502',
    author: 'priya',
    updatedAt: hoursAgo(5),
  });
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 12,
    title: 'Retry webhooks with back-off',
    body: `Retries **failed** deliveries.\n\n![retry graph](${image.url})\n\n<img alt="screenshot" src="${image.url}">`,
    author: 'priya',
    reviewers: ['octocat'],
    labels: ['enhancement'],
    closes: [30],
    checkRuns: [
      { name: 'test', conclusion: 'FAILURE', url: 'https://ci.acme.test/runs/1' },
      { name: 'lint', conclusion: 'SUCCESS' },
    ],
    reviews: [{ author: 'omar', state: 'COMMENTED', body: 'Looks close.', submittedAt: hoursAgo(2) }],
    comments: [{ author: 'omar', body: 'Can we keep the **old** flag?', createdAt: hoursAgo(2.5) }],
    createdAt: hoursAgo(50),
    updatedAt: hoursAgo(1),
  });
  github.addPullRequest({
    repo: 'acme-org/web',
    number: 7,
    title: 'Dark mode',
    author: 'sam',
    draft: true,
    updatedAt: hoursAgo(2),
  });
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 9,
    title: 'Cache the session lookups',
    author: 'sam',
    state: 'MERGED',
    updatedAt: hoursAgo(20),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await github?.close();
  await image?.close();
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
  await expect(accounts.getByTestId('account-synced')).toHaveText(/· 5 items$/);
}

const rows = (section: Locator) => section.getByTestId('github-work');
const discussionQueries = () =>
  github.apiRequests.filter((request) => request === 'POST /graphql CommanderDiscussion').length;

test('switch views, filter, open a pull request with its discussion, and file it into a Project', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub() });
  const { app } = commander;
  const window = await commander.window();
  const openedExternally = await catchTheBrowser(app);
  await connectGitHub(window);
  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Longtail');
  await newProject.getByLabel('Badge code').fill('LT');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /LTLongtail/,
  ]);

  // Opening the Section syncs every GitHub Account at once, and says when it last synced.
  const before = github.apiRequests.length;
  await tab(window, 'GitHub').click();
  const section = window.getByTestId('section-github');
  await expect.poll(() => github.apiRequests.slice(before)).toContain('POST /graphql CommanderOpenWork');
  await expect(section.getByTestId('github-sync-status')).toHaveText(/^Synced \d\d:\d\d$/);
  // The tab counts the reviews waiting on the User.
  await expect(tab(window, 'GitHub').locator('.tc')).toHaveText('01');

  // Your work first (#116): here, the review asked of octocat.
  await expect(section.getByRole('tab', { name: /Your work/ })).toHaveAttribute('aria-selected', 'true');
  await expect(
    section.getByRole('region', { name: 'Review requests' }).getByTestId('github-work'),
  ).toHaveText([/acme-org\/api#12.*Retry webhooks with back-off/]);

  // Pull requests, open ones by latest activity; the merged one waits behind Closed.
  await section.getByRole('tab', { name: /Pull requests/ }).click();
  await expect(rows(section)).toHaveText([
    /acme-org\/api#12.*Retry webhooks with back-off.*Your review/,
    /acme-org\/web#7.*Dark mode.*Draft/,
  ]);
  await section
    .getByRole('region', { name: 'Closed' })
    .getByRole('button', { name: /Closed/ })
    .click();
  await expect(rows(section)).toHaveCount(3);
  await section.getByRole('tab', { name: /Issues/ }).click();
  await expect(rows(section)).toHaveText([/acme-org\/api#30.*Webhooks drop on 502/]);
  await section.getByRole('tab', { name: /Pull requests/ }).click();

  // The filters narrow the list together, with counts.
  await pickOption(section.getByRole('combobox', { name: 'Repo' }), /^acme-org\/web/, /Repo acme-org\/web/);
  await expect(rows(section)).toHaveText([/Dark mode/]);
  await section.getByRole('button', { name: 'Clear filters' }).click();
  await pickOption(section.getByRole('combobox', { name: 'Author' }), /^sam/, /Author sam/);
  await pickOption(section.getByRole('combobox', { name: 'State' }), /^Merged/, /State Merged/);
  await expect(rows(section)).toHaveText([/Cache the session lookups/]);
  await section.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(section)).toHaveCount(3);

  // Open the pull request: its fields, the body read-only (no image fetched), its checks and its
  // discussion, fetched from GitHub once.
  expect(discussionQueries()).toBe(0);
  await rows(section).filter({ hasText: 'Retry webhooks with back-off' }).click();
  const pane = section.getByRole('region', { name: 'Pull request detail' });
  await expect(pane.getByRole('heading', { name: 'Retry webhooks with back-off' })).toBeVisible();
  await expect(pane.locator('[data-field="repo"] dd')).toHaveText('acme-org/api');
  await expect(pane.locator('[data-field="author"] dd')).toHaveText('@priya');
  await expect(pane.locator('[data-field="branches"] dd')).toHaveText('branch-12 → main');
  await expect(pane.locator('[data-field="labels"] dd')).toHaveText('enhancement');
  await expect(pane.locator('[data-field="reviewers"] dd')).toHaveText('@omar · CommentedYou · Asked');
  await expect(pane.locator('[data-field="size"] dd')).toHaveText('+10 −2 · 1 file');
  const body = pane.getByTestId('github-body');
  await expect(body.locator('strong')).toHaveText('failed');
  await expect(body.getByRole('link', { name: /Image: retry graph/ })).toBeVisible();
  await expect(body.getByRole('link', { name: /Image: screenshot/ })).toBeVisible();
  await expect(pane.locator('img')).toHaveCount(0);
  await expect(pane.getByTestId('github-check')).toHaveText([/test.*Failing/, /lint.*Passing/]);
  const discussion = pane.getByTestId('github-discussion');
  await expect(discussion.getByRole('listitem')).toHaveText([
    /@omar.*Can we keep the old flag\?/,
    /@omar · Commented.*Looks close\./,
  ]);
  await expect(discussion.locator('strong')).toHaveText('old');
  expect(discussionQueries()).toBe(1);
  expect(image.hits()).toBe(0);

  // Its linked issue opens here; a check's page opens in the browser.
  await pane.getByTestId('github-check').filter({ hasText: 'test' }).getByRole('link').click();
  await expect.poll(openedExternally).toEqual(['https://ci.acme.test/runs/1']);
  await pane
    .getByRole('region', { name: 'Linked issues' })
    .getByRole('button', { name: /acme-org\/api#30/ })
    .click();
  const issuePane = section.getByRole('region', { name: 'Issue detail' });
  await expect(issuePane.getByRole('heading', { name: 'Webhooks drop on 502' })).toBeVisible();
  await expect(section.getByRole('tab', { name: /Issues/ })).toHaveAttribute('aria-selected', 'true');
  // The issue's own discussion is fetched for it; going back to the pull request fetches nothing.
  await expect(issuePane.getByText('No discussion yet.')).toBeVisible();
  expect(discussionQueries()).toBe(2);
  await section.getByRole('tab', { name: /Pull requests/ }).click();
  await rows(section).filter({ hasText: 'Retry webhooks with back-off' }).click();
  await expect(discussion.getByRole('listitem')).toHaveCount(2);
  expect(discussionQueries()).toBe(2);

  // A new comment on GitHub changes the pull request: the next sync brings it, and the pane fetches
  // the discussion again.
  github.addComment('acme-org/api', 12, { author: 'priya', body: 'Kept it behind a flag.' });
  await tab(window, 'Todos').click();
  await tab(window, 'GitHub').click();
  await expect(discussion.getByRole('listitem')).toHaveCount(3);
  await expect(discussion.getByRole('listitem').last()).toContainText('Kept it behind a flag.');
  expect(discussionQueries()).toBe(3);

  // File it with b: the activity log says so, and undo puts it back.
  await pane.getByRole('heading', { name: 'Retry webhooks with back-off' }).click();
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('lt');
  await picker.getByRole('combobox').press('Enter');
  const row = rows(section).filter({ hasText: 'Retry webhooks with back-off' });
  await expect(row.getByRole('img', { name: 'Longtail' })).toBeVisible();
  const activity = pane.getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('listitem').first()).toContainText('Filed under LT by you');
  await window.keyboard.press('Control+z');
  await expect(row.getByRole('img', { name: 'Unfiled' })).toBeVisible();
  await expect(activity.getByRole('listitem').first()).toContainText('Filing undone by you');
  await window.keyboard.press('Escape');
  await expect(pane).toBeHidden();

  // j/k move through the list and Enter opens the selected one.
  await window.keyboard.press('j');
  await window.keyboard.press('Enter');
  await expect(section.getByRole('region', { name: 'Pull request detail' }).getByRole('heading')).toHaveText(
    'Dark mode',
  );
  expect(image.hits()).toBe(0);
});
