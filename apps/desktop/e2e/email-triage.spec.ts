import { expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Triage end to end (#140), against a fake Google (Gmail) on this machine, never the real one: Triage
// Needs reply from the Bucket strip → reply and send (it reaches Gmail once Undo send is over) →
// archive (the inbox label goes in Gmail) → snooze → make it a Todo (from email, in the Todos Section)
// → move to FYI → the summary → the next Bucket (Waiting on others) → Esc back to the inbox. Every key
// is in the `?` cheat sheet. Tokens are stored in the real keyring, so this needs the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const HOUR = 3_600_000;

let google: FakeGoogle | undefined;
let commander: LaunchedCommander | undefined;

test.beforeEach(() => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  google = undefined;
});

// Five threads waiting on a reply (newest first, the order Triage walks them), two waiting on others.
const NEEDS_REPLY = [
  ['Dana Reyes <dana@northwind.test>', 'Q4 offsite dates', 'Which dates work for you?'],
  ['Priya Patel <priya@contoso.test>', 'Staging certificate', 'Can you renew it before Friday?'],
  ['Leo Brandt <leo@contoso.test>', 'Signed contract?', 'Did you sign the contract yet?'],
  ['Sam Okafor <sam@northwind.test>', 'Board deck review', 'Could you look over the deck?'],
  ['Mia Chen <mia@contoso.test>', 'Team lunch', 'Lunch on Friday, are you in?'],
] as const;
const WAITING = [
  ['Ana Silva <ana@acme.test>', 'Quote for the new site'],
  ['Tom Weber <tom@acme.test>', 'Contract draft'],
] as const;

async function withGoogle() {
  google = await startFakeGoogle();
  const now = Date.now();
  const ids = new Map<string, string>();
  NEEDS_REPLY.forEach(([from, subject, text], index) => {
    ids.set(
      subject,
      google?.gmail.deliver(ALEX.email, {
        from,
        to: `Alex Kim <${ALEX.email}>`,
        subject,
        text,
        date: now - (index + 1) * HOUR,
      }) ?? '',
    );
  });
  WAITING.forEach(([from, subject], index) => {
    google?.gmail.deliver(ALEX.email, {
      from,
      to: `Alex Kim <${ALEX.email}>`,
      subject,
      text: 'I will get back to you.',
      date: now - (10 + index) * HOUR,
    });
  });
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
  await openSettings(window);
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  await expect(section.getByTestId('account-synced')).toHaveText(/· 7 emails$/);
  return { window, gmail: google.gmail, ids };
}

// Sorts the mail as the User would have with `v`: the first five into Needs reply, the others into
// Waiting on others. Undo send is 5 seconds, to keep the wait short.
async function sortAndSettle(page: Page) {
  await page.evaluate(
    async ({ needsReply, waiting }) => {
      const emails = await window.commander.itemStore({ op: 'query', query: { kinds: ['email'] } });
      const into = (bucketId: string) => (item: { id: string }) => ({
        type: 'edit-fields' as const,
        itemId: item.id,
        fields: { bucket: { bucketId, sortedBy: 'user' } },
      });
      await window.commander.itemStore({
        op: 'record-all',
        actions: [
          ...emails.filter((item) => needsReply.includes(item.title)).map(into('needs-reply')),
          ...emails.filter((item) => waiting.includes(item.title)).map(into('waiting-on-others')),
        ],
      });
      await window.commander.compose({
        op: 'save-settings',
        settings: { defaultAccount: null, undoSeconds: 5 },
      });
    },
    {
      needsReply: NEEDS_REPLY.map(([, subject]): string => subject),
      waiting: WAITING.map(([, subject]): string => subject),
    },
  );
}

const reader = (section: Locator) => section.getByRole('region', { name: 'Thread' });
const position = (section: Locator) => section.getByTestId('triage-position');
const subject = (section: Locator) => reader(section).getByRole('heading', { level: 2 });
const toastSaying = (window: Page, text: string) =>
  window.locator('[data-sonner-toast]').filter({ hasText: text });

test('Triage Needs reply → reply and send → archive → snooze → Todo → move to FYI → summary → next Bucket', async () => {
  test.setTimeout(150_000);
  const { window, gmail, ids } = await withGoogle();
  await sortAndSettle(window);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');
  await expect(
    section.getByRole('tablist', { name: 'Bucket' }).getByRole('tab', { name: /^Needs reply/ }),
  ).toHaveText('Needs reply5');

  // Triage Needs reply, from the Bucket strip: the newest thread, full width.
  await section.getByRole('button', { name: /^Triage Needs reply/ }).click();
  await expect(position(section)).toHaveText('Needs reply · 1 of 5');
  await expect(subject(section)).toHaveText('Q4 offsite dates');
  await expect(section.getByTestId('email-thread')).toHaveCount(0);
  await expect(section.getByRole('list', { name: 'Triage keys' })).toContainText('Archive');

  // Every Triage key is in the cheat sheet.
  await window.keyboard.press('?');
  const sheet = window.getByTestId('cheat-sheet');
  const triageKeys = sheet.getByRole('region', { name: 'Triage' });
  for (const label of [
    'Reply, then on',
    'Archive',
    'Snooze',
    'Make it a Todo',
    'Move to another Bucket',
    'Set its Project',
    'Skip',
    'Leave Triage',
  ])
    await expect(triageKeys).toContainText(label);
  await window.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(position(section)).toHaveText('Needs reply · 1 of 5');

  // r: the reply below the thread; typing in it fires no Triage key. Sent, Triage moves on.
  await window.keyboard.press('r');
  const composer = section.getByRole('region', { name: 'Reply' });
  await expect(composer).toBeVisible();
  await composer.getByTestId('compose-body').click();
  await window.keyboard.type('Thursday or Friday both work. e j z');
  await expect(position(section)).toHaveText('Needs reply · 1 of 5');
  await composer.getByRole('button', { name: 'Send' }).click();
  await expect(position(section)).toHaveText('Needs reply · 2 of 5');
  await expect(subject(section)).toHaveText('Staging certificate');
  await expect.poll(() => gmail.sent.length, { timeout: 30_000 }).toBe(1);
  expect(gmail.sent[0]?.threadId).toBe(ids.get('Q4 offsite dates'));

  // e: archived, in Gmail too.
  await window.keyboard.press('e');
  await expect(position(section)).toHaveText('Needs reply · 3 of 5');
  await expect(toastSaying(window, 'Archived: Staging certificate')).toBeVisible();
  await expect
    .poll(() => gmail.labelsOf(ALEX.email, ids.get('Staging certificate') ?? ''), { timeout: 30_000 })
    .not.toContain('INBOX');

  // z: the snooze picker.
  await window.keyboard.press('z');
  const snooze = window.getByRole('dialog', { name: 'Snooze until' });
  await snooze.getByRole('button', { name: /^Tomorrow morning/ }).click();
  await expect(position(section)).toHaveText('Needs reply · 4 of 5');
  await expect(toastSaying(window, 'Snoozed until')).toBeVisible();

  // t: a Todo, its title edited in place first.
  await window.keyboard.press('t');
  const todo = window.getByRole('dialog', { name: 'Make it a Todo' });
  const title = todo.getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveValue('Board deck review');
  await expect(todo).toContainText('From email · Sam Okafor');
  await title.fill('Review the board deck');
  await window.keyboard.press('Enter');
  await expect(position(section)).toHaveText('Needs reply · 5 of 5');
  await expect(toastSaying(window, 'Todo added: Review the board deck')).toBeVisible();

  // v: to FYI, as the User.
  await window.keyboard.press('v');
  const buckets = window.getByRole('dialog', { name: 'Move to a Bucket' });
  await buckets.getByRole('option', { name: /FYI/ }).click();

  // The end: what was done, and the next Bucket with mail.
  const end = section.getByRole('region', { name: 'Triage done' });
  await expect(end.getByRole('heading')).toHaveText('Needs reply done');
  await expect(section.getByTestId('triage-summary')).toHaveText(
    '5 done: 1 replied, 1 archived, 1 snoozed, 1 Todo, 1 moved',
  );
  const next = end.getByRole('button', { name: /^Next: Waiting on others \(2\)/ });
  await expect(next).toBeVisible();
  await window.keyboard.press('Enter');
  await expect(position(section)).toHaveText('Waiting on others · 1 of 2');
  await expect(subject(section)).toHaveText('Quote for the new site');

  // Esc: back to the inbox as it was, the threads sorted as decided.
  await window.keyboard.press('Escape');
  await expect(section.getByTestId('triage')).toHaveCount(0);
  const strip = section.getByRole('tablist', { name: 'Bucket' });
  await expect(strip.getByRole('tab', { name: /^Needs reply/ })).toHaveText(/^Needs reply[12]$/);
  await expect(strip.getByRole('tab', { name: /^FYI/ })).toHaveText('FYI1');

  // The Todo, from email, in the Todos Section; its Link opens the thread.
  await tab(window, 'Todos').click();
  const todos = window.getByTestId('section-todos');
  const row = todos.getByRole('listitem').filter({ hasText: 'Review the board deck' });
  await expect(row).toContainText('From email · Sam Okafor');
  await row.click();
  await window.keyboard.press('Enter');
  const links = todos.getByRole('region', { name: 'Links' });
  await links.getByRole('button', { name: /Made from.*Board deck review/ }).click();
  await expect(reader(section).getByRole('heading', { level: 2 })).toHaveText('Board deck review');
});
