import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Settings → GitHub end to end (#113), against a fake GitHub on this machine (never the real one):
// what a GitHub Account can reach, through Commander's GitHub App or a classic token, starting with
// the repos the User worked in; watching whole orgs and single repos; and unwatching, which asks
// before removing Items. Tokens are stored in the real keyring, so these need the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

let github: FakeGitHub;
let commander: LaunchedCommander | undefined;
let emptyPath: string;
const nodeIds: Record<string, string> = {};

function pointAtFakeGitHub({ app = true } = {}) {
  const config = {
    clientId: app ? github.clientId : null,
    appSlug: app ? github.appSlug : null,
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  };
  // No gh on the PATH: these tests connect with the app or a token.
  return { COMMANDER_TEST_GITHUB: JSON.stringify(config), COMMANDER_TEST_HOOKS: '1', PATH: emptyPath };
}

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

async function connectWithTheApp(window: Page) {
  await openSettings(window);
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-github');
  await accounts.getByRole('button', { name: 'Connect GitHub' }).click();
  const code = window.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(github.enterCode((await code.textContent()) ?? '')).toBe(true);
  await expect(accounts.getByTestId('account-name')).toHaveText(['octocat']);
}

const watchPanel = (window: Page) => window.getByTestId('github-watch');
const repoBox = (window: Page, name: string) =>
  watchPanel(window).getByRole('checkbox', { name, exact: true });
const summary = (window: Page) => watchPanel(window).getByTestId('github-watch-summary');

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  emptyPath = mkdtempSync(join(tmpdir(), 'commander-e2e-path-'));
  github = await startFakeGitHub({ interval: 1 });
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  // A member without the app, who shows the membership publicly.
  github.addOrg({ login: 'initech', id: 502, members: [OCTOCAT.id], publicMembers: [OCTOCAT.id] });
  github.addOrg({ login: 'globex', id: 503, members: [] });
  nodeIds.api = github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: '2026-10-02T10:00:00Z' });
  nodeIds.web = github.addRepo({ owner: 'acme-org', name: 'web', pushedAt: '2026-09-20T10:00:00Z' });
  github.addRepo({ owner: 'acme-org', name: 'old-site', archived: true });
  github.addRepo({ owner: 'initech', name: 'secret-plans' });
  github.addRepo({ owner: 'octocat', name: 'dotfiles', private: false, pushedAt: '2026-09-30T10:00:00Z' });
  github.addRepo({ owner: 'octocat', name: 'notes', pushedAt: '2026-06-01T10:00:00Z' });
  github.addRepo({ owner: 'octocat', name: '2019-talk', archived: true, private: false });
  github.install({ login: 'octocat', type: 'User' });
  github.install({ login: 'acme-org', type: 'Organization' });
  // What octocat worked in over the last 90 days.
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  github.contribute(OCTOCAT.id, 'octocat/dotfiles', 'review');
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await github?.close();
  if (emptyPath) rmSync(emptyPath, { recursive: true, force: true });
});

test('Settings → GitHub lists what the app reaches, starts with the repos worked in, watches whole orgs and single repos, asks before unwatching removes Items, and keeps the choice across a restart', async () => {
  const env = pointAtFakeGitHub();
  const first = await launchCommander({ env });
  commander = first;
  let page = await first.app.firstWindow();
  await recordTheBrowser(first.app);
  await connectWithTheApp(page);

  // Installed orgs and their repos, personal repos, and an org without the app. Archived repos never.
  const acme = watchPanel(page).getByTestId('github-org-acme-org');
  await expect(acme.getByRole('checkbox', { name: /^acme-org\// })).toHaveCount(2);
  await expect(repoBox(page, 'acme-org/api')).toBeVisible();
  await expect(repoBox(page, 'acme-org/web')).toBeVisible();
  const personal = watchPanel(page).getByTestId('github-personal');
  await expect(personal.getByRole('checkbox')).toHaveCount(2);
  await expect(watchPanel(page).getByText(/old-site|2019-talk/)).toHaveCount(0);
  const initech = watchPanel(page).getByTestId('github-org-initech');
  await expect(initech.getByText('Commander isn’t installed here.')).toBeVisible();
  await initech.getByRole('link', { name: 'Install or request…' }).click();
  await expect
    .poll(() => openedUrls(first.app))
    .toContain(`${github.webUrl}/apps/${github.appSlug}/installations/new/permissions?target_id=502`);

  // The default: the repos octocat pushed to or reviewed lately, as checked repos.
  await expect(repoBox(page, 'acme-org/api')).toBeChecked();
  await expect(repoBox(page, 'octocat/dotfiles')).toBeChecked();
  await expect(repoBox(page, 'acme-org/web')).not.toBeChecked();
  await expect(repoBox(page, 'octocat/notes')).not.toBeChecked();
  await expect(summary(page)).toHaveText('Watching 2 repos: 1 in 1 org and 1 personal.');

  // Watch the whole org in one click; a repo made there later is watched too.
  await acme.getByRole('checkbox', { name: 'Watch whole org' }).check();
  await expect(summary(page)).toHaveText('Watching 3 repos: 2 in 1 org and 1 personal.');
  github.addRepo({ owner: 'acme-org', name: 'made-later' });
  await watchPanel(page).getByRole('button', { name: 'Check again' }).click();
  await expect(repoBox(page, 'acme-org/made-later')).toBeChecked();
  await expect(summary(page)).toHaveText('Watching 4 repos: 3 in 1 org and 1 personal.');

  // Search narrows the list.
  await watchPanel(page).getByRole('searchbox', { name: 'Search repos' }).fill('dot');
  await expect(watchPanel(page).getByRole('checkbox', { name: /\// })).toHaveCount(1);
  await watchPanel(page).getByRole('searchbox', { name: 'Search repos' }).fill('');

  // acme-org/api has Items (pull requests, as GitHub sync will save them), and a Todo links to one.
  await first.app.evaluate(
    (_electron, { account, api }) => {
      const hooks = (
        globalThis as unknown as {
          commanderTestHooks: { saveGitHubItems: (account: string, items: unknown[]) => void };
        }
      ).commanderTestHooks;
      hooks.saveGitHubItems(account, [
        { repoNodeId: api, number: 1, title: 'Retry webhooks' },
        { repoNodeId: api, number: 2, title: 'Bump node' },
      ]);
    },
    { account: `github:${OCTOCAT.id}`, api: nodeIds.api ?? '' },
  );
  const pullRequests = () =>
    page.evaluate(() => window.commander.itemStore({ op: 'query', query: { source: 'github' } }));
  await expect.poll(async () => (await pullRequests()).length).toBe(2);
  const todoId = await page.evaluate(async () => {
    const [pr] = await window.commander.itemStore({
      op: 'query',
      query: { source: 'github', titleContains: 'Retry webhooks' },
    });
    const todo = await window.commander.itemStore({
      op: 'record',
      action: { type: 'create', item: { kind: 'todo', title: 'Review the webhook PR' } },
    });
    await window.commander.itemStore({
      op: 'record',
      action: { type: 'link', from: todo.itemId, linkType: 'refers-to', to: pr?.id ?? '' },
    });
    return todo.itemId;
  });

  // Unwatching asks first, naming how many Items go; keeping it changes nothing.
  await repoBox(page, 'acme-org/api').uncheck();
  const confirm = page.getByTestId('github-unwatch-confirm');
  await expect(confirm).toContainText('Stop watching acme-org/api?');
  await expect(confirm).toContainText('This removes 2 Items from Commander.');
  await confirm.getByRole('button', { name: 'Keep watching' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(repoBox(page, 'acme-org/api')).toBeChecked();
  expect(await pullRequests()).toHaveLength(2);

  await repoBox(page, 'acme-org/api').uncheck();
  await page.getByTestId('github-unwatch-confirm').getByRole('button', { name: 'Remove 2 Items' }).click();
  await expect(repoBox(page, 'acme-org/api')).not.toBeChecked();
  await expect(summary(page)).toHaveText('Watching 3 repos: 2 in 1 org and 1 personal.');
  await expect.poll(async () => (await pullRequests()).length).toBe(0);
  // The Todo stays, its Link showing the pull request as gone.
  const todo = await page.evaluate((id) => window.commander.itemStore({ op: 'get', itemId: id }), todoId);
  expect(todo?.item.deletedAt).toBeNull();
  expect(todo?.links[0]?.to).toMatchObject({ title: 'Retry webhooks', deletedAt: expect.any(Number) });

  // An org GitHub didn't list, added by name.
  await watchPanel(page).getByRole('textbox', { name: 'Org name' }).fill('globex');
  await watchPanel(page).getByRole('button', { name: 'Add org' }).click();
  await expect(
    watchPanel(page).getByTestId('github-org-globex').getByText('Commander isn’t installed here.'),
  ).toBeVisible();
  await first.app.close();

  // Restart on the same data: the choices are as left.
  commander = await launchCommander({ userDataDir: first.userDataDir, env });
  page = await commander.app.firstWindow();
  await openSettings(page);
  await expect(repoBox(page, 'acme-org/web')).toBeChecked();
  await expect(repoBox(page, 'acme-org/made-later')).toBeChecked();
  await expect(repoBox(page, 'acme-org/api')).not.toBeChecked();
  await expect(repoBox(page, 'octocat/dotfiles')).toBeChecked();
  await expect(
    watchPanel(page).getByTestId('github-org-acme-org').getByRole('checkbox', { name: 'Watch whole org' }),
  ).toBeChecked();
  await expect(watchPanel(page).getByTestId('github-org-globex')).toBeVisible();
  await expect(summary(page)).toHaveText('Watching 3 repos: 2 in 1 org and 1 personal.');
});

test('a classic-token Account gets the same page from its own lists', async () => {
  commander = await launchCommander({ env: pointAtFakeGitHub({ app: false }) });
  const page = await commander.app.firstWindow();
  await openSettings(page);
  const accounts = page.getByTestId('accounts-panel').getByTestId('source-github');
  await accounts
    .getByLabel('GitHub classic personal access token')
    .fill(github.personalToken({ kind: 'classic' }));
  await accounts.getByRole('button', { name: 'Connect with token' }).click();
  await expect(accounts.getByTestId('account-name')).toHaveText(['octocat']);

  // Every org the token reaches, with its repos, whether or not the app is installed there.
  await expect(repoBox(page, 'acme-org/api')).toBeChecked();
  await expect(repoBox(page, 'initech/secret-plans')).not.toBeChecked();
  await expect(repoBox(page, 'octocat/dotfiles')).toBeChecked();
  await expect(watchPanel(page).getByText('Commander isn’t installed here.')).toHaveCount(0);
  await expect(watchPanel(page).getByText(/old-site|2019-talk/)).toHaveCount(0);
  await expect(summary(page)).toHaveText('Watching 2 repos: 1 in 1 org and 1 personal.');

  await watchPanel(page)
    .getByTestId('github-org-initech')
    .getByRole('checkbox', { name: 'Watch whole org' })
    .check();
  await expect(summary(page)).toHaveText('Watching 3 repos: 2 in 2 orgs and 1 personal.');
});
