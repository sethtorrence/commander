import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares suggests Todos from what the User writes in a Daily Note, end to end against a fake
// OpenAI-compatible server standing in for Z.ai: type, pause, a margin card, Add, and the Todo is in
// the Todos Section with origin Ares. The model's API key is kept in the real keyring, so this needs
// the author's Linux Wayland session. Ares's pause after typing is shortened to 1.5 seconds.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const env = { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_ARES_PAUSE_MS: '1500' };

let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await server?.close();
});

// The fake model's answer to "Suggest Todos": a Todo for each Block it was given (by its reference in
// the prompt) whose text it knows, taking its time when it has something to say.
function suggestTodos(known: Record<string, { title: string; confidence: number }>) {
  return (request: FakeRequest): FakeReply => {
    const messages = request.body.messages as { role: string; content: string }[];
    const todos = (messages.at(-1)?.content ?? '').split('\n').flatMap((line) => {
      const [, blockId, text] = /\[(B\d+)\] (.*)$/.exec(line) ?? [];
      const todo = text ? known[text.trim()] : undefined;
      return blockId && todo ? [{ blockId, ...todo }] : [];
    });
    return {
      json: chatCompletion(JSON.stringify({ todos }), { prompt: 1_200, completion: 80 }),
      delayMs: todos.length ? 1_500 : 0,
    };
  };
}

const today = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      label: `${date.getDate()} ${months[date.getMonth()]}`,
    };
  });

// Today's Daily Note, started empty (the daily template emptied first).
async function openNotes(page: Page): Promise<Locator> {
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${(await today(page)).key}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

const blockRow = (sheet: Locator, text: string) =>
  sheet.locator('.n-blk').filter({
    has: sheet.page().locator(':scope > .n-row [data-block-text]', { hasText: new RegExp(`^${text}$`) }),
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
  await window.getByTestId('model-key-input').fill('zai-e2e-suggest-todos-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

test('type, pause, a margin card, Add: the Todo is in Todos with origin Ares; Dismiss is for good', async () => {
  // Two launches and Ares's pauses.
  test.setTimeout(90_000);
  server.respondWith(
    suggestTodos({
      'need to send Dana the Q3 numbers': { title: 'Send Dana the Q3 numbers', confidence: 0.62 },
      'maybe book flights for the offsite': { title: 'Book flights for the offsite', confidence: 0.55 },
    }),
  );
  commander = await launchCommander({ env });
  const window = await commander.window();
  await connectFakeModel(window);
  // Settings → Ares lists the job, switched on.
  await expect(window.getByRole('switch', { name: 'Suggest Todos', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // The User writes two lines in today's note, then pauses.
  const sheet = await openNotes(window);
  const day = await today(window);
  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('need to send Dana the Q3 numbers');
  await window.keyboard.press('Enter');
  await window.keyboard.type('maybe book flights for the offsite');

  // Ares works on it (the status module says so), then goes idle again.
  const state = window.getByTestId('ares-state');
  await expect(state).toHaveText('Working', { timeout: 15_000 });
  await expect(window.getByTestId('ares-status')).toContainText('Ares is working on Suggest Todos');
  await expect(state).toHaveText('Idle', { timeout: 15_000 });

  // He wasn't sure, so each suggestion waits in the margin beside its Block.
  const dana = sheet.getByRole('group', { name: 'Suggested by Ares: Send Dana the Q3 numbers' });
  const flights = sheet.getByRole('group', { name: 'Suggested by Ares: Book flights for the offsite' });
  await expect(dana).toContainText('Todo: Send Dana the Q3 numbers');
  await expect(dana).toContainText('You wrote “need to send Dana the Q3 numbers” in your Daily Note.');
  await expect(flights).toBeVisible();
  await expect(sheet.locator('.n-sp-tab .ares dd')).toHaveText('02');
  // One Quick call at low thinking, in JSON mode, with the Blocks delimited as data.
  const call = server.requests.at(-1)?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('low');
  expect(call.messages.at(-1)?.content).toMatch(
    /^<data-[0-9a-f]{16} label="Daily Note · .*" source="the User">/,
  );

  // Add makes the Todo: the Block shows its checkbox. Dismiss takes the card away for good.
  await dana.getByRole('button', { name: 'Add' }).click();
  await expect(dana).toHaveCount(0);
  const danaBlock = blockRow(sheet, 'need to send Dana the Q3 numbers');
  await expect(danaBlock.getByRole('checkbox', { name: 'Tick the Todo' })).toBeVisible();
  await flights.getByRole('button', { name: 'Dismiss' }).click();
  await expect(flights).toHaveCount(0);
  await expect(blockRow(sheet, 'maybe book flights for the offsite').getByRole('checkbox')).toHaveCount(0);

  // In Todos: origin Ares with the Daily Note's day, and the made-from Link jumps to the Block.
  await tab(window, 'Todos').click();
  const todos = window.getByTestId('section-todos');
  const open = todos.getByRole('region', { name: 'Open' });
  await expect(open.getByRole('listitem')).toHaveText([
    new RegExp(`Send Dana the Q3 numbers.*Ares · ${day.label}`),
  ]);
  await open.getByText('Send Dana the Q3 numbers').click();
  const detail = todos.getByRole('region', { name: 'Todo detail' });
  await expect(detail).toContainText('Ares');
  await detail
    .getByRole('region', { name: 'Links' })
    .getByRole('button', { name: /Made from.*need to send Dana the Q3 numbers/ })
    .click();
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  await expect(danaBlock).toHaveClass(/\bflash\b/);

  // Every call is on the Usage page, under "Suggest Todos".
  const calls = server.requests.length;
  await openSettings(window, 'Ares');
  const usage = window.getByTestId('usage-panel');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  await expect(usage.getByTestId('usage-by-job')).toContainText('Suggest Todos');

  // After a restart nothing is offered again: the dismissed text stays dismissed.
  const userDataDir = commander.userDataDir;
  await commander.app.close();
  commander = await launchCommander({ env, userDataDir });
  const again = await commander.window();
  const reopened = await openNotes(again);
  await expect(blockRow(reopened, 'maybe book flights for the offsite')).toBeVisible();
  // Long enough for Ares's start-up look (after the 1.5 s pause) to have run.
  await again.waitForTimeout(3_000);
  await expect(reopened.getByTestId('margin-card')).toHaveCount(0);
  expect(server.requests.length).toBe(calls);
});
