import type { AutonomyTestRequest, Proposal } from '@commander/domain';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares choosing Skills in a Conversation (#192), end to end, with a fake OpenAI-compatible server
// standing in for Z.ai (never the real one). Find: asked about the User's notes, he looks them up and
// answers with a link to the Daily Note line his answer rests on, which opens it in Notes. Update:
// asked in words ("anything I should know?"), he gives the Update in the Conversation, with its
// lines and actions, and accepting a suggestion there makes the Todo. What Ares can do lists his
// Skills. The model's key goes in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

type Message = { role: string; content: string };

let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

// The fake model. In a Conversation: a Skill first, chosen from what the User asked, then an answer
// from what it found (the data blocks after the User's message), naming the Item it rests on by the
// ref it was given. Every other job of Ares's gets nothing to do (the Update falls back to its plain
// sentences).
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  if (!system.startsWith('You are Ares. You work inside Commander')) {
    if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
    return { json: chatCompletion('{"todos":[]}') };
  }
  const found = messages.at(-1)?.content.startsWith('<data-') ?? false;
  const asked =
    [...messages]
      .reverse()
      .find((message) => message.role === 'user' && !message.content.startsWith('<data-'))?.content ?? '';
  const stream = (text: string): FakeReply => ({
    sse: streamedCompletion(text.match(/[\s\S]{1,12}/g) ?? [], { prompt: 400, completion: 40 }),
    sseEveryMs: 20,
  });
  if (asked.includes('Acme redlines')) {
    if (!found) return stream('[skill]\n{"skill":"find","input":{"query":"acme redlines"}}');
    const ref = /ref="(I\d+)" label="I\d+ · Daily Note line · Acme redlines/.exec(
      messages.at(-1)?.content ?? '',
    )?.[1];
    return stream(`[their-data]\nLeo marked up clause 4 of the Acme contract [${ref}].`);
  }
  if (asked.includes('anything I should know')) {
    if (!found) return stream('[skill]\n{"skill":"update","input":{}}');
    return stream('[their-data]\nOne thing is waiting on you.');
  }
  return stream('[chat]\nHello.');
}

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await server?.close();
});

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page) {
  await openSettings(window);
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-skills-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await window.keyboard.press('Escape');
}

let positions = 0;

// A line the User wrote in a Daily Note, through the window's Item store channel.
async function writeBlock(page: Page, text: string): Promise<string> {
  const entry = await page.evaluate(
    async ({ text, position }) => {
      const note = await window.commander.itemStore({ op: 'daily-note', day: '2026-10-01' });
      return window.commander.itemStore({
        op: 'record',
        action: {
          type: 'create',
          item: {
            kind: 'block',
            title: text,
            detail: { kind: 'block', dailyNoteId: note.id, parentId: null, position, text, folded: false },
          },
        },
      });
    },
    { text, position: `a${positions++}` },
  );
  return entry.itemId;
}

// A Todo Ares wasn't sure about, on a Block, proposed as his job would through the test hook.
async function suggestTodo(app: ElectronApplication, page: Page, text: string, title: string) {
  const block = await writeBlock(page, text);
  const proposal: Proposal = {
    actionKind: 'organise',
    action: 'suggest-todos',
    section: 'notes',
    itemId: block,
    itemActions: [
      {
        type: 'create',
        item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null } },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
    ],
    confidence: 0.5,
    reason: `You wrote “${text}”.`,
    chained: false,
  };
  const request: AutonomyTestRequest = { op: 'propose', proposal };
  await app.evaluate(async (_electron, request) => {
    const hooks = (globalThis as { commanderTestHooks?: { autonomy: (r: unknown) => Promise<unknown> } })
      .commanderTestHooks;
    if (!hooks) throw new Error('Test hooks are off');
    const response = (await hooks.autonomy(request)) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error);
  }, request);
}

async function openConversations(window: Page) {
  await tab(window, 'Ares').click();
  const conversations = window.getByTestId('section-ares').getByTestId('conversations');
  await conversations.scrollIntoViewIfNeeded();
  return { thread: conversations.getByTestId('conversation-thread') };
}

async function say(thread: Locator, text: string) {
  const input = thread.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const conversationCalls = () =>
  server.requests.filter((request) =>
    ((request.body.messages as Message[] | undefined)?.[0]?.content ?? '').startsWith(
      'You are Ares. You work',
    ),
  );

test('Find answers with a link that opens the Item; an Update asked for in words comes with its actions; What Ares can do lists his Skills', async () => {
  test.setTimeout(150_000);
  const env = { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_MODEL_IN_CLOUD: '1' };
  commander = await launchCommander({ env });
  const { app } = commander;
  const page = await commander.window();
  // The tests propose for Suggest Todos themselves, so the job itself stays out of the way.
  await page.evaluate(() =>
    window.commander.autonomy({ op: 'set-job-enabled', job: 'suggest-todos', enabled: false }),
  );
  await connectFakeModel(page);
  await writeBlock(page, 'Acme redlines: Leo marked up clause 4');
  await suggestTodo(app, page, 'need to send Dana the Q3 numbers', 'Send Dana the Q3 numbers');
  const { thread } = await openConversations(page);
  const turns = thread.getByTestId('conversation-turn');

  // Find: he looks it up, then answers, linking the line his answer rests on.
  await say(thread, 'Where did I note the Acme redlines?');
  const found = turns.nth(1);
  await expect(found).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(found.getByTestId('ares-answer')).toHaveText(
    'Leo marked up clause 4 of the Acme contract Acme redlines: Leo marked up clause 4.',
  );
  await expect(found.getByTestId('own-knowledge')).toHaveCount(0);
  // Two calls: the Skill step, then the answer with what Find read, the User's line as their own.
  const calls = conversationCalls();
  expect(calls).toHaveLength(2);
  const answerCall = calls[1]?.body as { messages: Message[] };
  expect(answerCall.messages.at(-1)?.content).toMatch(
    /<data-[0-9a-f]{16} ref="I1" label="I1 · Daily Note line · Acme redlines: Leo marked up clause 4" source="the User">/,
  );
  // The link opens the line in Notes, highlighted.
  await found.getByRole('button', { name: 'Open Acme redlines: Leo marked up clause 4' }).click();
  await expect(page.getByTestId('header-title')).toHaveText('Daily Notes');
  const block = page.locator('#day-2026-10-01').locator('.n-blk', {
    has: page.locator('[data-block-text]', { hasText: /^Acme redlines: Leo marked up clause 4$/ }),
  });
  await expect(block).toHaveClass(/\bflash\b/);

  // Update, asked for in words: the Update in the Conversation, with its actions.
  await openConversations(page);
  await say(thread, 'Hey, anything I should know?');
  const update = turns.nth(3);
  await expect(update).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(update.getByTestId('ares-answer')).toHaveText('One thing is waiting on you.');
  const shown = update.getByTestId('conversation-update');
  const line = shown.getByTestId('update-line');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('“Send Dana the Q3 numbers”');
  // Accepting it there makes the Todo, as the panel would.
  await line.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(line.getByTestId('update-line-status')).toHaveText('Done');
  await expect
    .poll(async () =>
      (
        await page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } }))
      ).map((todo) => todo.title),
    )
    .toContain('Send Dana the Q3 numbers');

  // What Ares can do: every Skill he has, with how to ask for it.
  const canDo = page.getByTestId('section-ares').getByTestId('what-ares-can-do');
  await canDo.scrollIntoViewIfNeeded();
  for (const name of ['Find', 'Update', 'Summarise', 'Draft']) {
    await expect(canDo.getByRole('listitem', { name })).toBeVisible();
  }
  await expect(canDo.getByRole('listitem', { name: 'Update' })).toContainText(
    'Ask: “Anything I should know?”',
  );
});
