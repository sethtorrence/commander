import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares changing his own settings when asked (#197), end to end, with a fake OpenAI-compatible server
// standing in for Z.ai (never the real one). Told "Sort my email without asking", he prepares the change
// as a card showing the setting, its value now and the new one, which waits for the User although
// Organise runs on its own at the default settings; one key (Enter) confirms it, and Settings → Autonomy
// shows the new level. Undo from Ares's activity puts it back. Asked to let replies to invitations go
// without asking, he can't: Act for you never goes above Ask, and he says so in Commander's words.
// Turning the meeting heads-up on the same way shows in Settings → Calendar, seen before. The
// model's key goes in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

type Message = { role: string; content: string };

// The fake model. In a Conversation: from what the User asked and what Commander's note says the Skill
// did, the Skill step or the answer. Every other job of Ares's gets nothing to do.
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
  if (asked === 'Sort my email without asking') {
    if (!material)
      return stream(
        `[skill]\n{"skill":"settings","input":{"setting":"autonomy","action":"Sort into Buckets","level":"Auto","asked":"${asked}"}}`,
      );
    return stream('[their-data]\nIt’s ready: confirm it and I’ll sort your email without asking.');
  }
  if (asked === 'Turn on the meeting heads-up') {
    if (!material)
      return stream(
        `[skill]\n{"skill":"settings","input":{"setting":"meeting-heads-up","on":true,"asked":"${asked}"}}`,
      );
    return stream('[their-data]\nConfirm it and I’ll turn it on.');
  }
  if (asked === 'Reply to invitations without asking me') {
    if (!material)
      return stream(
        `[skill]\n{"skill":"settings","input":{"setting":"autonomy","action":"Reply to invitations","level":"Auto","asked":"${asked}"}}`,
      );
    // He relays what Commander told him, as he is asked to.
    const why = /Act for you can’t go above Ask: [^.]*/.exec(material)?.[0] ?? 'I couldn’t';
    return stream(`[their-data]\nI can’t change that. ${why}.`);
  }
  return stream('[chat]\nHello.');
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
  await window.getByTestId('model-key-input').fill('zai-e2e-settings-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function say(thread: Locator, text: string) {
  const input = thread.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

// Settings → Autonomy, opened afresh, and the level of one of Ares's actions there.
async function levelOf(page: Page, action: string): Promise<Locator> {
  await openSettings(page, 'Autonomy');
  const grid = page.getByRole('table', { name: 'Autonomy settings' });
  await expect(grid).toBeVisible();
  return grid.getByRole('combobox', { name: action, exact: true });
}

test('an Autonomy setting changed by asking: a card that always asks, confirmed with one key, shown in Settings, and undone', async () => {
  test.setTimeout(120_000);
  commander = await launchCommander();
  const page = await commander.window();
  // Ares's own jobs stay out of the way: only what the User asks for happens here.
  for (const job of ['suggest-todos', 'file-into-projects']) {
    await page.evaluate(
      (job) => window.commander.autonomy({ op: 'set-job-enabled', job, enabled: false }),
      job,
    );
  }
  await connectFakeModel(page);
  // The line for changing his settings has no level of its own: it always asks.
  await settingsPage(page, 'Autonomy');
  const grid = page.getByRole('table', { name: 'Autonomy settings' });
  const own = grid.getByTestId('registered-action').filter({ hasText: 'Change Ares’s settings' });
  await expect(own.getByTestId('always-asks')).toHaveText('Always asks');
  await expect(grid.getByRole('combobox', { name: 'Sort into Buckets', exact: true })).toHaveText('Same');
  await page.keyboard.press('Escape');

  await tab(page, 'Ares').click();
  const section = page.getByTestId('section-ares');
  const conversations = section.getByTestId('conversations');
  await conversations.scrollIntoViewIfNeeded();
  const thread = conversations.getByTestId('conversation-thread');
  const turns = thread.getByTestId('conversation-turn');

  // Organise runs on its own at the default settings, yet the change waits for the User as a card.
  await say(thread, 'Sort my email without asking');
  const answer = turns.nth(1);
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  const card = answer.getByTestId('conversation-action');
  await expect(card).toHaveAttribute('data-status', 'waiting');
  await expect(card.getByTestId('conversation-action-setting')).toHaveText(
    'Sort into Buckets (Autonomy · Organise)',
  );
  await expect(card.getByTestId('conversation-action-from')).toHaveText(
    'Same as Organise everywhere (Auto when sure)',
  );
  await expect(card.getByTestId('conversation-action-to')).toHaveText('Auto');
  await expect(card.getByTestId('conversation-action-why')).toHaveText(
    'Asks first: Ares never changes his own settings without you.',
  );
  // Nothing has changed until the User confirms: Enter does, with Confirm focused.
  await expect(card.getByRole('button', { name: /Confirm/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-status', 'confirmed');
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible();

  // Settings shows the new level.
  await expect(await levelOf(page, 'Sort into Buckets')).toHaveText('Auto');
  await page.keyboard.press('Escape');

  // Ares's activity has it, with the Conversation as its cause, and undoes it.
  await tab(page, 'Ares').click();
  const activity = section.getByRole('list', { name: 'Ares’s activity' });
  await activity.scrollIntoViewIfNeeded();
  const row = activity.getByRole('listitem', { name: /^Change Ares’s settings: / });
  await expect(row).toContainText(
    'Change Sort into Buckets (Autonomy · Organise) from Same as Organise everywhere (Auto when sure) to Auto',
  );
  await expect(row.getByTestId('activity-conversation')).toHaveText(
    'Asked for in your Conversation Sort my email without asking',
  );
  await row.getByRole('button', { name: 'Undo' }).click();
  await expect(row.getByTestId('activity-status')).toHaveText('Accepted by you · undone');
  await conversations.scrollIntoViewIfNeeded();
  await expect(card).toHaveAttribute('data-status', 'undone');
  await expect(await levelOf(page, 'Sort into Buckets')).toHaveText('Same');
  await page.keyboard.press('Escape');

  // Past a hard limit he prepares nothing and says why, plainly.
  await tab(page, 'Ares').click();
  await conversations.scrollIntoViewIfNeeded();
  await say(thread, 'Reply to invitations without asking me');
  const refused = turns.nth(3);
  await expect(refused).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(refused).toContainText(
    'I can’t change that. Act for you can’t go above Ask: what it does is seen by other people',
  );
  await expect(refused.getByTestId('conversation-action')).toHaveCount(0);
  await expect(await levelOf(page, 'Reply to invitations')).toHaveText('Same');

  // The heads-up, with Settings → Calendar seen before the change: shown again, it has the new value.
  await settingsPage(page, 'Calendar');
  const headsUp = page.getByTestId('meeting-heads-up');
  await expect(headsUp).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await tab(page, 'Ares').click();
  await conversations.scrollIntoViewIfNeeded();
  await say(thread, 'Turn on the meeting heads-up');
  const headsUpCard = turns.nth(5).getByTestId('conversation-action');
  await expect(headsUpCard).toHaveAttribute('data-status', 'waiting', { timeout: 20_000 });
  await expect(headsUpCard.getByTestId('conversation-action-from')).toHaveText('Off');
  await expect(headsUpCard.getByTestId('conversation-action-to')).toHaveText('On');
  await expect(headsUpCard.getByRole('button', { name: /Confirm/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(headsUpCard).toHaveAttribute('data-status', 'confirmed');
  await openSettings(page, 'Calendar');
  await expect(headsUp).toHaveAttribute('aria-checked', 'true');
});
