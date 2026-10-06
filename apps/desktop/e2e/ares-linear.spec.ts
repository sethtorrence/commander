import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares keeps an eye on Linear, end to end: a fake Linear (never the real one) and a fake
// OpenAI-compatible server standing in for Z.ai. A sync brings the User's issues; after it, "Spot
// stuck Linear issues" judges the one sitting in review stuck. An issue reassigned to Priya in Linear
// leaves the User's Todos at the next sync. `U` shows both, For your information, and Open goes to
// the reassigned issue. Then the key is revoked: the Update says Linear needs a new sign-in, Open
// goes to Settings → Accounts, and once reconnected the line has cleared itself. The keys go in the
// real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_ares_linear_key';
const NEW_KEY = 'lin_api_e2e_ares_linear_key_2';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const REVIEW = { id: 'state-review', name: 'In Review', type: 'started', color: '#0f783c' };
const DAY = 86_400_000;
const STUCK_REASON = 'ENG-2 has sat in review for 5 days; Priya hasn’t looked at it yet';

// The fake model: Spot stuck Linear issues judges ENG-2 stuck (by the reference its prompt gave it)
// and anything else not; every other job gets nothing to do, and the Update its plain sentences.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const material = messages.at(-1)?.content ?? '';
  if (system.includes("You keep an eye on the User's Linear issues")) {
    const issues = [...material.matchAll(/label="(S\d+) · Linear issue ([A-Z]+-\d+)"/g)].map(
      ([, ref, identifier]) =>
        identifier === 'ENG-2'
          ? { ref, stuck: true, reason: STUCK_REASON }
          : { ref, stuck: false, reason: '' },
    );
    return { json: chatCompletion(JSON.stringify({ issues }), { prompt: 1_800, completion: 120 }) };
  }
  if (system.includes("rank the User's Dashboard"))
    return { json: chatCompletion(JSON.stringify({ ranking: [] })) };
  if (system.includes('The User has asked for their Update')) {
    return { json: chatCompletion(JSON.stringify({ lines: [] })) };
  }
  return { json: chatCompletion(JSON.stringify({ todos: [] })) };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  await openSettings(window);
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-ares-linear-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

const todoTitles = (page: Page) =>
  page.evaluate(async () =>
    (await window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } }))
      .map((todo) => todo.title)
      .sort(),
  );

let linear: FakeLinear;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  const fiveDaysAgo = new Date(Date.now() - 5 * DAY).toISOString();
  linear.issues.add(ACME.id, { id: 'issue-1', identifier: 'ENG-1', title: 'Fix the export', assignee: ME });
  linear.issues.add(ACME.id, {
    id: 'issue-2',
    identifier: 'ENG-2',
    title: 'Rate limiter',
    assignee: ME,
    creator: ME,
    state: REVIEW,
    createdAt: new Date(Date.now() - 9 * DAY).toISOString(),
    updatedAt: fiveDaysAgo,
    startedAt: fiveDaysAgo,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await server?.close();
});

test('sync → a reassignment and a stuck issue, both in the Update; Reconnect queued and cleared', async () => {
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
  const page = await commander.window();
  await connectFakeModel(page, server);

  // Connect Linear: the sync brings both issues as the User's Linear Todos, and Ares looks after it.
  const accounts = page.getByTestId('accounts-panel');
  await accounts.getByLabel('Linear personal API key').fill(API_KEY);
  await accounts.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(accounts.getByTestId('account-synced')).toHaveText(/2 issues/);
  await expect.poll(() => todoTitles(page)).toEqual(['Fix the export', 'Rate limiter']);
  // One Quick call at low thinking for the stuck issue, its issue in an outside data block.
  await expect
    .poll(
      () =>
        server.requests.filter((each) => JSON.stringify(each.body).includes('You keep an eye on the User'))
          .length,
      { timeout: 20_000 },
    )
    .toBe(1);
  const call = server.requests.find((each) =>
    JSON.stringify(each.body).includes('You keep an eye on the User'),
  )?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('low');
  expect(call.messages.at(-1)?.content).toMatch(/label="S1 · Linear issue ENG-2" source="outside">/);
  expect(call.messages.at(-1)?.content).not.toContain('ENG-1');

  // Priya takes ENG-1 in Linear; the next sync takes it off the User's list.
  linear.issues.update('issue-1', { assignee: PRIYA }, PRIYA);
  await accounts.getByRole('button', { name: 'Sync now' }).click();
  await expect.poll(() => todoTitles(page)).toEqual(['Rate limiter']);
  await page.keyboard.press('Escape');

  // U: both, For your information, in the plain sentences (the fake model leaves the wording).
  await expect(page.getByTestId('ares-status').getByTestId('ares-queued')).toHaveText('02');
  await page.keyboard.press('u');
  const panel = page.getByTestId('update-panel');
  const fyi = panel.getByRole('region', { name: 'For your information' });
  await expect(fyi.getByTestId('update-line')).toHaveCount(2);
  await expect(fyi).toContainText(
    'ENG-1 “Fix the export” in Linear was reassigned to Priya Patel, so it’s off your Todos. Nothing to do, unless it should still be yours.',
  );
  await expect(fyi).toContainText(
    'ENG-2 “Rate limiter” in Linear looks stuck. It has sat in review for 5 days; Priya hasn’t looked at it yet. Open it to move it along, or tick it if it’s done.',
  );

  // Open on the reassignment: the Linear Section, at ENG-1.
  await fyi
    .getByTestId('update-line')
    .filter({ hasText: 'reassigned to Priya Patel' })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  const issue = page.getByTestId('section-linear').getByRole('region', { name: 'Issue detail' });
  await expect(issue.getByRole('heading', { name: 'Fix the export' })).toBeVisible();

  // The key is revoked in Linear: syncing pauses, and the Update says so first.
  linear.revokeApiKey(API_KEY);
  await openSettings(page);
  await accounts.getByRole('button', { name: 'Sync now' }).click();
  await expect(accounts.getByTestId('account-status')).toHaveText('Needs reconnecting');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ares-status').getByTestId('ares-queued')).toHaveText('03');
  await page.keyboard.press('u');
  const now = panel.getByRole('region', { name: 'Needs you now' });
  await expect(now.getByTestId('update-line')).toHaveText([
    /Linear \(Acme\) needs you to sign in again, so I’ve paused syncing it and its issues may be out of date\./,
  ]);

  // Open goes to Settings → Accounts; reconnecting clears the line by itself.
  await now.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(accounts).toBeInViewport();
  linear.addApiKey(NEW_KEY, ACME);
  await accounts.getByTestId('account').getByRole('button', { name: 'Reconnect' }).click();
  await accounts.getByLabel('Linear personal API key').fill(NEW_KEY);
  await accounts.getByRole('button', { name: 'Reconnect Acme' }).click();
  await expect(accounts.getByTestId('account-status')).toHaveText('Connected');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ares-status').getByTestId('ares-queued')).toHaveText('02');
  await page.keyboard.press('u');
  await expect(
    panel
      .getByTestId('update-line')
      .filter({ hasText: 'Linear (Acme) needs you' })
      .getByTestId('update-line-status'),
  ).toHaveText('Done');
});
