import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Talking to Ares (#191), end to end, with a fake OpenAI-compatible server standing in for Z.ai (never
// the real one), streaming its answers a piece at a time. Today's Conversation: a question streams in
// with the own-knowledge mark, a long story is stopped half-way and keeps what he wrote, asking him to
// act gets "I can't do that yet" (his Skills are in ares-skills.spec.ts); a second Conversation
// answers while the first is still writing; delete and Undo; and both are there after a restart.
// Then, with the model on this machine, a second Conversation waits its turn. The model's key goes in
// the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

type Message = { role: string; content: string };

const FJORD = ['[general]\n', 'A fjord ', 'is a long, ', 'narrow inlet ', 'carved by ', 'glaciers.'];
const STORY = ['[general]\n', ...Array.from({ length: 80 }, (_, i) => `word${i} `)];
const SUMMARY = ['[general]\n', ...Array.from({ length: 80 }, (_, i) => `part${i} `)];

// The fake model: a Conversation's answer streamed by what the User asked last; every other job of
// Ares's gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  if (!system.startsWith('You are Ares. You work inside Commander')) {
    if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
    return { json: chatCompletion('{"todos":[]}') };
  }
  const asked = messages.at(-1)?.content ?? '';
  const stream = (tokens: string[], sseEveryMs: number): FakeReply => ({
    sse: streamedCompletion(tokens, { prompt: 400, completion: tokens.length }),
    sseEveryMs,
  });
  if (asked.includes('fjord')) return stream(FJORD, 250);
  if (asked.includes('long story')) return stream(STORY, 250);
  if (asked.includes('long summary')) return stream(SUMMARY, 250);
  if (asked.includes('Email Dana')) return stream(['[cant]\n', 'Sending is yours to do.'], 20);
  if (asked.includes('2 + 2')) return stream(['[general]\n', '4.'], 20);
  return stream(['[chat]\n', 'Hello.'], 20);
}

let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

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
  await window.getByTestId('model-key-input').fill('zai-e2e-conversations-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await window.keyboard.press('Escape');
}

// The Ares Section's Conversations, opened on today's.
async function openConversations(window: Page) {
  await tab(window, 'Ares').click();
  const conversations = window.getByTestId('section-ares').getByTestId('conversations');
  await conversations.scrollIntoViewIfNeeded();
  return {
    conversations,
    list: conversations.getByTestId('conversation-list'),
    thread: conversations.getByTestId('conversation-thread'),
  };
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

test('send, stream, Stop, asking him to act, a second Conversation at once, delete and Undo, kept across a restart', async () => {
  test.setTimeout(180_000);
  // The fake model is on this machine: the tests treat it as a cloud model, so Conversations answer at
  // once rather than taking turns.
  const env = { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_MODEL_IN_CLOUD: '1' };
  commander = await launchCommander({ env });
  let window = await commander.window();
  await connectFakeModel(window);
  let { list, thread } = await openConversations(window);

  // Opening the Section lands on today's Conversation.
  await expect(thread.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(list.getByRole('listitem', { name: 'Today' })).toBeVisible();

  // A question: his answer streams in, and is marked as his own knowledge.
  await say(thread, 'What is a fjord?');
  const turns = thread.getByTestId('conversation-turn');
  await expect(turns.nth(0)).toHaveText('What is a fjord?');
  const fjord = turns.nth(1);
  await expect(fjord.getByTestId('ares-answer')).toContainText('A fjord');
  await expect(fjord).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(fjord.getByTestId('ares-answer')).toHaveText(
    'A fjord is a long, narrow inlet carved by glaciers.',
  );
  await expect(fjord.getByTestId('own-knowledge')).toHaveText('From Ares’s own knowledge');
  // Deep tier, at its thinking, streamed.
  const first = conversationCalls()[0]?.body as {
    stream: boolean;
    reasoning_effort: string;
    messages: Message[];
  };
  expect(first.stream).toBe(true);
  expect(first.reasoning_effort).toBe('high');
  expect(first.messages.at(-1)).toEqual({ role: 'user', content: 'What is a fjord?' });
  // Named from the first words the User wrote.
  await expect(list.getByRole('listitem', { name: 'What is a fjord?' })).toBeVisible();

  // A long story, stopped half-way: what he wrote is kept, and nothing more comes.
  await say(thread, 'Tell me a long story');
  const story = turns.nth(3);
  await expect(story).toHaveAttribute('data-status', 'streaming');
  await expect(story.getByTestId('ares-answer')).toContainText('word3');
  await thread.getByRole('button', { name: 'Stop' }).click();
  await expect(story).toHaveAttribute('data-status', 'stopped');
  await expect(story).toContainText('Stopped');
  const kept = (await story.getByTestId('ares-answer').textContent()) ?? '';
  expect(kept).toContain('word3');
  expect(kept).not.toContain('word79');
  await window.waitForTimeout(1_000);
  await expect(story.getByTestId('ares-answer')).toHaveText(kept);
  // The earlier turns went back as history.
  const storyCall = conversationCalls().at(-1)?.body as { messages: Message[] };
  expect(storyCall.messages.slice(1)).toEqual([
    { role: 'user', content: 'What is a fjord?' },
    { role: 'assistant', content: 'A fjord is a long, narrow inlet carved by glaciers.' },
    { role: 'user', content: 'Tell me a long story' },
  ]);

  // Asked to act, which none of his Skills can (#192): he says plainly he can't yet, without the mark.
  await say(thread, 'Email Dana that I’m running late');
  const act = turns.nth(5);
  await expect(act).toHaveAttribute('data-status', 'done');
  await expect(act.getByTestId('ares-answer')).toHaveText('I can’t do that yet. Sending is yours to do.');
  await expect(act.getByTestId('own-knowledge')).toHaveCount(0);

  // A long summary in today's Conversation, and while he writes it, a quick question in a new one.
  await say(thread, 'Write a long summary of the Roman Empire');
  const summary = turns.nth(7);
  await expect(summary).toHaveAttribute('data-status', 'streaming');
  await thread.page().getByRole('button', { name: 'New Conversation' }).click();
  await expect(thread.getByRole('heading', { name: 'New Conversation' })).toBeVisible();
  await say(thread, 'What is 2 + 2?');
  await expect(turns.nth(1).getByTestId('ares-answer')).toHaveText('4.');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done');
  // The first is still being written.
  await expect(list.getByRole('listitem', { name: 'What is a fjord?' })).toContainText('Answering');

  // Delete the new one, then Undo.
  const quick = list.getByRole('listitem', { name: 'What is 2 + 2?' });
  await quick.hover();
  await quick.getByRole('button', { name: 'Delete What is 2 + 2?' }).click();
  await expect(quick).toHaveCount(0);
  await expect(window.getByText('Deleted What is 2 + 2?')).toBeVisible();
  await window.getByRole('button', { name: 'Undo' }).click();
  await expect(list.getByRole('listitem', { name: 'What is 2 + 2?' })).toBeVisible();

  // Both are kept across a restart (the summary he was writing stopped where it got to).
  await commander.app.close();
  commander = await launchCommander({ userDataDir: commander.userDataDir, env });
  window = await commander.window();
  ({ list, thread } = await openConversations(window));
  await expect(list.getByRole('listitem', { name: 'What is 2 + 2?' })).toBeVisible();
  const today = list.getByRole('listitem', { name: 'What is a fjord?' });
  await expect(today).toBeVisible();
  await expect(thread.getByRole('heading', { name: 'What is a fjord?' })).toBeVisible();
  const reopened = thread.getByTestId('conversation-turn');
  await expect(reopened.nth(0)).toHaveText('What is a fjord?');
  await expect(reopened.nth(7)).toHaveAttribute('data-status', 'stopped');

  // Deleted again, and left deleted.
  const again = list.getByRole('listitem', { name: 'What is 2 + 2?' });
  await again.hover();
  await again.getByRole('button', { name: 'Delete What is 2 + 2?' }).click();
  await expect(again).toHaveCount(0);
});

test('with the model on this machine, a second Conversation waits its turn and says so', async () => {
  test.setTimeout(120_000);
  commander = await launchCommander({ env: { COMMANDER_TEST_HOOKS: '1' } });
  const window = await commander.window();
  await connectFakeModel(window);
  const { list, thread } = await openConversations(window);
  await expect(thread.getByRole('heading', { name: 'Today' })).toBeVisible();

  await say(thread, 'Write a long summary of the Roman Empire');
  const turns = thread.getByTestId('conversation-turn');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'streaming');
  await thread.page().getByRole('button', { name: 'New Conversation' }).click();
  await expect(thread.getByRole('heading', { name: 'New Conversation' })).toBeVisible();
  await say(thread, 'What is 2 + 2?');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'queued');
  await expect(turns.nth(1)).toContainText('Waiting his turn: Ares is answering in another Conversation.');

  // The first one stopped, the second gets its turn.
  await list
    .getByRole('listitem', { name: 'Write a long summary of the…' })
    .getByRole('button')
    .first()
    .click();
  await thread.getByRole('button', { name: 'Stop' }).click();
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'stopped');
  await list.getByRole('listitem', { name: 'What is 2 + 2?' }).getByRole('button').first().click();
  await expect(turns.nth(1).getByTestId('ares-answer')).toHaveText('4.');
});
