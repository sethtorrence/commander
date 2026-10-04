import type { AutonomyTestRequest, Proposal } from '@commander/domain';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares's Updates end to end. He never interrupts: suggestions he wasn't sure about show only as a
// quiet count in the header, the tray and the Dashboard, and the Update opens when the User asks
// (`U`, the header button, the tray, the palette). The tests stand in for his jobs through the
// main process's test hook (never reachable from the window), proposing as a job would.

const env = { COMMANDER_TEST_HOOKS: '1' };
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

let commander: LaunchedCommander | undefined;
let server: FakeOpenAIServer | undefined;

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await server?.close();
  server = undefined;
});

function propose(app: ElectronApplication, proposal: Proposal) {
  const request: AutonomyTestRequest = { op: 'propose', proposal };
  return app.evaluate(async (_electron, request) => {
    const hooks = (globalThis as { commanderTestHooks?: { autonomy: (r: unknown) => Promise<unknown> } })
      .commanderTestHooks;
    if (!hooks) throw new Error('Test hooks are off');
    const response = (await hooks.autonomy(request)) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error);
  }, request);
}

const trayLabels = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { commanderTestHooks: { trayLabels: () => string[] } }
    ).commanderTestHooks.trayLabels(),
  );

const clickTray = (app: ElectronApplication, label: string) =>
  app.evaluate(
    (_electron, label) =>
      (
        globalThis as unknown as { commanderTestHooks: { clickTray: (label: string) => void } }
      ).commanderTestHooks.clickTray(label),
    label,
  );

let positions = 0;

// A Block the User wrote, through the window's Item store channel.
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

// A Todo Ares wasn't sure about, on a Block: it waits for the User.
async function suggestTodo(
  app: ElectronApplication,
  page: Page,
  text: string,
  title: string,
  chained = false,
) {
  const block = await writeBlock(page, text);
  await propose(app, {
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
    chained,
  });
}

// The tests propose for Suggest Todos themselves, so the job itself stays out of the way.
const switchOffSuggestTodos = (page: Page) =>
  page.evaluate(() =>
    window.commander.autonomy({ op: 'set-job-enabled', job: 'suggest-todos', enabled: false }),
  );

const panel = (page: Page) => page.getByTestId('update-panel');
const todoTitles = (page: Page) =>
  page.evaluate(async () =>
    (await window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } })).map((todo) => todo.title),
  );
const queuedCount = (page: Page) => page.getByTestId('ares-status').getByTestId('ares-queued');

test('a quiet count, and the Update only when asked: U, the header, the tray and the palette all give it', async () => {
  commander = await launchCommander({ env });
  const { app } = commander;
  const window = await commander.window();
  await switchOffSuggestTodos(window);

  await suggestTodo(app, window, 'need to send Dana the Q3 numbers', 'Send Dana the Q3 numbers');
  await suggestTodo(app, window, 'notes from the vendor call', 'Reply to the vendor', true);

  // A count in the header, the Dashboard and the tray; nothing opens.
  await expect(queuedCount(window)).toHaveText('02');
  await expect(window.getByTestId('ares-status')).toContainText('Ares has 2 things for you');
  await expect(window.getByTestId('ares-queue-count')).toHaveText('02');
  await expect.poll(() => trayLabels(app)).toContain('Ask for an update (2 queued)');
  await window.waitForTimeout(1_500);
  await expect(panel(window)).toHaveCount(0);

  // `U`: without a model key, the plain sentences.
  await window.keyboard.press('u');
  const decision = panel(window).getByRole('region', { name: 'Waiting on your decision' });
  await expect(decision.getByTestId('update-line')).toHaveCount(2);
  await expect(decision).toContainText(
    'Suggest Todos: one suggestion I wasn’t sure about, on “need to send Dana the Q3 numbers”. It’s waiting for you.',
  );
  await expect(decision).toContainText('Suggest Todos: something from outside led me to a suggestion.');
  await expect(panel(window)).toContainText('Plain sentences: Ares’s model wasn’t available');
  // Esc closes it, and everything untouched stays queued.
  await window.keyboard.press('Escape');
  await expect(panel(window)).toHaveCount(0);
  await expect(queuedCount(window)).toHaveText('02');

  // The header's button, the tray's item and the palette's command give the same Update.
  await window.getByTestId('ares-status').getByRole('button', { name: 'Ask for an update' }).click();
  await expect(panel(window).getByTestId('update-line')).toHaveCount(2);
  await window.keyboard.press('Escape');
  await expect(panel(window)).toHaveCount(0);

  await clickTray(app, 'Ask for an update (2 queued)');
  await expect(panel(window).getByTestId('update-line')).toHaveCount(2);
  await window.keyboard.press('Escape');
  await expect(panel(window)).toHaveCount(0);

  await window.keyboard.press('Control+k');
  await window.keyboard.type('Ask for an update');
  await window.keyboard.press('Enter');
  await expect(panel(window).getByTestId('update-line')).toHaveCount(2);

  // Asked four times with nothing new: one Update kept.
  await panel(window).getByRole('button', { name: 'Past Updates' }).click();
  await expect(panel(window).getByRole('list', { name: 'Past Updates' }).getByRole('listitem')).toHaveCount(
    1,
  );
});

// The fake model's answer to "Put Updates together": each line in Ares's voice, by its reference;
// anything else (another job) gets an empty answer.
function aresVoice(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  if (!messages[0]?.content.startsWith('You are Ares, the User')) {
    return { json: chatCompletion('{"todos":[]}') };
  }
  const blocks = [
    ...(messages[1]?.content ?? '').matchAll(
      /<data-[0-9a-f]+ [^>]*label="(E\d+) · [^"]*"[^>]*>\n([\s\S]*?)\n<\/data-/g,
    ),
  ];
  const lines = blocks.map(([, ref, text]) => ({
    ref,
    text: text?.includes('Dana')
      ? 'I wasn’t sure about one Todo, “need to send Dana the Q3 numbers”. It’s there when you want it.'
      : text?.includes('outside')
        ? 'Something from outside led me to a suggestion. Have a look before you say yes.'
        : 'One more thing I wasn’t sure about is waiting.',
  }));
  return { json: chatCompletion(JSON.stringify({ lines, steering: [] }), { prompt: 900, completion: 60 }) };
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, baseUrl: string) {
  await openSettings(window);
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-updates-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await window.keyboard.press('Escape');
}

test('with a fake model: queued suggestions, U, accept one in place, the count drops, Past Updates', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  test.setTimeout(60_000);
  server = await startFakeOpenAIServer();
  server.respondWith(aresVoice);
  commander = await launchCommander({ env });
  const { app } = commander;
  const window = await commander.window();
  await switchOffSuggestTodos(window);
  await connectFakeModel(window, server.baseUrl);

  await suggestTodo(app, window, 'need to send Dana the Q3 numbers', 'Send Dana the Q3 numbers');
  await suggestTodo(app, window, 'notes from the vendor call', 'Reply to the vendor', true);
  await expect(queuedCount(window)).toHaveText('02');

  // `U`: the Update, in Ares's voice.
  await window.keyboard.press('u');
  const lines = panel(window).getByTestId('update-line');
  await expect(lines).toHaveCount(2);
  const dana = lines.filter({ hasText: 'Dana' });
  await expect(dana).toContainText(
    'I wasn’t sure about one Todo, “need to send Dana the Q3 numbers”. It’s there when you want it.',
  );
  await expect(lines.filter({ hasText: 'outside' })).toContainText('Have a look before you say yes.');
  await expect(panel(window)).not.toContainText('Plain sentences');
  // One Deep call at high thinking, its material in delimited data blocks.
  const call = server.requests.at(-1)?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('high');
  expect(call.messages[1]?.content).toMatch(
    /<data-[0-9a-f]{16} label="E1 · Waiting on your decision" source="the User">/,
  );

  // Accept one in place: the Todo is made, the line shows it, and the count drops.
  await dana.getByRole('button', { name: 'Accept' }).click();
  await expect(dana.getByTestId('update-line-status')).toHaveText('Done');
  await expect(queuedCount(window)).toHaveText('01');
  expect(await todoTitles(window)).toContain('Send Dana the Q3 numbers');
  await window.keyboard.press('Escape');

  // Something new, and a second Update.
  await suggestTodo(app, window, 'maybe book flights for the offsite', 'Book flights for the offsite');
  await expect(queuedCount(window)).toHaveText('02');
  await window.keyboard.press('u');
  await expect(panel(window).getByTestId('update-line')).toHaveCount(2);
  await expect(panel(window)).toContainText('One more thing I wasn’t sure about is waiting.');

  // Past Updates: both kept, and the earlier one reopens as it was, with the accepted line done.
  await panel(window).getByRole('button', { name: 'Past Updates' }).click();
  const past = panel(window).getByRole('list', { name: 'Past Updates' }).getByRole('button');
  await expect(past).toHaveCount(2);
  await past.nth(1).click();
  await expect(panel(window).getByText(/^Past Update ·/)).toBeVisible();
  const earlier = panel(window).getByTestId('update-line').filter({ hasText: 'Dana' });
  await expect(earlier.getByTestId('update-line-status')).toHaveText('Done');
});
