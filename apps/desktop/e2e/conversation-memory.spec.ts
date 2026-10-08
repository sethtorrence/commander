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

// What the User tells Ares becomes confirmed Memory (#194), end to end, with a fake OpenAI-compatible
// server standing in for Z.ai (never the real one). The User tells Ares a preference: his answer says
// he'll remember it, What Ares knows lists it as theirs and links back to the turn, a later
// Conversation recalls it, and Undo on the line takes it back. A fact told in a Conversation that is
// then deleted stays, from "a deleted Conversation". The model's key goes in the real keyring, so this
// needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

type Message = { role: string; content: string };

const PREFERENCE = 'The User doesn’t take meetings before 10';
const LEO = 'Leo is the User’s contact at Acme';

// The fake model. A Conversation's answer: what Ares knows, when the User asks when they can meet;
// otherwise a short "Noted.". The call that keeps what the User tells him: the preference, or the
// fact about Leo, when the User's latest message states it. Every other job of Ares's finds nothing.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  const all = messages.map((message) => message.content).join('\n');
  const stream = (tokens: string[]): FakeReply => ({
    sse: streamedCompletion(tokens, { prompt: 300, completion: tokens.length }),
    sseEveryMs: 20,
  });
  if (system.startsWith('You are Ares. You work inside Commander')) {
    const knows =
      /label="What Ares knows" source="the User">\n- \(preference\) The User doesn’t take meetings before 10/;
    if (all.includes('meetings at 9') && knows.test(all)) {
      return stream(['[their-data]\n', 'Not at 9: ', 'you don’t take meetings before 10.']);
    }
    return stream(['[chat]\n', 'Noted.']);
  }
  if (system.startsWith('You are Ares. The User is talking with you in a Conversation')) {
    const latest = /label="The User’s latest message" source="the User">\n([^\n]*)/.exec(all)?.[1] ?? '';
    const remember = latest.includes('meetings before 10')
      ? [{ kind: 'preference', text: PREFERENCE, said: 'you don’t take meetings before 10' }]
      : latest.includes('Acme contact')
        ? [{ kind: 'fact', text: LEO, said: 'Leo is your contact at Acme', person: 'Leo' }]
        : [];
    return { json: chatCompletion(JSON.stringify({ remember, forget: [] })) };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
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
  await openSettings(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-conversation-memory-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await window.keyboard.press('Escape');
}

async function say(thread: Locator, text: string) {
  const input = thread.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const memoryRow = (known: Locator, text: string) => known.getByTestId('memory').filter({ hasText: text });

test('a preference told to Ares is kept as the User’s, linked to its turn, recalled later, and Undo takes it back', async () => {
  test.setTimeout(150_000);
  commander = await launchCommander({
    env: { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_MODEL_IN_CLOUD: '1' },
  });
  const window = await commander.window();
  await connectFakeModel(window);
  await tab(window, 'Ares').click();
  const section = window.getByTestId('section-ares');
  const known = section.getByTestId('what-ares-knows');
  const conversations = section.getByTestId('conversations');
  const list = conversations.getByTestId('conversation-list');
  const thread = conversations.getByTestId('conversation-thread');
  await conversations.scrollIntoViewIfNeeded();
  await expect(thread.getByRole('heading', { name: 'Today' })).toBeVisible();

  // The User tells him a preference: his answer says he'll remember it, with Undo on the line.
  await say(thread, 'I don’t take meetings before 10');
  const turns = thread.getByTestId('conversation-turn');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done');
  const line = turns.nth(1).getByTestId('remembered');
  await expect(line).toContainText('I’ll remember that you don’t take meetings before 10.');
  await expect(line.getByRole('button', { name: /^Undo/ })).toBeVisible();

  // What Ares knows lists it as the User's, from the Conversation.
  await known.scrollIntoViewIfNeeded();
  const kept = memoryRow(known, PREFERENCE);
  await expect(kept).toBeVisible();
  await expect(kept).toContainText('Added');
  await expect(kept).not.toContainText('Unconfirmed');
  await expect(kept.getByRole('button', { name: 'I don’t take meetings before 10' })).toBeVisible();

  // A later Conversation recalls it as the User's own.
  await conversations.scrollIntoViewIfNeeded();
  await conversations.getByRole('button', { name: 'New Conversation' }).click();
  await expect(thread.getByRole('heading', { name: 'New Conversation' })).toBeVisible();
  await say(thread, 'Can I take meetings at 9 tomorrow?');
  await expect(turns.nth(1).getByTestId('ares-answer')).toHaveText(
    'Not at 9: you don’t take meetings before 10.',
  );

  // Its source opens the Conversation at the turn the User said it in, in the Ares panel (#235).
  await known.scrollIntoViewIfNeeded();
  await kept.getByRole('button', { name: 'I don’t take meetings before 10' }).click();
  const panel = window.getByTestId('ares-panel').getByTestId('conversation-thread');
  await expect(panel.getByRole('heading', { name: 'I don’t take meetings before 10' })).toBeVisible();
  const told = panel.getByTestId('conversation-turn');
  await expect(told.nth(0)).toHaveAttribute('data-found', 'true');

  // Undo on the line there: the memory goes from What Ares knows.
  const there = told.nth(1).getByTestId('remembered');
  await there.getByRole('button', { name: /^Undo/ }).click();
  await expect(there).toHaveAttribute('data-undone', 'true');
  await expect(there).toContainText('Undone');
  await expect(memoryRow(known, PREFERENCE)).toHaveCount(0);
  await window.keyboard.press('Control+j');
  await expect(window.getByTestId('ares-panel')).toBeHidden();

  // A fact told in a Conversation that is then deleted stays, from "a deleted Conversation".
  await conversations.getByRole('button', { name: 'New Conversation' }).click();
  await expect(thread.getByRole('heading', { name: 'New Conversation' })).toBeVisible();
  await say(thread, 'Leo is our Acme contact');
  await expect(turns.nth(1).getByTestId('remembered')).toContainText(
    'I’ll remember that Leo is your contact at Acme.',
  );
  await expect(memoryRow(known, LEO)).toBeVisible();
  await thread.getByRole('button', { name: 'Delete Leo is our Acme contact' }).click();
  await expect(list.getByRole('listitem', { name: 'Leo is our Acme contact' })).toHaveCount(0);
  await known.scrollIntoViewIfNeeded();
  await known.getByRole('searchbox', { name: 'Search what Ares knows' }).fill('Leo');
  await expect(memoryRow(known, LEO)).toContainText('a deleted Conversation');
});
