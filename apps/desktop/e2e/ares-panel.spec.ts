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

// The Ares panel (#235), end to end, with a fake OpenAI-compatible server standing in for Z.ai (never
// the real one), streaming its answers a piece at a time. Ctrl+J opens the panel beside the Todos;
// two Conversations stream at once, and going to the Calendar, or from one to the other, stops
// neither; the list says which are answering. A link in an answer opens its Daily Note line in Notes
// with the panel still beside it; Esc hands the focus back; `?` lists the key; its edge makes it
// wider. After a restart the panel is open again, as wide, on the same Conversation, and both earlier
// ones are there, finished. The model's key goes in the real keyring, so this needs the author's
// Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

type Message = { role: string; content: string };

const STORY = ['[general]\n', ...Array.from({ length: 40 }, (_, i) => `word${i} `)];
const SUMMARY = ['[general]\n', ...Array.from({ length: 40 }, (_, i) => `part${i} `)];

// The fake model: a Conversation's answer by what the User asked last, a Find step first for where
// their notes are; every other job of Ares's gets nothing to do.
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
  const stream = (tokens: string[], sseEveryMs: number): FakeReply => ({
    sse: streamedCompletion(tokens, { prompt: 400, completion: tokens.length }),
    sseEveryMs,
  });
  if (asked.includes('long story')) return stream(STORY, 200);
  if (asked.includes('long summary')) return stream(SUMMARY, 200);
  if (asked.includes('Acme redlines')) {
    if (!found) return stream(['[skill]\n{"skill":"find","input":{"query":"acme redlines"}}'], 20);
    const ref = /ref="(I\d+)" label="I\d+ · Daily Note line · Acme redlines/.exec(
      messages.at(-1)?.content ?? '',
    )?.[1];
    return stream([`[their-data]\nLeo marked up clause 4 [${ref}].`], 20);
  }
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
  await openSettings(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-panel-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await window.keyboard.press('Escape');
}

// A line the User wrote in a Daily Note, through the window's Item store channel.
async function writeBlock(page: Page, text: string) {
  await page.evaluate(async (text) => {
    const note = await window.commander.itemStore({ op: 'daily-note', day: '2026-10-01' });
    await window.commander.itemStore({
      op: 'record',
      action: {
        type: 'create',
        item: {
          kind: 'block',
          title: text,
          detail: {
            kind: 'block',
            dailyNoteId: note.id,
            parentId: null,
            position: 'a0',
            text,
            folded: false,
          },
        },
      },
    });
  }, text);
}

async function say(panel: Locator, text: string) {
  const input = panel.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const panelOf = (window: Page) => {
  const panel = window.getByTestId('ares-panel');
  return {
    panel,
    list: panel.getByTestId('conversation-list'),
    thread: panel.getByTestId('conversation-thread'),
    turns: panel.getByTestId('conversation-thread').getByTestId('conversation-turn'),
  };
};

const widthOf = async (locator: Locator) => (await locator.boundingBox())?.width ?? 0;

test('beside two Sections: two Conversations at once, a link opening its Item beside it, and all found again after a restart', async () => {
  test.setTimeout(180_000);
  const env = { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_MODEL_IN_CLOUD: '1' };
  commander = await launchCommander({ env });
  let window = await commander.window();
  await connectFakeModel(window);
  await writeBlock(window, 'Acme redlines: Leo marked up clause 4');

  // The Todos: Ctrl+J opens the panel beside the Section, and the box takes the focus.
  await tab(window, 'Todos').click();
  const mark = window.getByRole('button', { name: 'Ares panel', exact: true });
  await expect(mark).toHaveAttribute('aria-pressed', 'false');
  await window.keyboard.press('Control+j');
  let { panel, list, thread, turns } = panelOf(window);
  await expect(panel).toBeVisible();
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(thread.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Message Ares' })).toBeFocused();
  // Beside the Section, not over it.
  const todos = await window.getByTestId('section-todos').boundingBox();
  const beside = await panel.boundingBox();
  expect((todos?.x ?? 0) + (todos?.width ?? 0)).toBeLessThanOrEqual((beside?.x ?? 0) + 1);

  // A long story in today's Conversation, and while he writes it, a long summary in a new one.
  await say(panel, 'Tell me a long story');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'streaming');
  await panel.getByRole('button', { name: 'New Conversation' }).click();
  await expect(thread.getByRole('heading', { name: 'New Conversation' })).toBeVisible();
  await say(panel, 'Write a long summary of the Roman Empire');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'streaming');
  const story = list.getByRole('listitem', { name: 'Tell me a long story' });
  const summary = list.getByRole('listitem', { name: 'Write a long summary of the…' });
  await expect(story).toHaveAttribute('data-state', 'answering');
  await expect(summary).toHaveAttribute('data-state', 'answering');

  // The Calendar: the panel stays beside it, on the same Conversation, still writing.
  await tab(window, 'Calendar').click();
  await expect(window.getByTestId('header-title')).toHaveText('Calendar');
  await expect(panel).toBeVisible();
  await expect(thread.getByRole('heading', { name: 'Write a long summary of the…' })).toBeVisible();
  await expect(turns.nth(1).getByTestId('ares-answer')).toContainText('part3');

  // Back to the story: he kept writing it meanwhile, and carries on; switching stopped neither.
  await story.getByRole('button').first().click();
  await expect(thread.getByRole('heading', { name: 'Tell me a long story' })).toBeVisible();
  await expect(turns.nth(1).getByTestId('ares-answer')).toContainText('word3');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  await expect(turns.nth(1).getByTestId('ares-answer')).toContainText('word39');
  await expect(story).not.toHaveAttribute('data-state', 'answering');
  await expect(summary).not.toHaveAttribute('data-state', 'answering', { timeout: 30_000 });
  await summary.getByRole('button').first().click();
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done');
  await expect(turns.nth(1).getByTestId('ares-answer')).toContainText('part39');

  // A link in an answer opens its Item in its Section, with the panel still beside it.
  await panel.getByRole('button', { name: 'New Conversation' }).click();
  await expect(thread.getByRole('heading', { name: 'New Conversation' })).toBeVisible();
  await say(panel, 'Where did I note the Acme redlines?');
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await turns.nth(1).getByRole('button', { name: 'Open Acme redlines: Leo marked up clause 4' }).click();
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  const block = window.locator('#day-2026-10-01').locator('.n-blk', {
    has: window.locator('[data-block-text]', { hasText: /^Acme redlines: Leo marked up clause 4$/ }),
  });
  await expect(block).toHaveClass(/\bflash\b/);
  await expect(panel).toBeVisible();
  await expect(thread.getByRole('heading', { name: 'Where did I note the Acme…' })).toBeVisible();

  // Esc in it hands the focus back to the Section; `?` lists its key.
  const input = panel.getByRole('textbox', { name: 'Message Ares' });
  await input.focus();
  await window.keyboard.press('Escape');
  await expect(input).not.toBeFocused();
  await expect(panel).toBeVisible();
  await window.keyboard.press('?');
  const sheet = window.getByTestId('cheat-sheet');
  await expect(sheet.getByText('Open or close the Ares panel')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Wider by its edge.
  const before = await widthOf(panel);
  const edge = panel.getByRole('separator', { name: 'Resize the Ares panel' });
  const grip = await edge.boundingBox();
  const x = (grip?.x ?? 0) + (grip?.width ?? 0) / 2;
  const y = (grip?.y ?? 0) + 200;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x - 60, y, { steps: 4 });
  await window.mouse.up();
  await expect.poll(() => widthOf(panel)).toBeGreaterThan(before + 40);
  const width = await widthOf(panel);

  // The header's mark closes it, and opens it again.
  await mark.click();
  await expect(panel).toBeHidden();
  await mark.click();
  await expect(panel).toBeVisible();

  // After a restart: open, as wide, on the same Conversation, with both earlier ones finished.
  await commander.app.close();
  commander = await launchCommander({ userDataDir: commander.userDataDir, env });
  window = await commander.window();
  ({ panel, list, thread, turns } = panelOf(window));
  await expect(panel).toBeVisible();
  await expect.poll(() => widthOf(panel)).toBe(width);
  await expect(thread.getByRole('heading', { name: 'Where did I note the Acme…' })).toBeVisible();
  await expect(turns.nth(1).getByTestId('ares-answer')).toContainText('Leo marked up clause 4');
  await list.getByRole('listitem', { name: 'Tell me a long story' }).getByRole('button').first().click();
  await expect(thread.getByRole('heading', { name: 'Tell me a long story' })).toBeVisible();
  await expect(turns.nth(1)).toHaveAttribute('data-status', 'done');
  await expect(turns.nth(1).getByTestId('ares-answer')).toContainText('word39');
  await expect(
    list.getByRole('listitem', { name: 'Write a long summary of the…' }).getByTestId('conversation-state'),
  ).not.toHaveText('Answering');
});
