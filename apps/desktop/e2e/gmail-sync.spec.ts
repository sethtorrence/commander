import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Gmail sync end to end, against a fake Google and Gmail on this machine (never the real ones):
// connecting a Google Account downloads its last 30 days of mail, the Email Section lists the inbox
// as threads, a thread opens with its plain-text bodies, and new mail arrives on the next sync.
// Tokens are stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DAY = 86_400_000;
const HOUR = 3_600_000;

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;
let oldMail: string;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  const now = Date.now();
  const question = google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?\n\nDana',
    date: now - 2 * DAY,
    labels: ['INBOX', 'CATEGORY_PERSONAL'],
    messageId: '<offsite-1@mail.northwind.test>',
  });
  google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Re: Q4 offsite dates',
    text: 'Booked the venue for 19–21 Nov.',
    date: now - DAY,
    threadId: question,
    messageId: '<offsite-2@mail.northwind.test>',
    inReplyTo: '<offsite-1@mail.northwind.test>',
    references: '<offsite-1@mail.northwind.test>',
  });
  google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your order has shipped',
    text: 'Your order is on its way.',
    html: '<h1>Your order is on its way.</h1>',
    date: now - 3 * HOUR,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  oldMail = google.gmail.deliver(ALEX.email, {
    from: 'Old Friend <old@friend.test>',
    to: ALEX.email,
    subject: 'Ancient history',
    text: 'From long ago.',
    date: now - 45 * DAY,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
});

function pointAtFakeGoogle() {
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

async function connectGoogle(window: Page) {
  await openSettings(window);
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  return section;
}

const threads = (window: Page) => window.getByTestId('section-email').getByTestId('email-thread');
const subjects = (window: Page) => threads(window).getByTestId('thread-subject');

test('connect Google → first sync → threads listed → open a thread → new mail on the next sync', async () => {
  commander = await launchCommander({ env: pointAtFakeGoogle() });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  const google_ = await connectGoogle(window);

  // The first sync downloads the last 30 days; Settings counts them and offers Email's cadences.
  await expect(google_.getByTestId('account-synced')).toHaveText(/^Synced \d\d:\d\d · 3 emails$/);
  const cadence = google_.getByRole('combobox', { name: /How often to sync/ });
  await expect(cadence).toHaveText('Every 15 min');
  expect(google.gmail.requests.some((path) => path.includes(`/messages/${oldMail}`))).toBe(false);

  // The Email Section: one inbox, as threads, newest first.
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');
  await expect(subjects(window)).toHaveText(['Your order has shipped', 'Re: Q4 offsite dates']);
  const conversation = threads(window).nth(1);
  await expect(conversation.getByTestId('thread-senders')).toHaveText('Dana Whitfield');
  await expect(conversation.getByTestId('thread-count')).toHaveText('2');
  await expect(conversation).toHaveAttribute('data-unread', 'true');
  await expect(section.getByTestId('email-sync-status')).toHaveText(/^Synced \d\d:\d\d$/);
  await expect(tab(window, 'Email')).toContainText('01');

  // The Account switcher narrows to the one Account.
  const switcher = section.getByRole('tablist', { name: 'Account' });
  await switcher.getByRole('tab', { name: ALEX.email }).click();
  await expect(subjects(window)).toHaveText(['Your order has shipped', 'Re: Q4 offsite dates']);

  // A thread opens with each message's headers and plain-text body; the older, read one is collapsed
  // to a line until clicked.
  await conversation.click();
  const reader = section.getByRole('region', { name: 'Thread' });
  await expect(reader.getByTestId('email-message')).toHaveCount(2);
  await reader.getByRole('button', { name: 'Show the message from Dana Whitfield' }).click();
  await expect(reader.getByTestId('email-body')).toHaveText([
    'Which dates work for you for the Q4 offsite?\n\nDana',
    'Booked the venue for 19–21 Nov.',
  ]);
  await expect(reader.getByText('Dana Whitfield <dana@northwind.test>').first()).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // New mail arrives on the next sync (Refresh, as opening the Section does).
  google.gmail.deliver(ALEX.email, {
    from: 'Priya Patel <priya@contoso.test>',
    to: ALEX.email,
    subject: 'Staging certificate',
    text: 'The staging certificate expires on Friday. Can you renew it?',
    date: Date.now(),
  });
  await section.getByRole('button', { name: 'Refresh' }).click();
  await expect(subjects(window)).toHaveText([
    'Staging certificate',
    'Your order has shipped',
    'Re: Q4 offsite dates',
  ]);
  // Opening Dana's thread marked it read (#135), so only the new mail is unread.
  await expect(tab(window, 'Email')).toContainText('01');

  // Ctrl+K finds it by what it says, and opens its thread in the Email Section.
  await window.keyboard.press('Control+k');
  const palette = window.getByTestId('palette');
  await palette.getByRole('combobox', { name: 'Search Commander' }).fill('certificate expires');
  await expect(palette.getByRole('option', { name: /Staging certificate/ })).toBeVisible();
  await window.keyboard.press('Enter');
  await expect(reader.getByTestId('email-body')).toHaveText([
    'The staging certificate expires on Friday. Can you renew it?',
  ]);
});

test('Gmail’s quota answer shows in Settings and in the Email Section', async () => {
  google.gmail.throttle(true);
  commander = await launchCommander({ env: pointAtFakeGoogle() });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  const section = await connectGoogle(window);

  await expect(section.getByTestId('account-sync-problem')).toHaveText('Gmail asked Commander to slow down.');
  await expect(section.getByTestId('account-next-sync')).toHaveText(/^Trying again at /);

  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  await expect(window.getByTestId('email-sync-status')).toHaveText('Gmail asked Commander to slow down.');
});
