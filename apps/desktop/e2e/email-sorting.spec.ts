import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares sorts email, end to end (#141), against a fake Google and Gmail and a fake OpenAI-compatible
// server standing in for Z.ai (never the real ones). Commander asks once before the Gmail Account's
// mail goes to the model; allowed, Ares sorts the mail he is sure of (a Stripe receipt into Receipts)
// and leaves his dashed suggestion on the one he isn't (Acme's newsletter, which he takes for a
// receipt). The User changes it to Newsletters; more of Acme's newsletters arrive, and each time the
// User changes his guess the same way. Five answers alike: the Update asks "Always put mail from
// news@acme.test in Newsletters?"; accepting opens the Bucket Rule, filled in, which goes at the top
// and offers to re-sort the newsletter Ares sorted wrongly on his own. Every call shows on the Usage
// page under "Sort into Buckets". Tokens and the model's key go in the real keyring, so this needs
// the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const HOUR = 3_600_000;
const ACME = 'Acme <news@acme.test>';

// The fake model: "Sort into Buckets" is sure of the Stripe receipt and of Acme's sixth newsletter
// (both wrongly for Acme), and unsure that Acme's other newsletters are receipts. Every other job gets
// nothing to do; the Update keeps its plain sentences.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  if (system.includes('look for a Bucket they are missing'))
    return { json: chatCompletion('{"bucket":null}') };
  if (system.includes('You sort the User')) {
    const [, subject = ''] = /┆ Subject: (.*)/.exec(prompt) ?? [];
    const reply = subject.includes('Stripe')
      ? { bucket: 'Receipts', confidence: 0.95, reason: 'A Stripe receipt' }
      : subject.includes('#6')
        ? { bucket: 'Receipts', confidence: 0.95, reason: 'Looks like a receipt' }
        : { bucket: 'Receipts', confidence: 0.55, reason: 'Might be a receipt' };
    return { json: chatCompletion(JSON.stringify({ ...reply, steering: [] })) };
  }
  if (system.includes('You file the User')) return { json: chatCompletion('{"filings":[]}') };
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  await settingsPage(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-email-sorting-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

// The system browser, as far as sign-in is concerned: follows Google's consent page (which the fake
// approves at once) back to Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

const row = (section: Locator, subject: string) =>
  section.getByTestId('email-thread').filter({ has: section.page().getByText(subject, { exact: true }) });
const bucketOf = (section: Locator, subject: string) => row(section, subject).locator('[data-slot="bucket"]');

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

function newsletter(n: number, at: number) {
  google.gmail.deliver(ALEX.email, {
    from: ACME,
    to: ALEX.email,
    subject: `Acme weekly #${n}`,
    text: `This week at Acme, issue ${n}. Unsubscribe any time.`,
    date: at,
    labels: ['INBOX', 'UNREAD'],
  });
}

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  google = await startFakeGoogle();
  const now = Date.now();
  google.gmail.deliver(ALEX.email, {
    from: 'Stripe <receipts@stripe.com>',
    to: ALEX.email,
    subject: 'Your Stripe receipt',
    text: 'Receipt for your payment of $20.00.',
    date: now - 2 * HOUR,
    labels: ['INBOX', 'UNREAD'],
  });
  newsletter(1, now - HOUR);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await server?.close();
});

function environment() {
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    gmailUrl: google.gmailUrl,
  };
  return { COMMANDER_TEST_GOOGLE: JSON.stringify(config) };
}

test('consent → one sorted, one Unsorted with a suggestion → Change → again → a Bucket Rule from the Update', async () => {
  test.setTimeout(180_000);
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);

  await openSettings(window, 'Accounts');
  await connectFakeModel(window, server);
  await settingsPage(window, 'Accounts');
  const googleSource = window.getByTestId('accounts-panel').getByTestId('source-google');
  await googleSource.getByRole('button', { name: 'Connect Google' }).click();
  await expect(googleSource.getByTestId('account-synced')).toHaveText(/· 2 emails$/);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');

  // Asked once, naming the model's company; nothing has gone to the model yet.
  const question = section.getByRole('region', { name: `Ares and ${ALEX.email}` });
  await expect(question).toContainText(`Let Ares read mail from ${ALEX.email}?`);
  await expect(question).toContainText('Z.ai');
  expect(server.requests.filter((each) => JSON.stringify(each.body).includes('You sort the User'))).toEqual(
    [],
  );
  await question.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(question).toBeHidden();

  // Sure: the receipt in Receipts. Unsure: Acme's newsletter Unsorted, with his dashed suggestion.
  await expect(bucketOf(section, 'Your Stripe receipt')).toHaveText('Receipts', { timeout: 20_000 });
  const first = row(section, 'Acme weekly #1');
  await expect(first.getByRole('img', { name: 'Ares suggests Receipts' })).toBeVisible({ timeout: 20_000 });

  // Change: the Bucket picker; Newsletters, by the User.
  const picker = window.getByRole('dialog', { name: 'Move to a Bucket' });
  const change = async (subject: string) => {
    await row(section, subject).getByRole('button', { name: 'Change the Bucket' }).click();
    await picker.getByRole('option', { name: /Newsletters/ }).click();
    await expect(bucketOf(section, subject)).toHaveText('Newsletters');
  };
  await change('Acme weekly #1');

  // More of Acme's newsletters arrive: each with his (wrong) suggestion, each changed the same way.
  // The sixth he sorts on his own.
  const now = Date.now();
  for (let n = 2; n <= 6; n++) newsletter(n, now - (10 - n) * 60_000);
  await section.getByRole('button', { name: 'Refresh' }).click();
  for (let n = 2; n <= 5; n++) {
    await expect(
      row(section, `Acme weekly #${n}`).getByRole('img', { name: 'Ares suggests Receipts' }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await change(`Acme weekly #${n}`);
  }
  await expect(bucketOf(section, 'Acme weekly #6')).toHaveText('Receipts', { timeout: 20_000 });

  // Five answers alike: the Update asks to make it a Bucket Rule.
  await window.keyboard.press('Escape');
  await window.keyboard.press('u');
  const update = window.getByTestId('update-panel');
  const offer = update
    .getByTestId('update-line')
    .filter({ hasText: 'Always put mail from news@acme.test in Newsletters?' });
  await expect(offer).toContainText('You put 5 emails from news@acme.test in Newsletters.');
  await offer.getByRole('button', { name: 'Make the Rule…' }).click();

  // The Bucket Rule, filled in, at the top; saved, it offers to re-sort the newsletter Ares sorted.
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await expect(editor.getByRole('combobox', { name: 'Sorts into' }).locator('option:checked')).toHaveText(
    'Newsletters',
  );
  await editor.getByRole('button', { name: 'Save Rule' }).click();
  const resort = window.getByRole('dialog', { name: 'Re-sort existing emails' });
  await expect(resort).toContainText('Also re-sort 1 existing email?');
  await expect(resort.getByRole('list', { name: 'Re-sort preview' })).toContainText('Acme weekly #6');
  await resort.getByRole('button', { name: 'Re-sort 1 email' }).click();
  await expect(bucketOf(section, 'Acme weekly #6')).toHaveText('Newsletters');

  // The Rule is first in Settings → Rules, and every call is on the Usage page under its job's name.
  await openSettings(window, 'Projects');
  await expect(window.getByRole('list', { name: 'Rules' }).getByRole('listitem').first()).toContainText(
    'from is news@acme.test',
  );
  await settingsPage(window, 'Ares');
  const usage = window.getByTestId('usage-panel');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  await expect(usage.getByTestId('usage-by-job')).toContainText('Sort into Buckets');
});
