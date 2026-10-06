import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Buckets end to end (#137), against a fake Google and Gmail on this machine (never the real ones):
// mail arrives Unsorted; `v` moves a receipt to Receipts by hand; a Bucket Rule made in Settings
// offers to re-sort the mail it matches, with a preview that leaves out the hand-sorted one; accepting
// it sorts them, and new mail from the same sender arrives sorted; a thread moved to Needs reply shows
// in Today on the Dashboard. Tokens are stored in the real keyring, so these need the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const HOUR = 3_600_000;

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  const now = Date.now();
  google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your order has shipped',
    text: 'Your order is on its way.',
    date: now - 3 * HOUR,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your refund is on its way',
    text: 'We have refunded your order.',
    date: now - 2 * HOUR,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  google.gmail.deliver(ALEX.email, {
    from: 'Priya Patel <priya@contoso.test>',
    to: ALEX.email,
    subject: 'Staging certificate',
    text: 'The staging certificate expires on Friday. Can you renew it?',
    date: now - HOUR,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
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

// The system browser, as far as sign-in is concerned: follows Google's consent page (which the fake
// approves at once) back to Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

const subjects = (section: Locator) => section.getByTestId('email-thread').getByTestId('thread-subject');
const row = (section: Locator, subject: string) =>
  section.getByTestId('email-thread').filter({ has: section.page().getByText(subject, { exact: true }) });
const bucketOf = (section: Locator, subject: string) => row(section, subject).locator('[data-slot="bucket"]');
const strip = (section: Locator) => section.getByRole('tablist', { name: 'Bucket' });
const toastSaying = (window: Page, text: string | RegExp) =>
  window.locator('[data-sonner-toast]').filter({ hasText: text });

test('mail arrives Unsorted → v to Receipts → a Bucket Rule → re-sort preview → accept → Needs reply on the Dashboard', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);

  await openSettings(window);
  const google_ = window.getByTestId('accounts-panel').getByTestId('source-google');
  await google_.getByRole('button', { name: 'Connect Google' }).click();
  await expect(google_.getByTestId('account-synced')).toHaveText(/· 3 emails$/);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');

  // Everything arrives Unsorted.
  await expect(subjects(section)).toHaveText([
    'Staging certificate',
    'Your refund is on its way',
    'Your order has shipped',
  ]);
  await expect(bucketOf(section, 'Your order has shipped')).toHaveText('Unsorted');
  await expect(strip(section).getByRole('tab', { name: /^Unsorted/ })).toHaveText('Unsorted3');

  // v moves the receipt to Receipts, by hand.
  await row(section, 'Your order has shipped').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('v');
  const picker = window.getByRole('dialog', { name: 'Move to a Bucket' });
  await picker.getByRole('option', { name: /Receipts/ }).click();
  await expect(bucketOf(section, 'Your order has shipped')).toHaveText('Receipts');
  await expect(toastSaying(window, 'Moved to Receipts: Your order has shipped')).toBeVisible();
  await expect(strip(section).getByRole('tab', { name: /^Receipts/ })).toHaveText('Receipts1');

  // Settings → Rules: from domain is shop.test → Receipts.
  await openSettings(window);
  await window.getByRole('button', { name: 'New Rule', exact: true }).click();
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await editor.getByRole('combobox', { name: 'Target' }).selectOption({ label: 'A Bucket (email)' });
  await editor.getByRole('combobox', { name: 'Sorts into' }).selectOption({ label: 'Receipts' });
  await expect(
    editor.getByRole('combobox', { name: 'Value 1' }).getByRole('option', { name: 'shop.test' }),
  ).toBeAttached();
  await editor.getByRole('combobox', { name: 'Value 1' }).selectOption({ label: 'shop.test' });
  await expect(editor.getByRole('region', { name: 'Matching Items' })).toContainText('Matches 2 Items');
  await editor.getByRole('button', { name: 'Save Rule' }).click();

  // "Also re-sort 1 existing email?": the receipt sorted by hand is left out.
  const offer = window.getByRole('dialog', { name: 'Re-sort existing emails' });
  await expect(offer).toContainText('Also re-sort 1 existing email?');
  await expect(offer.getByRole('list', { name: 'Re-sort preview' }).getByRole('listitem')).toHaveText([
    'Your refund is on its wayUnsorted→Receipts',
  ]);
  await offer.getByRole('button', { name: 'Re-sort 1 email' }).click();
  await expect(toastSaying(window, 'Re-sorted 1 email')).toBeVisible();
  await expect(window.getByRole('list', { name: 'Rules' }).getByRole('listitem')).toHaveText([
    /from domain is shop\.test.*Receipts/,
  ]);

  // In the Email Section: both receipts in Receipts.
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  await strip(section)
    .getByRole('tab', { name: /^Receipts/ })
    .click();
  await expect(subjects(section)).toHaveText(['Your refund is on its way', 'Your order has shipped']);

  // New mail from the shop arrives sorted by the Rule.
  google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your invoice',
    text: 'Your invoice is attached.',
    date: Date.now(),
    labels: ['INBOX', 'UNREAD'],
  });
  await section.getByRole('button', { name: 'Refresh' }).click();
  await expect(subjects(section)).toHaveText([
    'Your invoice',
    'Your refund is on its way',
    'Your order has shipped',
  ]);

  // The certificate goes to Needs reply (its number in the picker), and shows in Today.
  await strip(section).getByRole('tab', { name: /^All/ }).click();
  await row(section, 'Staging certificate').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('v');
  await expect(picker).toBeVisible();
  await window.keyboard.press('1');
  await expect(bucketOf(section, 'Staging certificate')).toHaveText('Needs reply');

  await tab(window, 'Dashboard').click();
  const today = window.getByTestId('section-dashboard').getByRole('region', { name: 'Today' });
  const certificate = today.getByTestId('dashboard-row').filter({ hasText: 'Staging certificate' });
  await expect(certificate).toBeVisible();
  await expect(certificate.getByTestId('row-reason')).toHaveText(
    // A time today, or "yesterday" when the run is just after midnight (her email is hours old).
    /^Priya’s waiting on your reply since (\d\d:\d\d|yesterday)$/,
  );
});
