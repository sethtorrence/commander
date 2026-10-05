import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Memory end to end (#74): a fake Linear (never the real one) and a fake OpenAI-compatible server
// standing in for Z.ai. Ares guesses wrong about a pager issue; the User corrects him; the example
// he learns appears in What Ares knows (opened from Settings → Ares) and in Ctrl+K; a similar issue
// arriving later is filed correctly because of it (the fake model files by what the prompt says Ares
// knows); and the User deletes the memory. The keys go in the real keyring, so this needs the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_memory_key';
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const EXAMPLE = 'Linear issue OPS-1 (team OPS) belongs to TX (Tactics), not TL (Titanlink)';

// The fake model. "File into Projects" guesses TL, unsure, unless what Ares knows (the User's own
// block) says an issue from team OPS belongs to TX: then it is sure of TX. Other jobs find nothing.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  if (system.includes('You file the User')) {
    const [, ref] = /label="(I\d+) · Linear issue [^"]*"/.exec(prompt) ?? [];
    const knows = /label="What Ares knows" source="the User">[\s\S]*team OPS\) belongs to TX/.test(prompt);
    const filings = ref
      ? [
          knows
            ? { itemId: ref, projectCode: 'TX', confidence: 0.95, reason: 'You filed its like under TX' }
            : { itemId: ref, projectCode: 'TL', confidence: 0.55, reason: 'Looks like Titanlink work' },
        ]
      : [];
    return { json: chatCompletion(JSON.stringify({ filings, steering: [] })) };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
  if (system.includes('You pick up facts')) return { json: chatCompletion('{"facts":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-memory-key');
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

const row = (section: Locator, title: string) =>
  section.getByTestId('linear-issue').filter({ hasText: title });

let linear: FakeLinear;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.add(ACME.id, { identifier: 'OPS-1', title: 'Pager rota for October', team: OPS });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await server?.close();
});

test('correct a filing → the example in What Ares knows → a similar issue filed by it → delete the memory', async () => {
  test.setTimeout(120_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_LINEAR: JSON.stringify({
        clientId: null,
        port: await freePort(),
        authorizeUrl: linear.authorizeUrl,
        tokenUrl: linear.tokenUrl,
        apiUrl: linear.apiUrl,
      }),
    },
  });
  const window = await commander.window();
  await openSettings(window);
  await connectFakeModel(window, server);
  await createProject(window, 'Titanlink', 'TL');
  await createProject(window, 'Tactics', 'TX');
  const accounts = window.getByTestId('accounts-panel');
  await accounts.getByLabel('Linear personal API key').fill(API_KEY);
  await accounts.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(accounts.getByTestId('account-synced')).toHaveText(/1 issue/);
  await window.keyboard.press('Escape');

  // Ares isn't sure: his dashed Badge says Titanlink. The User changes it to Tactics.
  await tab(window, 'Linear').click();
  const section = window.getByTestId('section-linear');
  await section.getByRole('tab', { name: /All tickets/ }).click();
  const october = row(section, 'Pager rota for October');
  await expect(october.getByRole('img', { name: 'Ares suggests Titanlink' })).toBeVisible({
    timeout: 20_000,
  });
  await october.getByRole('button', { name: /^Project of / }).click();
  await expect(window.getByTestId('badge-picker').getByTestId('badge-picker-suggestion')).toBeVisible();
  await window.keyboard.type('TX');
  await window.keyboard.press('Enter');
  await expect(october.getByRole('img', { name: 'Tactics', exact: true })).toBeVisible();
  await window.keyboard.press('Escape');

  // What Ares knows, opened from Settings → Ares: the correction is an example, the User's own.
  await openSettings(window);
  await window.getByTestId('open-what-ares-knows').click();
  const known = window.getByTestId('what-ares-knows');
  await expect(known).toBeVisible();
  const examples = known.getByRole('list', { name: 'Examples' });
  const example = examples.getByTestId('memory').filter({ hasText: EXAMPLE });
  await expect(example).toBeVisible();
  await expect(example).not.toContainText('Unconfirmed');
  await expect(example.getByRole('button', { name: 'Pager rota for October' })).toBeVisible();

  // Ctrl+K finds it, as its own group.
  await window.keyboard.press('Control+k');
  const palette = window.getByTestId('palette');
  await palette.getByRole('combobox', { name: 'Search Commander' }).fill('belongs tactics');
  await expect(palette.getByRole('group', { name: 'Memory' }).getByRole('option')).toHaveText([
    new RegExp(EXAMPLE.replace(/[()]/g, '\\$&')),
  ]);
  await window.keyboard.press('Escape');

  // A similar issue arrives: Ares files it under Tactics himself, because of the example.
  linear.issues.add(ACME.id, { identifier: 'OPS-2', title: 'Pager rota for November', team: OPS });
  await openSettings(window);
  await accounts.getByRole('button', { name: 'Sync now' }).click();
  await expect(accounts.getByTestId('account-synced')).toHaveText(/2 issues/);
  await window.keyboard.press('Escape');
  await tab(window, 'Linear').click();
  const november = row(section, 'Pager rota for November');
  await expect(november.getByRole('img', { name: 'Tactics', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(november.getByRole('img', { name: 'Ares suggests Titanlink' })).toHaveCount(0);
  const filing = server.requests
    .map((each) => JSON.stringify(each.body))
    .filter((body) => body.includes('Pager rota for November') && body.includes('You file the User'));
  expect(filing.at(-1)).toContain('What Ares knows');

  // The User deletes the memory: it is gone from What Ares knows.
  await tab(window, 'Ares').click();
  await example.getByRole('button', { name: 'Delete' }).click();
  await expect(examples.getByTestId('memory').filter({ hasText: EXAMPLE })).toHaveCount(0);
});
