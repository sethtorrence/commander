import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Buckets in Gmail (#142) end to end, against a fake Google and Gmail on this machine (never the real
// ones): nothing about Buckets reaches Gmail until Mirror Buckets is switched on in Settings → Accounts
// (after Commander says what will happen); then a sort puts a Commander/<Bucket> label on the email; a
// Commander label changed in Gmail moves the email's Bucket in Commander; a Bucket Rule's sort is
// labelled too; and Skip the inbox switched on for Newsletters offers its mail for archiving, grouped in
// the Bucket view, where Accept all archives it in Gmail. Tokens are stored in the real keyring, so
// these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const HOUR = 3_600_000;

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;
const ids: Record<string, string> = {};

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  const now = Date.now();
  ids.digest = google.gmail.deliver(ALEX.email, {
    from: 'Digest <news@digest.test>',
    to: ALEX.email,
    subject: 'This week in tools',
    text: 'Ten tools worth a look.',
    date: now - 3 * HOUR,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  ids.update = google.gmail.deliver(ALEX.email, {
    from: 'Digest <hello@digest.test>',
    to: ALEX.email,
    subject: 'Product update',
    text: 'What changed this month.',
    date: now - 2 * HOUR,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  });
  ids.offsite = google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: ALEX.email,
    subject: 'Offsite photos',
    text: 'The photos from the offsite are up.',
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

// The Commander labels a message carries in Gmail, by name.
const commanderLabels = (id: string) => {
  const names = new Map(google.gmail.labels(ALEX.email).map((label) => [label.id, label.name]));
  return (google.gmail.labelsOf(ALEX.email, id) ?? [])
    .map((label) => names.get(label) ?? label)
    .filter((name) => name.startsWith('Commander/'));
};
const inInbox = (id: string) => (google.gmail.labelsOf(ALEX.email, id) ?? []).includes('INBOX');

async function moveTo(window: Page, section: Locator, subject: string, bucket: string) {
  await row(section, subject).click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('v');
  await window
    .getByRole('dialog', { name: 'Move to a Bucket' })
    .getByRole('option', { name: bucket })
    .click();
  await expect(bucketOf(section, subject)).toHaveText(bucket);
}

test('mirroring on → sort → label appears → label changed in Gmail → Bucket follows → skip the inbox → Accept all', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);

  await openSettings(window, 'Accounts');
  const account = window.getByTestId('accounts-panel').getByTestId('source-google');
  await account.getByRole('button', { name: 'Connect Google' }).click();
  await expect(account.getByTestId('account-synced')).toHaveText(/· 3 emails$/);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');
  await expect(subjects(section)).toHaveCount(3);

  // Mirroring is off: a sort writes nothing about Buckets to Gmail.
  await moveTo(window, section, 'Offsite photos', 'Receipts');
  await moveTo(window, section, 'Offsite photos', 'FYI');
  await window.waitForTimeout(1000);
  expect(google.gmail.labels(ALEX.email).filter((label) => label.name.startsWith('Commander'))).toEqual([]);
  expect(google.gmail.writes.filter((write) => write.path.includes('labels'))).toEqual([]);

  // Settings → Accounts: Mirror Buckets to Gmail, after Commander says what will happen.
  await openSettings(window, 'Accounts');
  const mirroring = account.getByTestId('bucket-mirroring');
  await expect(mirroring).toContainText('Commander’s Buckets may differ from how you organise mail in Gmail');
  await mirroring.getByRole('switch', { name: 'Mirror Buckets to Gmail' }).click();
  const explain = window.getByRole('dialog', { name: 'Mirror Buckets to Gmail' });
  await expect(explain).toContainText('never changes your own labels');
  await explain.getByRole('button', { name: 'Mirror Buckets' }).click();
  await expect(mirroring.getByRole('switch', { name: 'Mirror Buckets to Gmail' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // The email already in FYI gets its label, under Commander/.
  await expect.poll(() => commanderLabels(ids.offsite as string)).toEqual(['Commander/FYI']);
  expect(google.gmail.labelId(ALEX.email, 'Commander')).not.toBeNull();

  // The label changed in Gmail: the email follows to Newsletters in Commander, as the User's sort.
  const newsletters = google.gmail.createLabel(ALEX.email, 'Commander/Newsletters');
  google.gmail.relabel(ALEX.email, ids.offsite as string, {
    add: [newsletters],
    remove: [google.gmail.labelId(ALEX.email, 'Commander/FYI') as string],
  });
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  await section.getByRole('button', { name: 'Refresh' }).click();
  await expect(bucketOf(section, 'Offsite photos')).toHaveText('Newsletters');

  // A Bucket Rule sorts the digests into Newsletters, and Gmail shows it.
  await openSettings(window, 'Projects');
  await window.getByRole('button', { name: 'New Rule', exact: true }).click();
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await editor.getByRole('combobox', { name: 'Target' }).selectOption({ label: 'A Bucket (email)' });
  await editor.getByRole('combobox', { name: 'Sorts into' }).selectOption({ label: 'Newsletters' });
  await expect(
    editor.getByRole('combobox', { name: 'Value 1' }).getByRole('option', { name: 'digest.test' }),
  ).toBeAttached();
  await editor.getByRole('combobox', { name: 'Value 1' }).selectOption({ label: 'digest.test' });
  await editor.getByRole('button', { name: 'Save Rule' }).click();
  const offer = window.getByRole('dialog', { name: 'Re-sort existing emails' });
  await offer.getByRole('button', { name: 'Re-sort 2 emails' }).click();
  await expect.poll(() => commanderLabels(ids.digest as string)).toEqual(['Commander/Newsletters']);
  await expect.poll(() => commanderLabels(ids.update as string)).toEqual(['Commander/Newsletters']);

  // Settings → Buckets: Newsletters skips the inbox. Nothing is archived yet: Ares suggests it.
  await settingsPage(window, 'Email');
  await window.getByRole('switch', { name: 'Newsletters skips the inbox' }).click();
  await expect(window.getByRole('switch', { name: 'Newsletters skips the inbox' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(inInbox(ids.digest as string)).toBe(true);
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  await strip(section)
    .getByRole('tab', { name: /^Newsletters/ })
    .click();
  await expect(subjects(section)).toHaveCount(3);
  const suggestion = section.getByRole('region', { name: 'Skip the inbox' });
  await expect(suggestion).toContainText('Archive 3 Newsletters?');

  // Accept all: archived in Gmail.
  await suggestion.getByRole('button', { name: 'Accept all' }).click();
  await expect(section.getByRole('region', { name: 'Skip the inbox' })).toHaveCount(0);
  await expect
    .poll(() => [ids.digest, ids.update, ids.offsite].map((id) => inInbox(id as string)))
    .toEqual([false, false, false]);
  // Their Bucket labels stay.
  expect(commanderLabels(ids.digest as string)).toEqual(['Commander/Newsletters']);
});
