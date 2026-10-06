import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The Ares button (#193), end to end, against a fake Google and Gmail and a fake OpenAI-compatible
// server standing in for Z.ai (never the real ones). From the open email thread, the Ares button opens
// a pop-up beside it; asked what it's about, Ares answers from the email, which reached him as
// outside material in a block of its own, and Esc closes the pop-up. From a Todo, `a` opens it; Ares
// answers from the Todo, the User's own words, and Open in Ares carries the same Conversation on in
// the Ares Section, where both are saved and listed. A Daily Note line has its button too, and `a`
// once the User leaves the text. Tokens and the model's key go in the real keyring, so this needs the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const DANA = 'Dana Whitfield <dana@northwind.test>';
const OFFSITE = /ref="I1" label="I1 · Email · Q4 offsite dates" source="outside">/;
const FLIGHTS = /ref="I1" label="I1 · Todo · Book flights for the offsite" source="the User">/;

type Message = { role: string; content: string };

// The fake model. In a Conversation about an Item, the Item is the last message's data block: he
// answers about the one he was handed. Every other job of Ares's gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  if (!system.startsWith('You are Ares. You work inside Commander')) {
    if (system.includes('You learn how the User writes email'))
      return { json: chatCompletion('{"style":null,"steering":[]}') };
    if (system.includes('You sort the User'))
      return { json: chatCompletion('{"bucket":"unsorted","confidence":0.2,"steering":[]}') };
    if (system.includes('look for a Bucket they are missing'))
      return { json: chatCompletion('{"bucket":null}') };
    if (system.includes('You file the User')) return { json: chatCompletion('{"filings":[]}') };
    if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
    if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
    return { json: chatCompletion('{"todos":[]}') };
  }
  const material = messages.at(-1)?.content ?? '';
  const stream = (text: string): FakeReply => ({
    sse: streamedCompletion(text.match(/[\s\S]{1,10}/g) ?? [], { prompt: 400, completion: 30 }),
    sseEveryMs: 20,
  });
  if (OFFSITE.test(material))
    return stream('[their-data]\nDana asks which dates work for the Q4 offsite [I1].');
  if (FLIGHTS.test(material)) return stream('[their-data]\nIt’s yours: compare fares before Friday [I1].');
  return stream('[chat]\nHello.');
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
    subject: 'Q4 offsite dates',
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

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(page: Page) {
  await settingsPage(page, 'Ares');
  const ares = page.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await page.getByTestId('model-settings-save').click();
  await expect(page.getByTestId('model-settings-saved')).toBeVisible();
  await page.getByTestId('model-key-input').fill('zai-e2e-ares-button-key');
  await page.getByTestId('model-key-save').click();
  await expect(page.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

const conversationCalls = () =>
  server.requests.filter((request) =>
    ((request.body.messages as Message[] | undefined)?.[0]?.content ?? '').startsWith(
      'You are Ares. You work',
    ),
  );

test('the Ares button on an email and a Todo opens a pop-up Conversation about it, which expands into the Ares Section', async () => {
  test.setTimeout(150_000);
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    gmailUrl: google.gmailUrl,
  };
  commander = await launchCommander({
    env: { COMMANDER_TEST_GOOGLE: JSON.stringify(config), COMMANDER_TEST_MODEL_IN_CLOUD: '1' },
  });
  const page = await commander.window();
  await commander.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });

  await openSettings(page, 'Accounts');
  await connectFakeModel(page);
  await settingsPage(page, 'Accounts');
  const googleSource = page.getByTestId('accounts-panel').getByTestId('source-google');
  await googleSource.getByRole('button', { name: 'Connect Google' }).click();
  await expect(googleSource.getByTestId('account-synced')).toHaveText(/· 1 email$/);
  await page.keyboard.press('Escape');

  // The email: Alex lets Ares read his mail, opens Dana's thread, and presses its Ares button.
  await tab(page, 'Email').click();
  const email = page.getByTestId('section-email');
  await email
    .getByRole('region', { name: `Ares and ${ALEX.email}` })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();
  const row = email.getByTestId('email-thread').filter({ hasText: 'Q4 offsite dates' });
  // On the row too.
  await expect(row.getByRole('button', { name: 'Ask Ares about Q4 offsite dates' })).toBeVisible();
  await row.click();
  const thread = email.getByRole('region', { name: 'Thread' });
  await thread.getByRole('button', { name: 'Ask Ares about Q4 offsite dates' }).click();

  const popup = page.getByTestId('ares-popup');
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId('ares-popup-about')).toHaveText('EMLQ4 offsite dates');
  await popup.getByRole('button', { name: 'What’s this about?' }).click();
  const answer = popup.getByTestId('conversation-turn').nth(1);
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(answer.getByTestId('ares-answer')).toHaveText(
    'Dana asks which dates work for the Q4 offsite Q4 offsite dates.',
  );
  // The email reached him as outside material, in a block of its own, after the User's question.
  const asked = conversationCalls().at(-1)?.body as { messages: Message[] };
  expect(asked.messages.at(-2)).toEqual({ role: 'user', content: 'What’s this about?' });
  expect(asked.messages.at(-1)?.content).toMatch(OFFSITE);
  expect(asked.messages.at(-1)?.content).toContain('Which dates work for you for the Q4 offsite?');
  // Esc closes it; the thread stays open behind it.
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(thread).toBeVisible();

  // The Todo: selected in the Todos Section, `a` opens the pop-up on it.
  await page.evaluate(() =>
    window.commander.itemStore({
      op: 'record',
      action: {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Book flights for the offsite',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
    }),
  );
  await tab(page, 'Todos').click();
  const todos = page.getByTestId('section-todos');
  const todo = todos.getByRole('listitem').filter({ hasText: 'Book flights for the offsite' });
  await todo.click();
  await expect(todo).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('a');
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId('ares-popup-about')).toHaveText('TDOBook flights for the offsite');
  const input = popup.getByRole('textbox', { name: 'Message Ares' });
  await input.fill('What should I do first?');
  await input.press('Enter');
  const reply = popup.getByTestId('conversation-turn').nth(1);
  await expect(reply).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(reply.getByTestId('ares-answer')).toHaveText(
    'It’s yours: compare fares before Friday Book flights for the offsite.',
  );
  // The Todo the User wrote went in as their own material.
  const second = conversationCalls().at(-1)?.body as { messages: Message[] };
  expect(second.messages.at(-1)?.content).toMatch(FLIGHTS);

  // Open in Ares: the same Conversation carries on in the Ares Section; both are saved and listed.
  await popup.getByRole('button', { name: 'Open in Ares' }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByTestId('header-title')).toHaveText('Ares');
  const conversations = page.getByTestId('section-ares').getByTestId('conversations');
  const shown = conversations.getByTestId('conversation-thread');
  await expect(shown.getByRole('heading', { name: 'Book flights for the offsite' })).toBeInViewport();
  await expect(shown.getByTestId('conversation-about')).toHaveText('AboutTDOBook flights for the offsite');
  await expect(shown.getByTestId('ares-answer')).toHaveText(
    'It’s yours: compare fares before Friday Book flights for the offsite.',
  );
  const list = conversations.getByTestId('conversation-list');
  await expect(list.getByRole('listitem', { name: 'Book flights for the offsite' })).toBeVisible();
  await expect(list.getByRole('listitem', { name: 'Q4 offsite dates' })).toBeVisible();
  // It carries on there: he still has the Todo in front of him.
  const there = shown.getByRole('textbox', { name: 'Message Ares' });
  await there.fill('And after that?');
  await there.press('Enter');
  await expect(shown.getByTestId('conversation-turn').nth(3)).toHaveAttribute('data-status', 'done', {
    timeout: 20_000,
  });
  const third = conversationCalls().at(-1)?.body as { messages: Message[] };
  expect(third.messages.at(-1)?.content).toMatch(FLIGHTS);

  // A Daily Note line: its Ares button shows on the row pointed at, and `a`, once the User has left
  // the text, asks about the line they were writing.
  await tab(page, 'Notes').click();
  const notes = page.getByTestId('section-notes');
  // A new line after the last of today's (the Daily template's).
  await notes.locator('.n-day.today [data-block-text]').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Call Dana about the offsite');
  await expect
    .poll(async () =>
      (
        await page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['block'] } }))
      ).map((each) => each.title),
    )
    .toContain('Call Dana about the offsite');
  const line = notes.locator('.n-row', {
    has: page.locator('[data-block-text]', { hasText: /^Call Dana about the offsite$/ }),
  });
  await line.hover();
  await expect(
    line.getByRole('button', { name: 'Ask Ares about Call Dana about the offsite' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('a');
  await expect(popup.getByTestId('ares-popup-about')).toHaveText('DNCall Dana about the offsite');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
});
