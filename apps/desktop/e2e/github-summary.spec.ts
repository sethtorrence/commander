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
import { expect, type Page, test } from '@playwright/test';
import { type FakeGitHub, OCTOCAT, startFakeGitHub } from '../src/main/github/fake-github-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares writes the GitHub summary end to end (#121), against a fake GitHub and a fake OpenAI-compatible
// server standing in for Z.ai, both on this machine (never the real ones): GitHub sync brings
// yesterday's merged pull request and a failing default branch → Ares writes the daily summary (due
// from midnight here, rather than 05:00, so the test runs at any hour) → its Dashboard row sits in
// Today because main is failing → Enter opens it at the top of the GitHub Section, in his words. The
// keys go in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const WRITTEN = 'Session lookups are cached now, so sign-in no longer waits on the database.';

// What the fake model says: the summary rests on the first pull request it was given and the facts
// behind it; every other job has nothing to say.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const content = messages.at(-1)?.content ?? '';
  if (system.includes('GitHub oversight summary')) {
    const pull = /label="(I\d+) · Pull request acme-org\/api#9"/.exec(content)?.[1] ?? 'I1';
    const facts = /label="(F\d+) · Facts · shipped"/.exec(content)?.[1] ?? 'F1';
    return {
      json: chatCompletion(
        JSON.stringify({
          entries: [
            { section: 'shipped', theme: 'Session cache', text: WRITTEN, refs: [facts, pull] },
            // Resting on nothing it was given: dropped.
            { section: 'on-fire', text: 'Everything is on fire.', refs: ['I99'] },
          ],
        }),
        { prompt: 4_000, completion: 300 },
      ),
      delayMs: 200,
    };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('asked for their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
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
  github.addRepo({ owner: 'acme-org', name: 'api', pushedAt: hoursAgo(1), headChecks: 'FAILURE' });
  github.install({ login: 'acme-org', type: 'Organization' });
  github.contribute(OCTOCAT.id, 'acme-org/api', 'commit');
  // Merged an hour ago: Shipped, whatever the time of day.
  github.addPullRequest({
    repo: 'acme-org/api',
    number: 9,
    title: 'Cache the session lookups',
    body: 'Caches session lookups in memory, so sign-in stops hitting the database.',
    author: 'sam',
    state: 'MERGED',
    createdAt: hoursAgo(30),
    updatedAt: hoursAgo(1),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await github?.close();
  await server?.close();
  if (emptyPath) rmSync(emptyPath, { recursive: true, force: true });
});

function environment() {
  const config = {
    clientId: github.clientId,
    appSlug: github.appSlug,
    webUrl: github.webUrl,
    apiUrl: github.apiUrl,
  };
  return {
    COMMANDER_TEST_GITHUB: JSON.stringify(config),
    PATH: emptyPath,
    COMMANDER_TEST_HOOKS: '1',
    COMMANDER_TEST_SUMMARY_HOUR: '0',
    // One summary on any day: no Monday roll-up beside the daily one.
    COMMANDER_TEST_SUMMARY_ROLLUP: 'off',
  };
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page) {
  await openSettings(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-github-summary-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

// In Settings already (after the model).
async function connectGitHub(window: Page) {
  await settingsPage(window, 'Accounts');
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-github');
  await accounts.getByRole('button', { name: 'Connect GitHub' }).click();
  const code = window.getByTestId('github-user-code');
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(github.enterCode((await code.textContent()) ?? '')).toBe(true);
  await expect(accounts.getByTestId('account-synced')).toHaveText(/· 1 item$/);
}

const summaryCalls = () =>
  server.requests.filter((request) =>
    ((request.body.messages as { content: string }[])[0]?.content ?? '').includes('GitHub oversight summary'),
  );

test('synced work → Ares’s daily summary → its Dashboard row → open it in the GitHub Section', async () => {
  test.setTimeout(120_000);
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await connectFakeModel(window);
  await connectGitHub(window);
  await window.keyboard.press('Escape');

  // After the sync, Ares writes the daily summary: one Deep call at high thinking, the pull request in
  // an outside block of its own.
  await expect.poll(() => summaryCalls().length, { timeout: 30_000 }).toBe(1);
  const call = summaryCalls()[0]?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('high');
  expect(call.messages.at(-1)?.content).toMatch(
    /label="I\d+ · Pull request acme-org\/api#9" source="outside"/,
  );
  expect(call.messages.at(-1)?.content).toContain('so sign-in stops hitting the database');

  // Its Dashboard row sits in Today, because main is failing.
  await tab(window, 'Dashboard').click();
  const today = window.getByTestId('section-dashboard').getByRole('region', { name: 'Today', exact: true });
  const row = today.getByTestId('dashboard-row').filter({ hasText: 'GitHub summary' });
  await expect(row.getByTestId('row-reason')).toHaveText('Main is failing on acme-org/api', {
    timeout: 15_000,
  });
  await expect(row.getByTestId('source-stamp')).toHaveText('ARESGitHub summary');

  // Enter opens it at the top of the GitHub Section, in Ares's words, with the fire Commander adds.
  await row.click();
  await window.keyboard.press('Enter');
  const section = window.getByTestId('section-github');
  await expect(section).toBeVisible();
  const summary = section.getByRole('region', { name: 'Oversight summary' });
  await expect(summary.getByTestId('github-summary-by')).toHaveText(/^Written by Ares \d\d:\d\d · since /);
  await expect(summary.getByTestId('github-summary-entry')).toHaveText([
    `Session cache: ${WRITTEN}Open`,
    'acme-org/api: main is failing its checksacme-org/api',
  ]);
  await expect(summary.getByTestId('github-summary-closing')).toHaveCount(0);

  // Its entry opens its pull request.
  await summary.getByRole('button', { name: /^Open: Session cache/ }).click();
  await expect(
    section
      .getByRole('region', { name: 'Pull request detail' })
      .getByRole('heading', { name: 'Cache the session lookups' }),
  ).toBeVisible();
});
