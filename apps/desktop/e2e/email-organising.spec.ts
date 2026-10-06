import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Organising mail end to end (#135), against a fake Google and Gmail on this machine (never the real
// ones): archive, undo, a label and a snooze from the keyboard, written back to Gmail (snooze stays
// in Commander); the snoozed thread comes back when its time comes; Section search with Gmail's own
// search at the end; Trash and Move to inbox; changes made offline going out on reconnect; and
// Couldn't sync with Retry. Tokens are stored in the real keyring, so these need the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DAY = 86_400_000;
const HOUR = 3_600_000;

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;
let ids: { offsite: string; offsiteReply: string; receipt: string; certificate: string };

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  const now = Date.now();
  const offsite = google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: now - 2 * DAY,
    labels: ['INBOX', 'CATEGORY_PERSONAL'],
    messageId: '<offsite-1@mail.northwind.test>',
  });
  const offsiteReply = google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Re: Q4 offsite dates',
    text: 'Booked the venue for 19–21 Nov.',
    date: now - DAY,
    threadId: offsite,
    labels: ['INBOX', 'CATEGORY_PERSONAL'],
    messageId: '<offsite-2@mail.northwind.test>',
    inReplyTo: '<offsite-1@mail.northwind.test>',
    references: '<offsite-1@mail.northwind.test>',
  });
  const receipt = google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your order has shipped',
    text: 'Your order is on its way.',
    date: now - 3 * HOUR,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  const certificate = google.gmail.deliver(ALEX.email, {
    from: 'Priya Patel <priya@contoso.test>',
    to: ALEX.email,
    subject: 'Staging certificate',
    text: 'The staging certificate expires on Friday. Can you renew it?',
    date: now - HOUR,
  });
  ids = { offsite, offsiteReply, receipt, certificate };
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
  return { COMMANDER_TEST_GOOGLE: JSON.stringify(config), COMMANDER_TEST_HOOKS: '1' };
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

async function openEmail(window: Page) {
  await openSettings(window, 'Accounts');
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect(section.getByTestId('account-synced')).toHaveText(/· 4 emails$/);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  return window.getByTestId('section-email');
}

const subjects = (section: Locator) => section.getByTestId('email-thread').getByTestId('thread-subject');
const row = (section: Locator, subject: string) =>
  section.getByTestId('email-thread').filter({ has: section.page().getByText(subject, { exact: true }) });
const view = (section: Locator, name: RegExp) =>
  section.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
const labelsOf = (id: string) => () => google.gmail.labelsOf(ALEX.email, id) ?? [];
const toastSaying = (window: Page, text: string) =>
  window.locator('[data-sonner-toast]').filter({ hasText: text });

// New Daily Notes start empty (no template Blocks).
const emptyTemplate = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }));

async function setOnline(app: ElectronApplication, page: Page, online: boolean) {
  await app.evaluate((_electron, value) => {
    (
      globalThis as unknown as { commanderTestHooks: { setOnline(online: boolean): void } }
    ).commanderTestHooks.setOnline(value);
  }, online);
  const activity = () =>
    page.evaluate(async () => {
      const { state } = await window.commander.accounts({ op: 'list' });
      return state.accounts[0]?.sync?.activity ?? null;
    });
  if (!online) await expect.poll(activity).toBe('offline');
  else await expect.poll(activity).not.toBe('offline');
}

test('archive → undo → label → snooze → return → search, written back to Gmail', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  const section = await openEmail(window);
  await expect(subjects(section)).toHaveText([
    'Staging certificate',
    'Your order has shipped',
    'Re: Q4 offsite dates',
  ]);

  // Archive (e): the thread leaves the inbox at once, and INBOX comes off in Gmail.
  await window.keyboard.press('j');
  await window.keyboard.press('e');
  await expect(subjects(section)).toHaveText(['Staging certificate', 'Re: Q4 offsite dates']);
  await expect.poll(labelsOf(ids.receipt)).not.toContain('INBOX');

  // Undo from the toast: back in the inbox, and in Gmail.
  await toastSaying(window, 'Archived: Your order has shipped').getByRole('button', { name: 'Undo' }).click();
  await expect(subjects(section)).toHaveText([
    'Staging certificate',
    'Your order has shipped',
    'Re: Q4 offsite dates',
  ]);
  await expect.poll(labelsOf(ids.receipt)).toContain('INBOX');

  // A label (l), from the Account's Gmail labels.
  await row(section, 'Your order has shipped').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('l');
  const labels = window.getByRole('dialog', { name: 'Labels' });
  await labels.getByRole('checkbox', { name: 'Receipts' }).check();
  await expect(row(section, 'Your order has shipped').getByText('Receipts', { exact: true })).toBeVisible();
  await expect.poll(labelsOf(ids.receipt)).toContain('Label_1');
  await window.keyboard.press('Escape');
  await expect(labels).toHaveCount(0);

  // Snooze (z): out of the inbox into Snoozed. Gmail hears nothing of it.
  const writesBefore = google.gmail.writes.length;
  await row(section, 'Re: Q4 offsite dates').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('z');
  const snooze = window.getByRole('dialog', { name: 'Snooze until' });
  await expect(snooze).toContainText(
    'Snoozed mail comes back only while Commander is running (the window or the tray).',
  );
  await snooze.getByRole('button', { name: /Tomorrow morning/ }).click();
  await expect(subjects(section)).toHaveText(['Staging certificate', 'Your order has shipped']);
  await view(section, /^Snoozed/).click();
  await expect(subjects(section)).toHaveText(['Re: Q4 offsite dates']);
  await expect(row(section, 'Re: Q4 offsite dates')).toContainText(/Until \w{3} 08:00/);
  expect(google.gmail.writes.slice(writesBefore)).toEqual([]);

  // Its time comes (the Core's snooze clock moved on two days): back at the top of the inbox, unread,
  // marked as back from its snooze; marking it unread reaches Gmail.
  await commander.app.evaluate(() => {
    (
      globalThis as unknown as { commanderTestHooks: { moveSnoozeClock(ms: number): void } }
    ).commanderTestHooks.moveSnoozeClock(2 * 86_400_000);
  });
  await view(section, /^Inbox/).click();
  await expect(subjects(section).first()).toHaveText('Re: Q4 offsite dates');
  const back = row(section, 'Re: Q4 offsite dates');
  await expect(back).toHaveAttribute('data-unread', 'true');
  await expect(back).toContainText(/Snoozed until (\w{3} )?08:00/);
  await expect.poll(labelsOf(ids.offsiteReply)).toContain('UNREAD');

  // Section search (/) with an operator, ending with Gmail's own search for the same words.
  await window.keyboard.press('/');
  const box = section.getByRole('searchbox', { name: 'Search mail' });
  await box.fill('from:priya');
  await box.press('Enter');
  await expect(subjects(section)).toHaveText(['Staging certificate']);
  await expect(section.getByRole('link', { name: /Search in Gmail/ })).toHaveAttribute(
    'href',
    `https://mail.google.com/mail/?authuser=${encodeURIComponent(ALEX.email)}#search/from%3Apriya`,
  );
  await box.press('Escape');
  await expect(subjects(section)).toHaveCount(3);

  // The keys are listed in ?.
  await window.keyboard.press('?');
  const sheet = window.getByTestId('cheat-sheet').getByRole('region', { name: 'Email' });
  for (const label of [
    'Archive (or move back to the inbox)',
    'Move to Trash',
    'Star or unstar',
    'Mark read',
    'Mark unread',
    'Labels',
    'Snooze',
  ])
    await expect(sheet.getByText(label, { exact: true })).toBeVisible();
});

test('[[ finds an email by subject and shows it as a live card that opens the thread', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  const email = await openEmail(window);
  await expect(subjects(email)).toHaveCount(3);

  // Today's Daily Note, without the template's Blocks.
  await emptyTemplate(window);
  await tab(window, 'Notes').click();
  const today = await window.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });
  const sheet = window.locator(`#day-${today}`);
  await expect(sheet).toBeVisible();

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Renew [[staging');
  const picker = window.getByRole('listbox', { name: 'Link to' });
  await expect(picker.getByRole('group', { name: 'Emails' })).toContainText('Staging certificate');
  await window.keyboard.press('Enter');
  const card = sheet.getByRole('link', { name: /Email from Priya Patel: Staging certificate/ });
  await expect(card).toBeVisible();

  await card.click();
  await expect(
    email.getByRole('region', { name: 'Thread' }).getByRole('heading', { name: 'Staging certificate' }),
  ).toBeVisible();
});

test('Trash and Move to inbox, offline changes going out on reconnect, and Couldn’t sync with Retry', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  const section = await openEmail(window);
  await expect(subjects(section)).toHaveCount(3);

  // Offline, the receipt goes to Trash at once; Gmail hears of it once Commander is back online.
  await setOnline(commander.app, window, false);
  await row(section, 'Your order has shipped').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('#');
  await expect(subjects(section)).toHaveText(['Staging certificate', 'Re: Q4 offsite dates']);
  await window.waitForTimeout(1500);
  expect(labelsOf(ids.receipt)()).not.toContain('TRASH');
  await setOnline(commander.app, window, true);
  await expect.poll(labelsOf(ids.receipt)).toContain('TRASH');

  // Trash lists it; Move to inbox brings it back (there is no way to delete for good).
  await view(section, /^Trash/).click();
  await expect(subjects(section)).toHaveText(['Your order has shipped']);
  await row(section, 'Your order has shipped').click();
  const reader = section.getByRole('region', { name: 'Thread' });
  await expect(reader.getByRole('button', { name: /delete/i })).toHaveCount(0);
  await reader.getByRole('button', { name: /Move to inbox/ }).click();
  await expect(subjects(section)).toHaveCount(0);
  await expect.poll(labelsOf(ids.receipt)).not.toContain('TRASH');
  await view(section, /^Inbox/).click();
  await expect(subjects(section)).toHaveCount(3);

  // Gmail refuses a change: Couldn't sync, with Retry, which sends it again.
  google.gmail.refuseWrites(true);
  await row(section, 'Staging certificate').click();
  await window.keyboard.press('s');
  const opened = section.getByRole('region', { name: 'Thread' });
  await expect(opened.getByText(/Couldn’t sync/)).toBeVisible();
  google.gmail.refuseWrites(false);
  await opened.getByRole('button', { name: 'Retry' }).click();
  await expect(opened.getByText(/Couldn’t sync/)).toHaveCount(0);
  await expect.poll(labelsOf(ids.certificate)).toContain('STARRED');
});
