import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// Writing email end to end (#138), against a fake Google (Gmail) and a fake Microsoft (Graph) on this
// machine, never the real ones: reply with an attachment → Undo → send again → the message in its
// thread, once, before and after the next sync, for Gmail and for Outlook; a draft saved to Gmail's
// Drafts while typing, one made in Gmail opened and discarded; the hold kept while the window is in the
// tray, held mail sent when Commander quits, offline sends waiting in the Outbox, and a refused send
// kept with its reason and Retry. Tokens are stored in the real keyring, so these need the author's
// Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DAY = 86_400_000;
const PDF = { name: 'plan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') };

let google: FakeGoogle | undefined;
let microsoft: FakeMicrosoft | undefined;
let commander: LaunchedCommander | undefined;

test.beforeEach(() => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  google = undefined;
  await microsoft?.close();
  microsoft = undefined;
});

async function withGoogle() {
  google = await startFakeGoogle();
  const now = Date.now();
  const first = google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: now - 2 * DAY,
    messageId: '<offsite-1@mail.northwind.test>',
  });
  google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Re: Q4 offsite dates',
    text: 'Or the week after?',
    date: now - DAY,
    threadId: first,
    messageId: '<offsite-2@mail.northwind.test>',
    inReplyTo: '<offsite-1@mail.northwind.test>',
    references: '<offsite-1@mail.northwind.test>',
  });
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    gmailUrl: google.gmailUrl,
  };
  commander = await launchCommander({
    env: { COMMANDER_TEST_GOOGLE: JSON.stringify(config), COMMANDER_TEST_HOOKS: '1' },
  });
  const window = await commander.window();
  await commander.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  await openSettings(window);
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  await expect(section.getByTestId('account-synced')).toHaveText(/· 2 emails$/);
  return { window, gmail: google.gmail, threadId: first };
}

async function withOutlook() {
  microsoft = await startFakeMicrosoft();
  const { mail } = microsoft;
  const dana = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
  mail.deliver(SAM.id, {
    from: dana,
    to: [{ name: SAM.displayName, address: SAM.userPrincipalName }],
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: Date.now() - DAY,
    messageId: '<offsite-1@mail.northwind.test>',
    conversationId: 'AAQkFake-conv-offsite=',
  });
  const config = {
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  };
  commander = await launchCommander({
    env: { COMMANDER_TEST_MICROSOFT: JSON.stringify(config), COMMANDER_TEST_HOOKS: '1' },
  });
  const window = await commander.window();
  await commander.app.evaluate(({ shell }, login) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(login)) await fetch(url);
    };
  }, microsoft.loginUrl);
  await openSettings(window);
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(outlook.getByTestId('account-status').first()).toHaveText('Connected');
  return { window, mail };
}

async function openEmail(window: Page) {
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');
  await expect(section.getByTestId('email-thread').first()).toBeVisible();
  return section;
}

// Every send is held this long (Settings → Email's Undo send).
async function undoFor(page: Page, seconds: 5 | 10 | 20 | 30 | 60) {
  await page.evaluate(
    (undoSeconds) =>
      window.commander.compose({ op: 'save-settings', settings: { defaultAccount: null, undoSeconds } }),
    seconds,
  );
}

const reader = (section: Locator) => section.getByRole('region', { name: 'Thread' });
const toastSaying = (window: Page, text: string) =>
  window.locator('[data-sonner-toast]').filter({ hasText: text });

// Opens the first thread and writes a reply with an attachment, then sends it.
async function replyWithAttachment(window: Page, section: Locator, words: string) {
  await section.getByTestId('email-thread').first().click();
  await expect(reader(section).getByTestId('email-message').first()).toBeVisible();
  await window.keyboard.press('r');
  const composer = section.getByRole('region', { name: 'Reply' });
  await expect(composer).toBeVisible();
  await composer.getByTestId('compose-body').click();
  await window.keyboard.type(words);
  await composer.getByTestId('compose-attach-input').setInputFiles(PDF);
  await expect(composer.getByTestId('compose-attachment')).toContainText('plan.pdf');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer).toHaveCount(0);
}

test('Gmail: reply with an attachment → Undo → send again → the message in its thread, once', async () => {
  test.setTimeout(120_000);
  const { window, gmail, threadId } = await withGoogle();
  const section = await openEmail(window);
  await undoFor(window, 5);

  await replyWithAttachment(window, section, 'Thursday works for me.');
  // Shown in the thread at once, held with Undo.
  await expect(reader(section).getByTestId('email-message')).toHaveCount(3);
  await toastSaying(window, 'Sending…').getByRole('button', { name: 'Undo' }).click();
  const again = section.getByRole('region', { name: 'Reply' });
  await expect(again.getByTestId('compose-body')).toContainText('Thursday works for me.');
  await expect(again.getByTestId('compose-attachment')).toContainText('plan.pdf');
  await expect(reader(section).getByTestId('email-message')).toHaveCount(2);
  // Nothing left for Gmail while it was held.
  await window.waitForTimeout(6_000);
  expect(gmail.sent).toHaveLength(0);

  await again.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => gmail.sent.length, { timeout: 30_000 }).toBe(1);
  const [sent] = gmail.sent;
  expect(sent?.threadId).toBe(threadId);
  const header = (name: string) => sent?.mime.headers.find((each) => each.name.toLowerCase() === name)?.value;
  expect(header('in-reply-to')).toBe('<offsite-2@mail.northwind.test>');
  expect(header('subject')).toBe('Re: Q4 offsite dates');
  expect(sent?.mime.parts.map((part) => part.type)).toEqual(['multipart/alternative', 'application/pdf']);

  // In the thread once, and still once after the next sync brings Gmail's copy.
  await expect(reader(section).getByTestId('email-message')).toHaveCount(3);
  await section.getByRole('button', { name: 'Refresh' }).click();
  await window.waitForTimeout(1_500);
  await expect(reader(section).getByTestId('email-message')).toHaveCount(3);
  await expect(section.getByTestId('email-thread').first().getByTestId('thread-count')).toHaveText('3');
});

test('Outlook: reply with an attachment → Undo → send again → the message in its thread, once', async () => {
  test.setTimeout(120_000);
  const { window, mail } = await withOutlook();
  const section = await openEmail(window);
  await undoFor(window, 5);

  await replyWithAttachment(window, section, 'Thursday works for me.');
  await toastSaying(window, 'Sending…').getByRole('button', { name: 'Undo' }).click();
  const again = section.getByRole('region', { name: 'Reply' });
  await expect(again.getByTestId('compose-attachment')).toContainText('plan.pdf');
  await again.getByRole('button', { name: 'Send', exact: true }).click();

  await expect.poll(() => mail.sent.length, { timeout: 30_000 }).toBe(1);
  expect(mail.sent[0]).toMatchObject({
    to: ['dana@northwind.test'],
    attachments: [{ name: 'plan.pdf', size: PDF.buffer.length }],
    inReplyTo: '<offsite-1@mail.northwind.test>',
    conversationId: 'AAQkFake-conv-offsite=',
  });
  await expect(reader(section).getByTestId('email-message')).toHaveCount(2);
  await section.getByRole('button', { name: 'Refresh' }).click();
  await window.waitForTimeout(1_500);
  await expect(reader(section).getByTestId('email-message')).toHaveCount(2);
  expect(mail.drafts(SAM.id)).toEqual([]);
});

test('drafts: saved to Gmail while typing; one made in Gmail opens and is discarded', async () => {
  test.setTimeout(90_000);
  const { window, gmail } = await withGoogle();
  gmail.saveDraft(ALEX.email, {
    from: ALEX.email,
    to: 'Priya Patel <priya@contoso.test>',
    subject: 'Lunch next week?',
    text: 'Are you free on Tuesday?',
    date: Date.now(),
  });
  const section = await openEmail(window);

  // New mail, saved to Gmail's Drafts after a pause in typing.
  await window.keyboard.press('c');
  const sheet = section.page().getByRole('region', { name: 'New message' });
  await sheet.getByRole('combobox', { name: 'To' }).fill('dana@northwind.test,');
  await sheet.getByRole('textbox', { name: 'Subject' }).fill('Venue options');
  await expect(sheet.getByTestId('compose-saved')).toHaveText('Draft saved', { timeout: 10_000 });
  await expect
    .poll(
      () =>
        gmail
          .drafts(ALEX.email)
          .map((each) => each.subject)
          .sort(),
      { timeout: 20_000 },
    )
    .toEqual(['Lunch next week?', 'Venue options']);
  await sheet.getByRole('button', { name: 'Close (the draft is kept)' }).click();

  // The draft made in Gmail syncs in, opens in the composer, and goes when discarded.
  await section.getByRole('button', { name: 'Refresh' }).click();
  await section
    .getByRole('tablist', { name: 'View' })
    .getByRole('tab', { name: /Drafts/ })
    .click();
  const lunch = section.getByTestId('email-draft').filter({ hasText: 'Lunch next week?' });
  await expect(lunch).toBeVisible({ timeout: 15_000 });
  await lunch.getByText('Lunch next week?').click();
  const opened = section.page().getByRole('region', { name: 'New message' });
  await expect(opened.getByRole('textbox', { name: 'Subject' })).toHaveValue('Lunch next week?');
  await expect(opened.getByTestId('compose-body')).toContainText('Are you free on Tuesday?');
  await opened.getByRole('button', { name: 'Discard draft' }).click();
  await expect
    .poll(() => gmail.drafts(ALEX.email).map((each) => each.subject), { timeout: 20_000 })
    .toEqual(['Venue options']);
});

test('the hold: kept in the tray, sent on quit; offline waits in the Outbox; a refusal keeps its reason with Retry', async () => {
  test.setTimeout(150_000);
  const { window, gmail } = await withGoogle();
  const section = await openEmail(window);
  const app = commander?.app as ElectronApplication;

  // Settings → Email: Undo send.
  await openSettings(window);
  await pickOption(window.getByRole('combobox', { name: 'Undo send' }), '5 seconds');
  await expect(async () => {
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('settings')).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });

  // Closing the window to the tray keeps the hold: the message goes when it ends.
  await replyWithAttachment(window, section, 'From the tray.');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => gmail.sent.length, { timeout: 30_000 }).toBe(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());

  // A refused send stays in the Outbox with Gmail's reason, and Retry sends it.
  gmail.refuseSends('Invalid To header');
  await replyWithAttachment(window, section, 'Refused.');
  const outbox = section.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: /Outbox/ });
  await outbox.click();
  const refused = section.getByTestId('outbox-entry');
  await expect(refused).toContainText(
    'Couldn’t send: Gmail refused to send this message: Invalid To header',
    {
      timeout: 30_000,
    },
  );
  gmail.refuseSends(null);
  await refused.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => gmail.sent.length, { timeout: 30_000 }).toBe(2);

  // Offline: it waits in the Outbox, and goes once Commander is back online.
  await app.evaluate((_electron) =>
    (
      globalThis as unknown as { commanderTestHooks: { setOnline(online: boolean): void } }
    ).commanderTestHooks.setOnline(false),
  );
  await section.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: /Inbox/ }).click();
  await replyWithAttachment(window, section, 'Offline.');
  await outbox.click();
  await expect(section.getByTestId('outbox-entry')).toContainText('Waiting to send', { timeout: 15_000 });
  expect(gmail.sent).toHaveLength(2);
  await app.evaluate((_electron) =>
    (
      globalThis as unknown as { commanderTestHooks: { setOnline(online: boolean): void } }
    ).commanderTestHooks.setOnline(true),
  );
  await expect.poll(() => gmail.sent.length, { timeout: 30_000 }).toBe(3);

  // Quitting during a hold sends the held message before Commander exits.
  await undoFor(window, 60);
  await section.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: /Inbox/ }).click();
  await replyWithAttachment(window, section, 'Sent on the way out.');
  await commander?.close();
  commander = undefined;
  expect(gmail.sent).toHaveLength(4);
});
