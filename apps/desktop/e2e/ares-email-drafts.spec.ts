import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares drafts replies in the User's own style, end to end (#143), against a fake Google and Gmail and a
// fake OpenAI-compatible server standing in for Z.ai (never the real ones). Allowed to read the Gmail
// Account's mail, Ares learns how Alex writes from his sent mail (What Ares knows shows it) and sorts
// Dana's question into Needs reply; at Auto when sure (the default) her thread then has his suggested
// reply waiting at its end, and nothing has reached Gmail. Open in composer makes it an ordinary draft
// (saved to Gmail's Drafts, with Alex's signature and the reply's threading); Alex edits it and presses
// Send himself, and it goes once the Undo time is up. Every drafting call shows on the Usage page under
// "Draft replies". Tokens and the model's key go in the real keyring, so this needs the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const DAY = 86_400_000;
const DANA = 'Dana Whitfield <dana@northwind.test>';
const STYLE = 'Short and friendly; opens with "Hi <name>," and signs off "Cheers, Alex".';
const DRAFT = 'Hi Dana,\n\nThursday works for me.\n\nCheers,\nAlex';

// The fake model: Dana's question is plainly Needs reply; the style and the draft come back as recorded.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  if (system.includes('You learn how the User writes email'))
    return { json: chatCompletion(JSON.stringify({ style: STYLE, steering: [] })) };
  if (system.includes('You draft the User'))
    return { json: chatCompletion(JSON.stringify({ body: DRAFT, confidence: 0.9, steering: [] })) };
  if (system.includes('You sort the User')) {
    const reply = prompt.includes('Q4 offsite')
      ? { bucket: 'Needs reply', confidence: 0.95, reason: 'Dana asks which dates work' }
      : { bucket: 'unsorted', confidence: 0.2 };
    return { json: chatCompletion(JSON.stringify({ ...reply, steering: [] })) };
  }
  if (system.includes('look for a Bucket they are missing'))
    return { json: chatCompletion('{"bucket":null}') };
  if (system.includes('You file the User')) return { json: chatCompletion('{"filings":[]}') };
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

const draftingCalls = (server: FakeOpenAIServer) =>
  server.requests.filter((each) => JSON.stringify(each.body).includes('You draft the User'));

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  await settingsPage(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-email-drafts-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

// The Account's signature, and every send held 5 seconds.
async function signatureAndUndo(page: Page, account: string) {
  await page.evaluate(async (id) => {
    await window.commander.compose({
      op: 'save-signature',
      account: id,
      body: [{ type: 'paragraph', runs: [{ text: 'Alex Kim · Acme' }] }],
    });
    await window.commander.compose({
      op: 'save-settings',
      settings: { defaultAccount: null, undoSeconds: 5 },
    });
  }, account);
}

type Part = { type: string; body: Buffer; parts: Part[] };
const plainText = (part: Part | undefined): string =>
  !part
    ? ''
    : part.type === 'text/plain'
      ? part.body.toString('utf8')
      : part.parts.map((each) => plainText(each)).join('');

const reader = (section: Locator) => section.getByRole('region', { name: 'Thread' });

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  google = await startFakeGoogle();
  const now = Date.now();
  // Alex's own sent mail: how he writes.
  for (const [n, to] of ['dana@northwind.test', 'lee@acme.test', 'sam@acme.test'].entries()) {
    google.gmail.deliver(ALEX.email, {
      from: `Alex Kim <${ALEX.email}>`,
      to,
      subject: `Notes ${n + 1}`,
      text: `Hi there,\n\nNotes number ${n + 1} attached below.\n\nCheers,\nAlex`,
      date: now - (n + 2) * DAY,
      labels: ['SENT'],
    });
  }
  google.gmail.deliver(ALEX.email, {
    from: DANA,
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: now - 60 * 60_000,
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

test('a Needs reply thread → Suggested reply → Open in composer → edit → the User sends it', async () => {
  test.setTimeout(180_000);
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    gmailUrl: google.gmailUrl,
  };
  commander = await launchCommander({ env: { COMMANDER_TEST_GOOGLE: JSON.stringify(config) } });
  const window = await commander.window();
  await commander.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });

  await openSettings(window, 'Accounts');
  await connectFakeModel(window, server);
  await settingsPage(window, 'Accounts');
  const googleSource = window.getByTestId('accounts-panel').getByTestId('source-google');
  await googleSource.getByRole('button', { name: 'Connect Google' }).click();
  await expect(googleSource.getByTestId('account-synced')).toHaveText(/· 4 emails$/);
  // Alex's signature, and a short Undo time.
  await signatureAndUndo(window, `google:${ALEX.sub}`);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');

  // Nothing of Alex's mail goes to the model until he allows it.
  const question = section.getByRole('region', { name: `Ares and ${ALEX.email}` });
  await expect(question).toContainText('draft your replies');
  expect(draftingCalls(server)).toEqual([]);
  await question.getByRole('button', { name: 'Allow', exact: true }).click();

  // Ares sorts Dana's question into Needs reply, then drafts a reply in Alex's style.
  const row = section.getByTestId('email-thread').filter({ hasText: 'Q4 offsite dates' });
  await expect(row.locator('[data-slot="bucket"]')).toHaveText('Needs reply', { timeout: 30_000 });
  await row.click();
  const card = reader(section).getByRole('region', { name: 'Suggested reply' });
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(card.getByTestId('suggested-reply-body')).toContainText('Thursday works for me.');
  await expect(card).toContainText('Sent only when you press Send');
  // Nothing has reached Gmail.
  expect(google.gmail.drafts(ALEX.email)).toEqual([]);
  expect(google.gmail.sent).toEqual([]);

  // Once Ares has learned Alex's style from his sent mail, Draft again writes with it.
  await expect
    .poll(
      () => server.requests.some((each) => JSON.stringify(each.body).includes('You learn how the User')),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  await expect.poll(() => draftingCalls(server).length).toBe(1);
  await card.getByRole('button', { name: 'Draft again' }).click();
  await expect.poll(() => draftingCalls(server).length, { timeout: 30_000 }).toBe(2);
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  expect(JSON.stringify(draftingCalls(server)[1]?.body)).toContain('How the User writes');
  expect(JSON.stringify(draftingCalls(server)[1]?.body)).toContain('signs off');

  // Open in composer: an ordinary draft, from Alex, with his signature, saved to Gmail's Drafts.
  await card.getByRole('button', { name: 'Open in composer' }).click();
  const composer = section.getByRole('region', { name: 'Reply' });
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId('compose-from')).toHaveText(`Alex Kim <${ALEX.email}>`);
  await expect(composer.getByTestId('compose-body')).toContainText('Thursday works for me.');
  await expect(composer.getByTestId('compose-body')).toContainText('Alex Kim · Acme');
  await expect(card).toHaveCount(0);
  await expect.poll(() => google.gmail.drafts(ALEX.email).length, { timeout: 30_000 }).toBe(1);

  // Alex edits it, and sends it himself.
  await composer.getByTestId('compose-body').click();
  await window.keyboard.press('Control+Home');
  await window.keyboard.type('Thanks for organising! ');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect.poll(() => google.gmail.sent.length, { timeout: 30_000 }).toBe(1);
  const [sent] = google.gmail.sent;
  const header = (name: string) => sent?.mime.headers.find((each) => each.name.toLowerCase() === name)?.value;
  expect(header('in-reply-to')).toBe('<offsite-1@mail.northwind.test>');
  expect(header('subject')).toBe('Re: Q4 offsite dates');
  const text = plainText(sent?.mime as Part);
  expect(text).toContain('Thanks for organising! Hi Dana,');
  expect(text).toContain('Thursday works for me.');
  expect(text).toContain('Alex Kim · Acme');
  // Two drafting calls (the second asked for), on the Usage page under "Draft replies".
  expect(draftingCalls(server)).toHaveLength(2);

  await openSettings(window, 'Ares');
  const usage = window.getByTestId('usage-panel');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  await expect(usage.getByTestId('usage-by-job')).toContainText('Draft replies');

  // What Ares knows shows the style he learned, the User's own (confirmed).
  await window.getByTestId('open-what-ares-knows').click();
  const known = window.getByTestId('what-ares-knows');
  const style = known.getByRole('list', { name: 'Preferences' }).getByTestId('memory');
  await expect(style).toContainText(`Writing style for ${ALEX.email}: ${STYLE}`);
  await expect(style).not.toContainText('Unconfirmed');
});
