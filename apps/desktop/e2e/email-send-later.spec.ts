import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Send later end to end (#139), against a fake Google (Gmail) and a fake Microsoft (Graph) on this
// machine, never the real ones. Gmail: picking a time always says Ares has to be running; Scheduled
// lists it with its time, Account and who holds it; Change time, Edit, Send now and Cancel work; at its
// time (send later's clock moved on through a test hook) it goes, once; a time that passed while
// Commander was closed is never sent on the next start but asked about in the Update (Needs you now),
// whose Send now, Edit and Discard work; one that passed while the machine slept is missed on waking;
// one that passed offline goes on reconnect, with no question. Outlook work Account: no notice, the
// message held in Exchange's Outbox with the deferred-send property, and Cancel takes it out. Tokens are
// stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DAY = 86_400_000;
const NOTICE = 'Ares has to be running (the window or the tray) at that time to send this.';

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

function googleEnv(fake: FakeGoogle, extra: Record<string, string> = {}) {
  const config = {
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    authorizeUrl: fake.authorizeUrl,
    tokenUrl: fake.tokenUrl,
    userinfoUrl: fake.userinfoUrl,
    gmailUrl: fake.gmailUrl,
  };
  return { COMMANDER_TEST_GOOGLE: JSON.stringify(config), COMMANDER_TEST_HOOKS: '1', ...extra };
}

async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

async function withGoogle() {
  google = await startFakeGoogle();
  google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: Date.now() - 2 * DAY,
    messageId: '<offsite-1@mail.northwind.test>',
  });
  commander = await launchCommander({ env: googleEnv(google) });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  await openSettings(window, 'Accounts');
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  await expect(section.getByTestId('account-synced')).toHaveText(/· 1 email$/);
  return { window, gmail: google.gmail };
}

async function withOutlook() {
  microsoft = await startFakeMicrosoft();
  const { mail } = microsoft;
  mail.deliver(SAM.id, {
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
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
  await openSettings(window, 'Accounts');
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

const views = (section: Locator) => section.getByRole('tablist', { name: 'View' });
const toastSaying = (window: Page, text: string) =>
  window.locator('[data-sonner-toast]').filter({ hasText: text });

// Local times, as the menu offers them.
const tomorrowAt = (hour: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour).getTime();
};
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
// A time a few minutes on, to the minute (the date and time field's step).
const minutesOn = (minutes: number) => {
  const at = new Date(Date.now() + minutes * 60_000);
  at.setSeconds(0, 0);
  return at.getTime();
};

// New mail to Dana with this subject, its send time picked from the Send later menu (a quick choice,
// or a date and time), checking what the menu and the composer say. Returns the composer.
async function scheduleNew(
  window: Page,
  section: Locator,
  subject: string,
  when: { choice: RegExp } | { at: number },
  says: 'notice' | 'held' = 'notice',
) {
  await window.keyboard.press('c');
  const sheet = section.page().getByRole('region', { name: 'New message' });
  await sheet.getByRole('combobox', { name: 'To' }).fill('dana@northwind.test,');
  await sheet.getByRole('textbox', { name: 'Subject' }).fill(subject);
  await sheet.getByTestId('compose-body').click();
  await window.keyboard.type('Here are three options.');
  await sheet.getByRole('button', { name: 'Send later' }).click();
  const picker = window.getByTestId('send-later-picker');
  if (says === 'notice') await expect(picker.getByTestId('send-later-notice')).toHaveText(NOTICE);
  else {
    await expect(picker.getByTestId('send-later-held')).toBeVisible();
    await expect(picker.getByTestId('send-later-notice')).toHaveCount(0);
  }
  if ('choice' in when) await picker.getByRole('button', { name: when.choice }).click();
  else {
    await picker.getByLabel('Date and time').fill(localInput(when.at));
    await picker.getByRole('button', { name: 'Pick this time' }).click();
  }
  await expect(picker).toHaveCount(0);
  if (says === 'notice') await expect(sheet.getByTestId('send-later-notice')).toHaveText(NOTICE);
  else await expect(sheet.getByTestId('send-later-notice')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Schedule' }).click();
  await expect(sheet).toHaveCount(0);
}

// How far the test has moved send later's clock on, so far.
let movedBy = 0;
test.beforeEach(() => {
  movedBy = 0;
});

// Moves send later's clock on to just past `at` (the Core's other clocks stay as they are).
async function sendLaterClockTo(app: ElectronApplication, at: number) {
  const offsetMs = at + 5_000 - (Date.now() + movedBy);
  movedBy += offsetMs;
  await app.evaluate(
    (_electron, ms) =>
      (
        globalThis as unknown as { commanderTestHooks: { moveSendLaterClock(offset: number): void } }
      ).commanderTestHooks.moveSendLaterClock(ms),
    offsetMs,
  );
}

async function setOnline(app: ElectronApplication, online: boolean) {
  await app.evaluate(
    (_electron, on) =>
      (
        globalThis as unknown as { commanderTestHooks: { setOnline(online: boolean): void } }
      ).commanderTestHooks.setOnline(on),
    online,
  );
}

const subjects = (gmail: FakeGoogle['gmail']) =>
  gmail.sent.map(
    (each) => each.mime.headers.find((header) => header.name.toLowerCase() === 'subject')?.value,
  );

test('Gmail: the running notice every time, Scheduled, and it goes at its time', async () => {
  test.setTimeout(150_000);
  const { window, gmail } = await withGoogle();
  const app = commander?.app as ElectronApplication;
  const section = await openEmail(window);

  await scheduleNew(window, section, 'Venue options', { choice: /^Tomorrow morning/ });
  await expect(toastSaying(window, 'Scheduled for tomorrow 08:00')).toBeVisible();
  // Saved to Gmail's Drafts meanwhile, and not sent.
  await expect
    .poll(() => gmail.drafts(ALEX.email).map((each) => each.subject), { timeout: 20_000 })
    .toEqual(['Venue options']);
  expect(gmail.sent).toEqual([]);

  // Scheduled: its time, Account and who holds it, with a count.
  const scheduledTab = views(section).getByRole('tab', { name: /Scheduled/ });
  await expect(scheduledTab).toHaveText('Scheduled1');
  await scheduledTab.click();
  const entry = section.getByTestId('scheduled-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.getByTestId('scheduled-time')).toHaveText('tomorrow 08:00');
  await expect(entry.getByTestId('scheduled-held-by')).toHaveText('Sends from Commander');
  await expect(entry).toContainText(ALEX.email);

  // Send now, from Scheduled.
  await views(section).getByRole('tab', { name: /Inbox/ }).click();
  await scheduleNew(window, section, 'Lunch Thursday', { choice: /^Tomorrow morning/ });
  await scheduledTab.click();
  await section
    .getByTestId('scheduled-entry')
    .filter({ hasText: 'Lunch Thursday' })
    .getByRole('button', { name: 'Send now' })
    .click();
  await expect.poll(() => subjects(gmail), { timeout: 30_000 }).toEqual(['Lunch Thursday']);

  // Edit: back in the composer with its time offered again; Schedule puts it back.
  await views(section).getByRole('tab', { name: /Inbox/ }).click();
  await scheduleNew(window, section, 'Board pack', { choice: /^Tomorrow morning/ });
  await scheduledTab.click();
  const board = section.getByTestId('scheduled-entry').filter({ hasText: 'Board pack' });
  await board.getByRole('button', { name: 'Edit' }).click();
  const editing = window.getByRole('region', { name: 'New message' });
  await expect(editing.getByRole('textbox', { name: 'Subject' })).toHaveValue('Board pack');
  await expect(editing.getByTestId('send-later-notice')).toHaveText(NOTICE);
  await expect(board).toHaveCount(0);
  await editing.getByRole('button', { name: 'Schedule' }).click();
  await expect(board).toHaveCount(1);

  // Cancel: it won't go, and is a draft again.
  await board.getByRole('button', { name: 'Cancel' }).click();
  await expect(board).toHaveCount(0);
  await views(section)
    .getByRole('tab', { name: /Drafts/ })
    .click();
  await expect(section.getByTestId('email-draft').filter({ hasText: 'Board pack' })).toBeVisible();

  // Change time: the notice again, and the new time.
  await scheduledTab.click();
  await expect(entry).toHaveCount(1);
  await entry.getByRole('button', { name: 'Change time' }).click();
  const picker = window.getByTestId('send-later-picker');
  await expect(picker.getByTestId('send-later-notice')).toHaveText(NOTICE);
  await picker.getByLabel('Date and time').fill(localInput(tomorrowAt(9)));
  await picker.getByRole('button', { name: 'Pick this time' }).click();
  await expect(entry.getByTestId('scheduled-time')).toHaveText('tomorrow 09:00');

  // Its time comes while Commander runs (send later's clock moved on): it goes, once.
  await sendLaterClockTo(app, tomorrowAt(9));
  await expect.poll(() => subjects(gmail), { timeout: 30_000 }).toEqual(['Lunch Thursday', 'Venue options']);
  await expect(section.getByTestId('scheduled-entry')).toHaveCount(0);
  await window.waitForTimeout(2_000);
  expect(gmail.sent).toHaveLength(2);
});

test('Gmail: a time missed while Commander was closed never sends on start, and the Update asks', async () => {
  test.setTimeout(180_000);
  const { window, gmail } = await withGoogle();
  const section = await openEmail(window);
  for (const subject of ['Venue options', 'Lunch Thursday', 'Board pack'])
    await scheduleNew(window, section, subject, { at: minutesOn(5) });
  await views(section)
    .getByRole('tab', { name: /Scheduled/ })
    .click();
  await expect(section.getByTestId('scheduled-entry')).toHaveCount(3);

  // Commander closes, and starts again after their time (send later's clock half an hour on).
  const { userDataDir } = commander as LaunchedCommander;
  await commander?.app.close();
  commander = await launchCommander({
    userDataDir,
    env: googleEnv(google as FakeGoogle, { COMMANDER_TEST_SEND_LATER_OFFSET_MS: String(30 * 60_000) }),
  });
  const again = await commander.window();
  const email = await openEmail(again);
  await views(email)
    .getByRole('tab', { name: /Scheduled/ })
    .click();
  await expect(email.getByTestId('scheduled-entry')).toHaveCount(3);
  await expect(email.locator('[data-testid="scheduled-entry"][data-state="missed"]')).toHaveCount(3);
  await again.waitForTimeout(3_000);
  expect(gmail.sent).toEqual([]);

  // The Update asks, under Needs you now, one line each, with Send now, Edit and Discard.
  await again.keyboard.press('u');
  const panel = again.getByTestId('update-panel');
  const now = panel.getByRole('region', { name: 'Needs you now' });
  await expect(now.getByTestId('update-line')).toHaveCount(3);
  const lineFor = (subject: string) => now.getByTestId('update-line').filter({ hasText: subject });
  await expect(lineFor('Venue options')).toContainText(
    /Your email to dana@northwind\.test \(“Venue options”\) was due (\S+ )*at \d\d:\d\d\. Send it now\?/,
  );

  await lineFor('Venue options').getByRole('button', { name: 'Send now: Venue options' }).click();
  await expect.poll(() => subjects(gmail), { timeout: 30_000 }).toEqual(['Venue options']);
  await expect(lineFor('Venue options').getByTestId('update-line-status')).toHaveText('Done');

  await lineFor('Board pack').getByRole('button', { name: 'Discard: Board pack' }).click();
  await expect(lineFor('Board pack').getByTestId('update-line-status')).toHaveText('Done');
  await expect
    .poll(() => gmail.drafts(ALEX.email).map((each) => each.subject), { timeout: 20_000 })
    .not.toContain('Board pack');

  await lineFor('Lunch Thursday').getByRole('button', { name: 'Edit: Lunch Thursday' }).click();
  await expect(panel).toHaveCount(0);
  const editing = again.getByRole('region', { name: 'New message' });
  await expect(editing.getByRole('textbox', { name: 'Subject' })).toHaveValue('Lunch Thursday');
  await expect(email.getByTestId('scheduled-entry')).toHaveCount(0);
  expect(subjects(gmail)).toEqual(['Venue options']);
});

test('Gmail: missed while the machine slept; offline at its time it goes on reconnect, with no question', async () => {
  test.setTimeout(150_000);
  const { window, gmail } = await withGoogle();
  const app = commander?.app as ElectronApplication;
  const section = await openEmail(window);

  // Offline at its time while Commander runs: it waits, and goes when the connection returns.
  await setOnline(app, false);
  const lunchAt = minutesOn(10);
  await scheduleNew(window, section, 'Lunch Thursday', { at: lunchAt });
  await sendLaterClockTo(app, lunchAt);
  await views(section)
    .getByRole('tab', { name: /Outbox/ })
    .click();
  await expect(section.getByTestId('outbox-entry')).toContainText('Waiting to send', { timeout: 15_000 });
  expect(gmail.sent).toEqual([]);
  await setOnline(app, true);
  await expect.poll(() => subjects(gmail), { timeout: 30_000 }).toEqual(['Lunch Thursday']);

  // Asleep at its time: missed on waking, never sent.
  await views(section).getByRole('tab', { name: /Inbox/ }).click();
  await scheduleNew(window, section, 'Venue options', { choice: /^Tomorrow morning/ });
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  // Just past its time, but asleep: only the machine sleeping makes it missed.
  await sendLaterClockTo(app, tomorrowAt(8));
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  await views(section)
    .getByRole('tab', { name: /Scheduled/ })
    .click();
  await expect(section.locator('[data-testid="scheduled-entry"][data-state="missed"]')).toHaveCount(1);
  await expect(section.getByTestId('scheduled-line')).toContainText('Missed: it was due');
  await window.waitForTimeout(2_000);
  expect(subjects(gmail)).toEqual(['Lunch Thursday']);

  // Only the one missed while asleep is asked about.
  await window.keyboard.press('Escape');
  await window.keyboard.press('u');
  const now = window.getByTestId('update-panel').getByRole('region', { name: 'Needs you now' });
  await expect(now.getByTestId('update-line')).toHaveCount(1);
  await expect(now.getByTestId('update-line')).toContainText('Venue options');
});

test('Outlook work Account: no running notice; held in Exchange’s Outbox, and Cancel takes it out', async () => {
  test.setTimeout(120_000);
  const { window, mail } = await withOutlook();
  const section = await openEmail(window);

  await scheduleNew(window, section, 'Venue options', { choice: /^Tomorrow morning/ }, 'held');
  await expect
    .poll(() => mail.outbox(SAM.id), { timeout: 30_000 })
    .toEqual([
      expect.objectContaining({
        subject: 'Venue options',
        to: ['dana@northwind.test'],
        deferredUntil: new Date(tomorrowAt(8)).toISOString(),
      }),
    ]);
  expect(mail.sent).toEqual([]);

  await views(section)
    .getByRole('tab', { name: /Scheduled/ })
    .click();
  const entry = section.getByTestId('scheduled-entry');
  await expect(entry.getByTestId('scheduled-held-by')).toHaveText('Held by Microsoft');
  await expect(entry).toHaveAttribute('data-state', 'held', { timeout: 15_000 });

  await entry.getByRole('button', { name: 'Cancel' }).click();
  await expect(entry).toHaveCount(0);
  await expect.poll(() => mail.outbox(SAM.id), { timeout: 30_000 }).toEqual([]);
  await expect
    .poll(() => mail.drafts(SAM.id).map((each) => each.subject), { timeout: 30_000 })
    .toEqual(['Venue options']);
  expect(mail.sent).toEqual([]);
});
