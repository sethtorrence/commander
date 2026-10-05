import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Rules and Ares file GitHub Items, end to end (#118), against a fake GitHub on this machine (never
// the real one) and a fake OpenAI-compatible server standing in for Z.ai. Map to Project… in
// Settings → GitHub makes "repo is acme-org/api → TL" in the one Rules list, which re-files the
// repo's pull request and issue ("Filed under TL by Rule: repo is acme-org/api"); a watched repo
// with nothing synced is offered in the Rule editor; Ares leaves his dashed Badge on the pull request
// no Rule maps, which the User confirms from its pane. Tokens and the model's key go in the real
// keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

// The fake model: "File into Projects" guesses (unsure) that Dark mode is Longtail's and leaves the
// rest Unfiled. Any other job gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  if (system.includes('You file the User')) {
    const [, ref] = /label="(I\d+) · GitHub [^"]*"/.exec(prompt) ?? [];
    const [, title] = /┆ Title: (.*)/.exec(prompt) ?? [];
    const dark = title === 'Dark mode';
    const filings = ref
      ? [
          {
            itemId: ref,
            projectCode: dark ? 'LT' : 'unfiled',
            confidence: dark ? 0.55 : 0.2,
            reason: 'Longtail’s web app',
          },
        ]
      : [];
    return { json: chatCompletion(JSON.stringify({ filings, steering: [] })) };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-github-filing-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function createProject(window: Page, name: string, code: string) {
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' })).toContainText(`${code}${name}`);
}

let github: FakeGitHub;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;
let emptyPath: string;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  emptyPath = mkdtempSync(join(tmpdir(), 'commander-e2e-path-'));
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  github = await startFakeGitHub({ interval: 1 });
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  github.addOrg({ login: 'acme-org', id: 501, members: [OCTOCAT.id] });
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(2) });
  github.addRepo({ owner: 'acme-org', name: 'web', pushedAt: hoursAgo(3) });
  github.addRepo({ owner: 'acme-org', name: 'docs', pushedAt: hoursAgo(4) });
  github.install({ login: 'acme-org', type: 'Organization' });
  // octocat worked in all three lately, so Commander starts by watching them.
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  github.contribute(OCTOCAT.id, 'acme-org/web', 'review');
  github.contribute(OCTOCAT.id, 'acme-org/docs', 'commit');
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
    author: 'priya',
    updatedAt: hoursAgo(1),
  });
  github.addPullRequest({
    repo: 'acme-org/web',
    number: 7,
    title: 'Dark mode',
    author: 'sam',
    updatedAt: hoursAgo(2),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await github?.close();
  await server?.close();
  if (emptyPath) rmSync(emptyPath, { recursive: true, force: true });
});

const rows = (section: Locator) => section.getByTestId('github-work');

test('Map to Project… makes a repo Rule that files its Items; the editor offers a watched repo with nothing synced; Ares suggests the rest', async () => {
  test.setTimeout(120_000);
  const config = {
    clientId: github.clientId,
    appSlug: github.appSlug,
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  };
  commander = await launchCommander({
    env: { COMMANDER_TEST_GITHUB: JSON.stringify(config), PATH: emptyPath },
  });
  const window = await commander.window();
  await openSettings(window);
  await connectFakeModel(window, server);
  await createProject(window, 'Titanlink', 'TL');
  await createProject(window, 'Longtail', 'LT');

  // Connect GitHub: three Items sync, from three watched repos (docs has none).
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-github');
  await accounts.getByRole('button', { name: 'Connect GitHub' }).click();
  const code = window.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(github.enterCode((await code.textContent()) ?? '')).toBe(true);
  await expect(accounts.getByTestId('account-synced')).toHaveText(/· 3 items$/);

  // Settings → GitHub: Map to Project… on acme-org/api opens a repo Rule, its Project to choose.
  const api = window.getByTestId('github-watch').getByTestId('github-repo-acme-org/api');
  await api.getByRole('button', { name: 'Map acme-org/api to a Project' }).click();
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await expect(editor.getByRole('combobox', { name: 'Field 1' })).toHaveValue('github.repo');
  await editor.getByRole('combobox', { name: 'Files into' }).selectOption({ label: 'TL · Titanlink' });
  await expect(editor.getByRole('region', { name: 'Matching Items' })).toContainText('Matches 2 Items');
  await editor.getByRole('button', { name: 'Save Rule' }).click();
  const offer = window.getByRole('dialog', { name: 'Re-file existing items' });
  await offer.getByRole('button', { name: 'Re-file 2 items' }).click();
  await expect(api.getByRole('img', { name: 'Titanlink', exact: true })).toBeVisible();
  // The one Rules list holds it.
  await expect(window.getByRole('list', { name: 'Rules' }).getByRole('listitem')).toHaveText([
    /repo is acme-org\/api/,
  ]);

  // The Rule editor offers acme-org/docs, watched with nothing synced from it yet.
  await window.getByRole('button', { name: 'New Rule', exact: true }).click();
  const another = window.getByRole('dialog', { name: 'New Rule' });
  await another.getByRole('combobox', { name: 'Field 1' }).selectOption('github.repo');
  await expect(another.getByRole('combobox', { name: 'Value 1' }).getByRole('option')).toHaveText([
    'Choose…',
    'acme-org/api',
    'acme-org/docs',
    'acme-org/web',
  ]);
  await another.getByRole('button', { name: 'Cancel' }).click();
  await window.keyboard.press('Escape');

  // The GitHub Section: the repo's pull request wears TL, filed by the Rule; Ares left his dashed
  // Badge on Dark mode, which no Rule maps.
  await tab(window, 'GitHub').click();
  const section = window.getByTestId('section-github');
  await section.getByRole('tab', { name: /Pull requests/ }).click();
  const retry = rows(section).filter({ hasText: 'Retry webhooks with back-off' });
  await expect(retry.getByRole('img', { name: 'Titanlink', exact: true })).toBeVisible();
  await retry.click();
  const pane = section.getByRole('region', { name: 'Pull request detail' });
  await expect(pane.getByRole('region', { name: 'Activity' })).toContainText(
    'Filed under TL by Rule: repo is acme-org/api',
  );
  const dark = rows(section).filter({ hasText: 'Dark mode' });
  await expect(dark.getByRole('img', { name: 'Ares suggests Longtail' })).toBeVisible({ timeout: 20_000 });
  await dark.click();
  const suggested = pane.getByTestId('suggested-filing');
  await suggested.getByRole('button', { name: 'Confirm Longtail' }).click();
  await expect(dark.getByRole('img', { name: 'Longtail', exact: true })).toBeVisible();
});
