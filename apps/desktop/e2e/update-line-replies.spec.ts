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
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Replying to an Update line (#236), end to end, against a fake Google (sign-in and Gmail) and a fake
// OpenAI-compatible server standing in for Z.ai, never the real ones. A Todo Ares suggests from Dana's
// email waits in the Update. In the line's Reply box the User writes "Reply saying I'll look at the
// dates on Thursday": a Conversation about the line opens in the Ares panel beside the Email Section
// with their words, Ares is handed the line's facts and Dana's email (outside, as I1), and drafts the
// reply, which Open in composer puts in the composer unsent. Back through the line's link to its
// Conversation, "Dana's handling the rest, so dismiss it": the line's own Dismiss waits as a card, one
// key (Enter) confirms it, the suggestion is dismissed as the line's button would, and the Conversation
// says so, links back to the Update, and shows the same in Full view. Nothing said there is kept as
// Memory. Tokens and the model's key go in the real keyring, so this needs the author's Linux Wayland
// session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const DANA = 'Dana Whitfield <dana@northwind.test>';
const SUBJECT = 'Q4 offsite dates';
const TODO = 'Answer Dana about the offsite dates';
const DRAFT = 'Hi Dana,\n\nI’ll look at the dates on Thursday.\n\nCheers,\nAlex';
const FIRST = 'Reply saying I’ll look at the dates on Thursday';
// The Conversation is named from the User's first words.
const TITLE = /^Reply saying I’ll look at the/;
const SECOND = 'Dana’s handling the rest, so dismiss it';

type Message = { role: string; content: string };

const isAnswer = (system: string) => system.startsWith('You are Ares. You work inside Commander');
const isRemember = (system: string) =>
  system.startsWith('You are Ares. The User is talking with you in a Conversation');
const systemOf = (request: FakeRequest) => (request.body.messages as Message[])[0]?.content ?? '';

// The fake model. In the Conversation: from what the User wrote and what Commander's note says his
// Skills did so far, the next Skill step or the answer. The drafting call answers with the draft; every
// other job of Ares's gets nothing to do (the Update keeps its plain sentences).
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = systemOf(request);
  if (!isAnswer(system)) {
    if (system.includes('You draft the User'))
      return { json: chatCompletion(JSON.stringify({ body: DRAFT, confidence: 0.9, steering: [] })) };
    if (system.includes('You learn how the User writes email'))
      return { json: chatCompletion('{"style":null,"steering":[]}') };
    if (isRemember(system)) return { json: chatCompletion('{"remember":[],"forget":[]}') };
    if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
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
  if (asked === FIRST) {
    if (!material.includes('Draft: ')) return stream('[skill]\n{"skill":"draft","input":{"item":"I1"}}');
    return stream('[their-data]\nHere’s a reply for you to send [I1].');
  }
  if (asked === SECOND) {
    if (!material.includes('Act on the Update line: '))
      return stream('[skill]\n{"skill":"line","input":{"action":"dismiss"}}');
    return stream('[their-data]\nIt waits for you to confirm.');
  }
  return stream('[chat]\nNoted.');
}

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  google = await startFakeGoogle();
  google.gmail.deliver(ALEX.email, {
    from: DANA,
    to: `Alex Kim <${ALEX.email}>`,
    subject: SUBJECT,
    text: 'Which dates work for you for the Q4 offsite?',
    date: Date.now() - 60 * 60_000,
    labels: ['INBOX', 'UNREAD'],
    messageId: '<offsite-1@mail.northwind.test>',
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await server?.close();
});

// A suggestion, proposed as Ares's job would, through the main process's test hook.
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

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(page: Page) {
  await settingsPage(page, 'Ares');
  const ares = page.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await page.getByTestId('model-settings-save').click();
  await expect(page.getByTestId('model-settings-saved')).toBeVisible();
  await page.getByTestId('model-key-input').fill('zai-e2e-update-line-replies-key');
  await page.getByTestId('model-key-save').click();
  await expect(page.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function say(thread: Locator, text: string) {
  const input = thread.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

// The Conversation's own calls, the drafting calls and the remembering calls, each by its job.
const answerCalls = () => server.requests.filter((each) => isAnswer(systemOf(each)));
const draftingCalls = () => server.requests.filter((each) => systemOf(each).includes('You draft the User'));
const rememberCalls = () => server.requests.filter((each) => isRemember(systemOf(each)));
// The suggestions still waiting on an Item.
const waitingOn = (page: Page, itemId: string) =>
  page.evaluate(
    (itemId) => window.commander.autonomy({ op: 'activity', query: { itemId, statuses: ['pending'] } }),
    itemId,
  );
const materialOf = (request: FakeRequest | undefined) =>
  ((request?.body.messages as Message[] | undefined) ?? []).map((message) => message.content).join('\n');

test('a reply to an Update line opens a Conversation about it: a drafted reply, the line’s own Dismiss confirmed with one key, and nothing kept as Memory', async () => {
  test.setTimeout(180_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_GOOGLE: JSON.stringify({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        authorizeUrl: google.authorizeUrl,
        tokenUrl: google.tokenUrl,
        userinfoUrl: google.userinfoUrl,
        gmailUrl: google.gmailUrl,
        calendarUrl: google.calendarUrl,
      }),
      COMMANDER_TEST_MODEL_IN_CLOUD: '1',
      COMMANDER_TEST_HOOKS: '1',
    },
  });
  const page = await commander.window();
  await commander.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  // Ares's own jobs stay out of the way: the test proposes for Suggest Todos itself.
  for (const job of ['suggest-todos', 'file-into-projects', 'sort-into-buckets', 'draft-email-replies']) {
    await page.evaluate(
      (job) => window.commander.autonomy({ op: 'set-job-enabled', job, enabled: false }),
      job,
    );
  }

  await openSettings(page, 'Accounts');
  await connectFakeModel(page);
  await settingsPage(page, 'Accounts');
  const googleSource = page.getByTestId('accounts-panel').getByTestId('source-google');
  await googleSource.getByRole('button', { name: 'Connect Google' }).click();
  await expect(googleSource.getByTestId('account-synced').first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // Alex lets Ares read his mail, and a Todo Ares suggests from Dana's email waits in the Update.
  await tab(page, 'Email').click();
  const email = page.getByTestId('section-email');
  await email
    .getByRole('region', { name: `Ares and ${ALEX.email}` })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();
  const [thread] = await page.evaluate(() =>
    window.commander.itemStore({ op: 'query', query: { kinds: ['email'] } }),
  );
  const emailId = thread?.id as string;
  await propose(commander.app, {
    actionKind: 'organise',
    action: 'suggest-todos',
    section: 'email',
    itemId: emailId,
    itemActions: [
      {
        type: 'create',
        item: {
          kind: 'todo',
          title: TODO,
          detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
        },
      },
      { type: 'link', from: { step: 0 }, linkType: 'made-from', to: emailId },
    ],
    confidence: 0.5,
    reason: 'Dana asked which dates work.',
    chained: false,
  });

  // U: the line, with its Reply box.
  await page.keyboard.press('u');
  const panel = page.getByTestId('update-panel');
  const line = panel.getByTestId('update-line').filter({ hasText: TODO });
  await expect(line).toBeVisible({ timeout: 20_000 });
  const box = line.getByTestId('update-line-reply').getByRole('textbox');
  await box.fill(FIRST);
  await box.press('Enter');

  // The Conversation about the line opens in the Ares panel beside the Email Section, with the User's
  // words, and shows the line it is about.
  await expect(panel).toHaveCount(0);
  const aresPanel = page.getByTestId('ares-panel');
  await expect(aresPanel).toBeVisible();
  await expect(page.getByTestId('header-title')).toHaveText('Email');
  const conversation = aresPanel.getByTestId('conversation-thread');
  await expect(conversation.getByRole('heading', { name: TITLE })).toBeVisible();
  const about = conversation.getByTestId('conversation-about-line');
  await expect(about).toContainText(TODO);
  await expect(about.getByTestId('conversation-about-line-status')).toHaveText('Waiting in your Update');
  const turns = conversation.getByTestId('conversation-turn');
  await expect(turns.nth(0)).toContainText(FIRST);

  // Ares drafts the reply from Dana's email, handed to him as I1, outside, beside the line's facts.
  const drafted = turns.nth(1);
  await expect(drafted).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  const first = materialOf(answerCalls()[0]);
  expect(first).toMatch(/label="The Update line · [^"]+" source="the User">/);
  expect(first).toMatch(new RegExp(`ref="I1" label="I1 · [^"]*${SUBJECT}[^"]*" source="outside">`));
  const draft = drafted.getByRole('region', { name: `Draft reply: ${SUBJECT}` });
  await expect(draft.getByTestId('conversation-draft-body')).toContainText(
    'I’ll look at the dates on Thursday.',
  );
  expect(draftingCalls()).toHaveLength(1);
  expect(JSON.stringify(draftingCalls()[0]?.body)).toContain('look at the dates on Thursday');
  expect(google.gmail.drafts(ALEX.email)).toEqual([]);

  // Open in composer: an ordinary draft below the thread, saved to Gmail's Drafts; nothing sent.
  await draft.getByRole('button', { name: 'Open in composer' }).click();
  const composer = email.getByRole('region', { name: 'Reply' });
  await expect(composer).toContainText('I’ll look at the dates on Thursday.');
  await expect.poll(() => google.gmail.drafts(ALEX.email).length, { timeout: 20_000 }).toBe(1);
  expect(google.gmail.sent).toEqual([]);

  // The line now names its Conversation, one click away.
  await page.getByTestId('ares-status').getByRole('button', { name: 'Ask for an update' }).click();
  await line.getByTestId('update-line-conversation').click();
  await expect(panel).toHaveCount(0);
  await expect(conversation.getByRole('heading', { name: TITLE })).toBeVisible();

  // The line's own Dismiss waits as a card; one key confirms it, as the line's button would.
  await expect(aresPanel).toBeVisible();
  await say(conversation, SECOND);
  const prepared = turns.nth(3);
  await expect(prepared).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  const card = prepared.getByTestId('conversation-line-action');
  await expect(card).toHaveAttribute('data-status', 'waiting');
  await expect(card).toContainText('Dismiss the line, and the suggestion on it');
  // The panel's list says a card waits for the User there.
  const row = aresPanel.getByTestId('conversation-list').getByRole('listitem', { name: TITLE });
  await expect(row.getByTestId('conversation-state')).toHaveText('Waiting for you');
  // Nothing happened yet: the suggestion still waits.
  expect(await waitingOn(page, emailId)).toHaveLength(1);
  await expect(card.getByRole('button', { name: /Confirm/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-status', 'confirmed');
  await expect(card.getByTestId('conversation-line-action-status')).toHaveText('Confirmed by you');
  await expect(row.getByTestId('conversation-state')).not.toHaveText('Waiting for you');

  // The Conversation stays and says what became of the line; the suggestion is dismissed, no Todo made.
  await expect(about.getByTestId('conversation-about-line-status')).toHaveText('You dismissed it');
  await expect.poll(() => waitingOn(page, emailId)).toEqual([]);
  const todos = await page.evaluate(() =>
    window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } }),
  );
  expect(todos.map((todo) => todo.title)).not.toContain(TODO);

  // Its link back opens the Update, where the line shows as dismissed.
  await about.getByRole('button', { name: 'Open the Update' }).click();
  await expect(line.getByTestId('update-line-status')).toHaveText('Dismissed');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Full view draws the same thread in the Ares Section: the line it is about, and the card, there too.
  await aresPanel.getByRole('button', { name: 'Full view' }).click();
  const full = page
    .getByTestId('section-ares')
    .getByTestId('conversations')
    .getByTestId('conversation-thread');
  await expect(full.getByTestId('conversation-about-line-status')).toHaveText('You dismissed it');
  await expect(full.getByTestId('conversation-line-action')).toHaveAttribute('data-status', 'confirmed');

  // Nothing said about the line became Memory: no call to remember, and What Ares knows is empty.
  expect(rememberCalls()).toHaveLength(0);
  const known = await page.evaluate(() => window.commander.itemStore({ op: 'memories', query: {} }));
  expect(known.memories).toEqual([]);
  expect(google.gmail.sent).toEqual([]);
});
