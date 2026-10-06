import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Outlook mail end to end (#136), against a fake Microsoft identity platform and Graph on this machine,
// never the real ones: connect an Outlook Account → its 30 days download (a conversation threaded
// across the Inbox and Sent Items; older mail left with Outlook) → read a thread in the sandboxed
// reader (remote images held back, as Outlook does; the inline logo and an attachment through Graph)
// → archive (moved to Archive in Outlook) and undo → Move to folder and undo → a message moved to
// Deleted Items in Outlook shows in Trash after a refresh. Tokens are stored in the real keyring, so
// these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const DANA = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
const ME = { name: SAM.displayName, address: SAM.userPrincipalName };

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;
let ids: { offsite: string; reply: string; answer: string; certificate: string };

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  const { mail } = microsoft;
  mail.addFolder(SAM.id, 'Projects');
  const now = Date.now();
  const conversationId = 'AAQkFake-conv-offsite=';
  const offsite = mail.deliver(SAM.id, {
    from: DANA,
    to: [ME],
    subject: 'Q4 offsite dates',
    html: '<html><head><style>p.MsoNormal{margin:0}</style></head><body><div class="WordSection1"><p class="MsoNormal">Which dates work for the <b>Q4 offsite</b>?<o:p></o:p></p><p class="MsoNormal"><img src="cid:image001.png@01DB1A2B.3C4D5E60" alt="logo"></p><p class="MsoNormal"><img src="http://127.0.0.1:9/open.gif" alt="tracker" width="1" height="1"></p></div></body></html>',
    date: now - 2 * DAY,
    // Unread, so the reader opens it expanded.
    isRead: false,
    messageId: '<offsite-1@mail.northwind.test>',
    conversationId,
    attachments: [
      { name: 'image001.png', type: 'image/png', content: PNG, contentId: 'image001.png@01DB1A2B.3C4D5E60' },
    ],
  });
  const reply = mail.deliver(SAM.id, {
    folder: 'sentitems',
    from: ME,
    to: [DANA],
    subject: 'RE: Q4 offsite dates',
    text: '19–21 Nov works for me.',
    date: now - 2 * DAY + HOUR,
    isRead: true,
    messageId: '<sam-reply-1@contoso.test>',
    conversationId,
    withoutHeaders: true,
  });
  const answer = mail.deliver(SAM.id, {
    from: DANA,
    to: [ME],
    subject: 'RE: Q4 offsite dates',
    text: 'Booked the venue for 19–21 Nov.',
    date: now - DAY,
    messageId: '<offsite-2@mail.northwind.test>',
    inReplyTo: '<sam-reply-1@contoso.test>',
    references: '<offsite-1@mail.northwind.test> <sam-reply-1@contoso.test>',
    conversationId,
  });
  const certificate = mail.deliver(SAM.id, {
    from: { name: 'Priya Patel', address: 'priya@contoso.test' },
    to: [ME],
    subject: 'Staging certificate',
    text: 'The staging certificate expires on Friday. The CSR is attached.',
    date: now - HOUR,
    attachments: [
      { name: 'staging.csr', type: 'application/pkcs10', content: '-----BEGIN CERTIFICATE REQUEST-----' },
    ],
  });
  // From before the 30 days: left with Outlook.
  mail.deliver(SAM.id, {
    from: { name: 'Old Friend', address: 'old@friend.test' },
    to: [ME],
    subject: 'Ancient history',
    text: 'From long ago.',
    date: now - 45 * DAY,
  });
  ids = { offsite, reply, answer, certificate };
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
});

const environment = () => ({
  COMMANDER_TEST_MICROSOFT: JSON.stringify({
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  }),
});

// The system browser: follows the sign-in pages (which the fake approves at once) back to Commander.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, login) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(login)) await fetch(url);
    };
  }, microsoft.loginUrl);
}

const subjects = (section: Locator) => section.getByTestId('email-thread').getByTestId('thread-subject');
const row = (section: Locator, subject: string) =>
  section.getByTestId('email-thread').filter({ has: section.page().getByText(subject, { exact: true }) });
const view = (section: Locator, name: RegExp) =>
  section.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
const reader = (section: Locator) => section.getByRole('region', { name: 'Thread' });
const toastSaying = (window: Page, text: string) =>
  window.locator('[data-sonner-toast]').filter({ hasText: text });
const folderOf = (id: string) => () => microsoft.mail.messageOf(SAM.id, id)?.folder ?? null;

test('connect Outlook → first sync → read a thread → archive → move to a folder → undo', async () => {
  test.setTimeout(90_000);
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);

  await openSettings(window);
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(outlook.getByTestId('account-status').first()).toHaveText('Connected');
  await window.keyboard.press('Escape');

  // The 30 days, the conversation threaded across the Inbox and Sent Items; older mail left out.
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');
  await expect(subjects(section)).toHaveText(['Staging certificate', 'RE: Q4 offsite dates']);
  await expect(row(section, 'RE: Q4 offsite dates').getByTestId('thread-count')).toHaveText('3');
  await expect(row(section, 'RE: Q4 offsite dates').getByTestId('thread-senders')).toHaveText(
    'Dana Whitfield, me',
  );
  await expect(
    section.getByRole('tablist', { name: 'Account' }).getByRole('tab', { name: SAM.userPrincipalName }),
  ).toContainText('Outlook');
  // Junk Email and Outbox were never read (Drafts is, for the drafts made in Outlook, #138).
  expect(microsoft.mail.requests.some((request) => /fld-(junkemail|outbox)=\/messages/.test(request))).toBe(
    false,
  );

  // Read the thread: Outlook holds remote images back; the inline logo comes through Graph.
  await row(section, 'RE: Q4 offsite dates').click();
  const pane = reader(section);
  const frame = window.frameLocator('[data-testid="email-frame"]').first();
  await expect(frame.getByText('Which dates work for the')).toBeVisible();
  await expect(pane.getByTestId('email-images-bar').first()).toContainText('1 image held back');
  await expect
    .poll(() => frame.locator('img[alt="logo"]').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(microsoft.mail.requests.some((request) => request.includes('/$value'))).toBe(true);

  // The certificate's attachment, listed from Graph.
  await row(section, 'Staging certificate').click();
  await expect(reader(section).getByTestId('email-attachment')).toHaveText(/staging\.csr/);

  // Archive (e): out of the inbox at once, and into Archive in Outlook; Undo brings it back.
  await window.keyboard.press('Escape');
  await window.keyboard.press('e');
  await expect(subjects(section)).toHaveText(['RE: Q4 offsite dates']);
  await expect.poll(folderOf(ids.certificate)).toBe('archive');
  await toastSaying(window, 'Archived: Staging certificate').getByRole('button', { name: 'Undo' }).click();
  await expect(subjects(section)).toHaveText(['Staging certificate', 'RE: Q4 offsite dates']);
  await expect.poll(folderOf(ids.certificate)).toBe('inbox');

  // Move to folder (l): the Account's folders; the thread goes to Projects, the User's reply stays.
  await row(section, 'RE: Q4 offsite dates').click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('l');
  const picker = window.getByRole('dialog', { name: 'Move to folder' });
  await picker.getByRole('button', { name: 'Projects' }).click();
  await expect(subjects(section)).toHaveText(['Staging certificate']);
  await expect.poll(folderOf(ids.offsite)).toBe('Projects');
  await expect.poll(folderOf(ids.answer)).toBe('Projects');
  expect(folderOf(ids.reply)()).toBe('sentitems');
  await view(section, /^Projects/).click();
  await expect(subjects(section)).toHaveText(['RE: Q4 offsite dates']);

  // Undo (Ctrl+Z): back in the Inbox, in Outlook too.
  await window.keyboard.press('Control+z');
  await expect(subjects(section)).toHaveText([]);
  await view(section, /^Inbox/).click();
  await expect(subjects(section)).toHaveText(['Staging certificate', 'RE: Q4 offsite dates']);
  await expect.poll(folderOf(ids.offsite)).toBe('inbox');
  await expect.poll(folderOf(ids.answer)).toBe('inbox');

  // Moved to Deleted Items in Outlook: the next sync shows it in Trash.
  microsoft.mail.move(SAM.id, ids.certificate, 'deleteditems');
  await section.getByRole('button', { name: 'Refresh' }).click();
  await expect(subjects(section)).toHaveText(['RE: Q4 offsite dates']);
  await view(section, /^Trash/).click();
  await expect(subjects(section)).toHaveText(['Staging certificate']);
});
