import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ask Ares from Ctrl+K, and finding past Conversations in search (#195), end to end, with a fake
// OpenAI-compatible server standing in for Z.ai (never the real one) and the stand-in embedding model
// for search by meaning. Typing in the palette and pressing Tab starts a new Conversation in the Ares
// Section with that text as its first message; the Conversation is found again by its words (the
// matching line, opening at that turn) and by meaning (marked related); deleted, it is gone from
// search. The model's key goes in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

type Message = { role: string; content: string };

// The fake model: a Conversation's answer by what the User asked last; every other job of Ares's gets
// nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  if (!system.startsWith('You are Ares. You work inside Commander')) {
    if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
    return { json: chatCompletion('{"todos":[]}') };
  }
  const asked = messages.at(-1)?.content ?? '';
  const answer = asked.includes('fjord')
    ? ['[general]\n', 'A fjord is a long, ', 'narrow inlet ', 'carved by glaciers.']
    : asked.includes('throttle')
      ? ['[general]\n', 'Back off ', 'when the rate limit bursts.']
      : ['[chat]\n', 'Hello.'];
  return { sse: streamedCompletion(answer, { prompt: 400, completion: answer.length }), sseEveryMs: 20 };
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

// Points Ares's model at the fake server and saves a made-up key in the keyring; search by meaning
// gets ready on the stand-in model meanwhile.
async function connectFakeModel(window: Page) {
  await openSettings(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-ask-ares-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await expect(window.getByTestId('search-by-meaning-status')).toHaveText(/Ready/, { timeout: 20_000 });
  await window.keyboard.press('Escape');
}

const palette = (window: Page) => window.getByTestId('palette');
const search = (window: Page) => palette(window).getByRole('combobox', { name: 'Search Commander' });

async function openPalette(window: Page, text: string) {
  await window.keyboard.press('Control+k');
  await expect(palette(window)).toBeVisible();
  await search(window).fill(text);
}

test('asks Ares from Ctrl+K, finds the Conversation again by words and meaning, and not once deleted', async () => {
  test.setTimeout(120_000);
  const env = { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_MODEL_IN_CLOUD: '1' };
  commander = await launchCommander({ env });
  const window = await commander.window();
  await connectFakeModel(window);

  // Ask Ares is the last row, and Tab sends what was typed.
  await openPalette(window, 'What is a fjord?');
  const ask = palette(window).getByRole('option', { name: /Ask Ares: “What is a fjord\?”/ });
  await expect(ask).toBeVisible();
  await expect(palette(window).getByRole('option').last()).toHaveText(/Ask Ares/);
  await search(window).press('Tab');
  await expect(palette(window)).toHaveCount(0);

  // A new Conversation in the Ares Section, with the text as its first message, and his answer.
  const conversations = window.getByTestId('section-ares').getByTestId('conversations');
  const thread = conversations.getByTestId('conversation-thread');
  await expect(thread.getByRole('heading', { name: 'What is a fjord?' })).toBeVisible();
  const turns = thread.getByTestId('conversation-turn');
  await expect(turns.nth(0)).toHaveText('What is a fjord?');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(turns.nth(1).getByTestId('ares-answer')).toHaveText(
    'A fjord is a long, narrow inlet carved by glaciers.',
  );
  const list = conversations.getByTestId('conversation-list');
  await expect(list.getByRole('listitem', { name: 'What is a fjord?' })).toBeVisible();

  // Another, by choosing the row with Enter.
  await openPalette(window, 'Should we throttle the bursts?');
  await palette(window)
    .getByRole('option', { name: /Ask Ares/ })
    .click();
  await expect(thread.getByRole('heading', { name: 'Should we throttle the bursts?' })).toBeVisible();
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

  // Found by words: the matching line, and opening it shows the turn that matched.
  await openPalette(window, 'glaciers');
  const byWords = palette(window).getByRole('group', { name: 'Conversations' }).getByRole('option');
  await expect(byWords).toHaveCount(1);
  await expect(byWords).toContainText(
    'What is a fjord? · A fjord is a long, narrow inlet carved by glaciers.',
  );
  await search(window).press('Enter');
  await expect(thread.getByRole('heading', { name: 'What is a fjord?' })).toBeVisible();
  await expect(turns.nth(1)).toHaveAttribute('data-found', 'true');
  await expect(turns.nth(0)).not.toHaveAttribute('data-found', 'true');

  // Found by meaning, sharing no words with it, once all four turns are embedded in the background.
  // Waiting reads where search by meaning stands rather than searching: every query holds the
  // background pass back a little (the palette goes first), so asking again and again would starve it.
  // Under the stand-in model both turns are well within its floor (conversations.test.ts checks).
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const reply = await globalThis.window.commander.models({ op: 'meaning-status' });
          const { embedded, total } = reply.ok ? reply.result : { embedded: 0, total: 0 };
          return total >= 4 && embedded === total;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  await openPalette(window, 'rate limiter');
  const related = palette(window)
    .getByRole('group', { name: 'Conversations' })
    .getByRole('option', { name: /Should we throttle the bursts\?/ });
  await expect(related).toBeVisible();
  await expect(related.getByTestId('palette-related')).toBeVisible();
  await window.keyboard.press('Escape');

  // Deleted, it leaves search with it.
  const fjord = list.getByRole('listitem', { name: 'What is a fjord?' });
  await fjord.hover();
  await fjord.getByRole('button', { name: 'Delete What is a fjord?' }).click();
  await expect(fjord).toHaveCount(0);
  await openPalette(window, 'glaciers');
  await expect(palette(window).getByRole('option', { name: /Ask Ares: “glaciers”/ })).toBeVisible();
  await expect(palette(window).getByRole('group', { name: 'Conversations' })).toHaveCount(0);
});
