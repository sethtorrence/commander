import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dueDayFrom } from '@commander/domain';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear } from '../src/main/linear/fake-linear-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares acting from a Conversation (#196), end to end, with a fake OpenAI-compatible server standing in
// for Z.ai and a fake Linear (never the real ones). Asked to add a Todo, he does it at the default
// Autonomy settings, and his answer shows it done, with Undo. Asked to file a Linear issue under a
// Project, he finds it and files it. Asked to move an issue to In Review, which other people see, he
// prepares it as a card, and one key (Enter) confirms it: the issue moves in Linear. Every action is in
// Ares's activity with the Conversation as its cause. The keys go in the real keyring, so this needs
// the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_ares_actions_key';
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const PROGRESS = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };

type Message = { role: string; content: string };

// The fake model. In a Conversation: from what the User asked and what Commander's note says his Skills
// did so far, the next Skill step or the answer. Every other job of Ares's gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  if (!system.startsWith('You are Ares. You work inside Commander')) {
    if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
    return { json: chatCompletion('{"todos":[]}') };
  }
  const material = messages.at(-1)?.content.startsWith('<data-') ? (messages.at(-1)?.content ?? '') : '';
  const asked =
    [...messages]
      .reverse()
      .find((message) => message.role === 'user' && !message.content.startsWith('<data-'))?.content ?? '';
  const stream = (text: string): FakeReply => ({
    sse: streamedCompletion(text.match(/[\s\S]{1,12}/g) ?? [], { prompt: 400, completion: 40 }),
    sseEveryMs: 20,
  });
  const refOf = (title: string) =>
    new RegExp(`ref="(I\\d+)" label="I\\d+ · Linear issue · ${title}"`).exec(material)?.[1];
  if (asked.startsWith('Add a Todo')) {
    if (!material)
      return stream(
        '[skill]\n{"skill":"todos","input":{"action":"add","title":"Send Leo the redlines","due":"friday"}}',
      );
    return stream('[their-data]\nDone: send Leo the redlines, due Friday.');
  }
  if (asked.startsWith('File the export issue')) {
    if (!material) return stream('[skill]\n{"skill":"find","input":{"query":"fix the export"}}');
    if (!material.includes('File: '))
      return stream(
        `[skill]\n{"skill":"file","input":{"items":["${refOf('Fix the export')}"],"project":"Longtail"}}`,
      );
    return stream(`[their-data]\nFiled it under Longtail [${refOf('Fix the export')}].`);
  }
  if (asked.startsWith('Move the rate limiter')) {
    if (!material) return stream('[skill]\n{"skill":"find","input":{"query":"rate limiter"}}');
    if (!material.includes('Linear actions: '))
      return stream(
        `[skill]\n{"skill":"linear","input":{"action":"state","issues":["${refOf('Rate limiter')}"],"state":"In Review"}}`,
      );
    return stream(`[their-data]\nIt’s ready for you to confirm [${refOf('Rate limiter')}].`);
  }
  return stream('[chat]\nHello.');
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let linear: FakeLinear;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  // Priya's issues, so neither is one of the User's Linear Todos.
  linear.issues.add(ACME.id, {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the export',
    assignee: PRIYA,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-2',
    identifier: 'ENG-2',
    title: 'Rate limiter',
    assignee: PRIYA,
    state: PROGRESS,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await server?.close();
});

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page) {
  await openSettings(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-actions-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

// A Conversation's answer calls, and only those: other jobs (and what Ares keeps from what the User
// tells him, #194, a call of its own beside each answer) may land at any time.
const conversationCalls = () =>
  server.requests.filter((request) =>
    ((request.body.messages as Message[] | undefined)?.[0]?.content ?? '').startsWith(
      'You are Ares. You work',
    ),
  );

async function say(thread: Locator, text: string) {
  const input = thread.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const items = (page: Page, kind: 'todo' | 'linear-issue') =>
  page.evaluate((kind) => window.commander.itemStore({ op: 'query', query: { kinds: [kind] } }), kind);

test('a Todo added, an issue filed, and a Linear status change confirmed with one key, all from a Conversation', async () => {
  test.setTimeout(150_000);
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
  // Ares's own jobs stay out of the way: only what the User asks for happens here.
  for (const job of ['suggest-todos', 'file-into-projects']) {
    await page.evaluate(
      (job) => window.commander.autonomy({ op: 'set-job-enabled', job, enabled: false }),
      job,
    );
  }
  const longtail = await page.evaluate(
    async () =>
      (
        await window.commander.itemStore({
          op: 'change-project',
          action: { type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } },
        })
      ).project?.id,
  );
  await connectFakeModel(page);
  await settingsPage(page, 'Accounts');
  const accounts = page.getByTestId('accounts-panel');
  await accounts.getByLabel('Linear personal API key').fill(API_KEY);
  await accounts.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(accounts.getByTestId('account-synced')).toHaveText(/2 issues/);
  await page.keyboard.press('Escape');

  await tab(page, 'Ares').click();
  const section = page.getByTestId('section-ares');
  const conversations = section.getByTestId('conversations');
  await conversations.scrollIntoViewIfNeeded();
  const thread = conversations.getByTestId('conversation-thread');
  const turns = thread.getByTestId('conversation-turn');

  // A Todo: added at once (Organise, Auto when sure), shown done under his answer, with Undo.
  await say(thread, 'Add a Todo to send Leo the redlines by Friday');
  const added = turns.nth(1);
  await expect(added).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  const todoCard = added.getByTestId('conversation-action');
  await expect(todoCard).toHaveAttribute('data-status', 'done');
  await expect(todoCard).toContainText('Add the Todo “Send Leo the redlines”');
  await expect(todoCard.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect
    .poll(async () =>
      (await items(page, 'todo')).map((todo) => [todo.title, (todo.detail as { dueOn: string }).dueOn]),
    )
    .toEqual([['Send Leo the redlines', dueDayFrom('friday', Date.now())]]);

  // Filing: he finds the issue, then files it under Longtail, as Ares.
  await say(thread, 'File the export issue under Longtail');
  const filed = turns.nth(3);
  await expect(filed).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(filed.getByTestId('conversation-action')).toHaveAttribute('data-status', 'done');
  await expect
    .poll(
      async () =>
        (await items(page, 'linear-issue')).find((issue) => issue.title === 'Fix the export')?.filing,
    )
    .toEqual({ projectId: longtail, filedBy: 'ares' });

  // A Linear status change is seen by other people: a card, and one key confirms it.
  await say(thread, 'Move the rate limiter issue to In Review');
  const moved = turns.nth(5);
  await expect(moved).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  const card = moved.getByTestId('conversation-action');
  await expect(card).toHaveAttribute('data-status', 'waiting');
  await expect(card).toContainText('Move it to In Review in Linear');
  await expect(card).toContainText('Asks first: other people will see it.');
  expect(linear.issues.get('issue-2').state.name).toBe('In Progress');
  await expect(card.getByRole('button', { name: /Confirm/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-status', 'confirmed');
  await expect.poll(() => linear.issues.get('issue-2').state.name, { timeout: 20_000 }).toBe('In Review');
  // Confirming started nothing further: Ares isn't asked anything more.
  const calls = conversationCalls().length;
  await expect(thread.getByRole('textbox', { name: 'Message Ares' })).toBeFocused();
  expect(conversationCalls().length).toBe(calls);

  // Ares's activity: each with the Conversation as its cause.
  const activity = section.getByRole('list', { name: 'Ares’s activity' });
  await activity.scrollIntoViewIfNeeded();
  for (const name of ['Manage Todos', 'File', 'Linear actions']) {
    await expect(
      activity.getByRole('listitem', { name: new RegExp(`^${name}: `) }).getByTestId('activity-conversation'),
    ).toHaveText('Asked for in your Conversation Add a Todo to send Leo…');
  }

  // Undo from the reply: the Todo goes again.
  await conversations.scrollIntoViewIfNeeded();
  await todoCard.getByRole('button', { name: 'Undo' }).click();
  await expect(todoCard).toHaveAttribute('data-status', 'undone');
  await expect.poll(async () => (await items(page, 'todo')).length).toBe(0);
});
