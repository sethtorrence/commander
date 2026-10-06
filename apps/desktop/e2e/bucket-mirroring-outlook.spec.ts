import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Mirror Buckets in Outlook (#142) end to end, against a fake Microsoft identity platform and Graph on
// this machine (never the real ones): switching mirroring on first signs in again asking for
// MailboxSettings.ReadWrite (Grant access); then a sort puts a "Commander: <Bucket>" category on the
// message beside the User's own, made in the master list in Outlook's colours; and a Commander category
// changed in Outlook moves the email's Bucket in Commander. Tokens are stored in the real keyring, so
// these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const HOUR = 60 * 60_000;
const ME = { name: SAM.displayName, address: SAM.userPrincipalName };

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;
let offsite: string;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  offsite = microsoft.mail.deliver(SAM.id, {
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [ME],
    subject: 'Offsite photos',
    text: 'The photos from the offsite are up.',
    date: Date.now() - HOUR,
    categories: ['Blue category'],
  });
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

async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, login) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(login)) await fetch(url);
    };
  }, microsoft.loginUrl);
}

const row = (section: Locator, subject: string) =>
  section.getByTestId('email-thread').filter({ has: section.page().getByText(subject, { exact: true }) });
const bucketOf = (section: Locator, subject: string) => row(section, subject).locator('[data-slot="bucket"]');

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

test('Grant access → mirroring on → sort → category appears → category changed in Outlook → Bucket follows', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);

  await openSettings(window, 'Accounts');
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(outlook.getByTestId('account-status').first()).toHaveText('Connected');
  expect(microsoft.authorizeRequests.at(-1)?.scope).not.toContain('MailboxSettings');

  // Mirror Buckets to Outlook: Grant access asks Microsoft for MailboxSettings.ReadWrite first.
  const mirroring = outlook.getByTestId('bucket-mirroring');
  await expect(mirroring).toContainText(
    'Commander’s Buckets may differ from how you organise mail in Outlook',
  );
  await mirroring.getByRole('switch', { name: 'Mirror Buckets to Outlook' }).click();
  const explain = window.getByRole('dialog', { name: 'Mirror Buckets to Outlook' });
  await expect(explain).toContainText('MailboxSettings.ReadWrite');
  await explain.getByRole('button', { name: 'Grant access and mirror' }).click();
  await expect(mirroring.getByRole('switch', { name: 'Mirror Buckets to Outlook' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(microsoft.authorizeRequests.at(-1)?.scope).toContain('MailboxSettings.ReadWrite');

  // A sort: the category goes on beside the User's own, made in the master list with a preset colour.
  await window.keyboard.press('Escape');
  await tab(window, 'Email').click();
  const section = window.getByTestId('section-email');
  await expect(row(section, 'Offsite photos')).toBeVisible();
  await moveTo(window, section, 'Offsite photos', 'FYI');
  await expect
    .poll(() => microsoft.mail.categoriesOf(SAM.id, offsite))
    .toEqual(['Blue category', 'Commander: FYI']);
  expect(microsoft.mail.masterCategories(SAM.id)).toEqual([
    expect.objectContaining({ displayName: 'Commander: FYI', color: 'preset2' }),
  ]);

  // Changed in Outlook: the email follows to Receipts in Commander.
  microsoft.mail.setCategories(SAM.id, offsite, ['Blue category', 'Commander: Receipts']);
  await section.getByRole('button', { name: 'Refresh' }).click();
  await expect(bucketOf(section, 'Offsite photos')).toHaveText('Receipts');
});
