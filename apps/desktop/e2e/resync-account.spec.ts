import { expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Re-sync end to end (#205), against a fake Google and Gmail on this machine (never the real ones):
// the User files an email into a Project, sorts it into a Bucket and makes a Todo from it (a made-from
// Link); then Re-sync in Settings → Accounts, after its confirmation, reads the Account again from
// scratch (the 30-day download's path), bringing what changed in Gmail meanwhile, and the Link, the
// filing and the Bucket are still on the same email, with no email twice. Tokens are stored in the
// real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DAY = 86_400_000;
const HOUR = 3_600_000;

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  const now = Date.now();
  google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: now - 2 * DAY,
  });
  google.gmail.deliver(ALEX.email, {
    from: 'Shop <orders@shop.test>',
    to: ALEX.email,
    subject: 'Your order has shipped',
    text: 'Your order is on its way.',
    date: now - 3 * HOUR,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
});

async function connectGoogle(window: Page) {
  await commander?.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  await openSettings(window, 'Accounts');
  const section = window.getByTestId('accounts-panel').getByTestId('source-google');
  await section.getByRole('button', { name: 'Connect Google' }).click();
  await expect(section.getByTestId('account-status')).toHaveText('Connected');
  return section;
}

// What the User made of Dana's email: filed into Longtail, sorted into Needs reply, and a Todo made
// from it. Returns the email's id, and Gmail's.
function arrange(page: Page) {
  return page.evaluate(async () => {
    const store = window.commander.itemStore;
    const emails = await store({ op: 'query', query: { kinds: ['email'] } });
    const dana = emails.find((item) => item.title === 'Q4 offsite dates');
    if (!dana) throw new Error('Dana’s email is missing');
    const { project } = await store({
      op: 'change-project',
      action: { type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } },
    });
    const entries = await store({
      op: 'record-all',
      actions: [
        {
          type: 'update',
          itemId: dana.id,
          changes: { filing: { projectId: project?.id ?? '', filedBy: 'user' } },
        },
        {
          type: 'edit-fields',
          itemId: dana.id,
          fields: { bucket: { bucketId: 'needs-reply', sortedBy: 'user' } },
        },
        {
          type: 'create',
          item: {
            kind: 'todo',
            title: 'Reply to Dana about the offsite',
            detail: { kind: 'todo', origin: 'email', dueOn: null, backedBy: null },
          },
        },
      ],
    });
    // The Todo's creation is the last entry.
    const todo = entries.at(-1)?.itemId ?? '';
    await store({ op: 'record', action: { type: 'link', from: todo, linkType: 'made-from', to: dana.id } });
    return { id: dana.id, externalId: dana.externalId ?? '' };
  });
}

// Every email Commander holds, and what the User made of Dana's.
function look(page: Page, danaId: string) {
  return page.evaluate(async (id) => {
    const store = window.commander.itemStore;
    const emails = await store({ op: 'query', query: { kinds: ['email'] } });
    const view = await store({ op: 'get', itemId: id });
    const detail = view?.item.detail;
    return {
      emails: emails
        .map((item) => ({ id: item.id, title: item.title }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      filedBy: view?.item.filing?.filedBy ?? null,
      bucket: detail?.kind === 'email' ? (detail.bucket ?? null) : null,
      read: detail?.kind === 'email' ? detail.read : null,
      backlinks: (view?.backlinks ?? []).map((link) => `${link.type} ${link.from.title}`),
    };
  }, danaId);
}

test('Re-sync an Account: confirmed, read again from scratch, and the Link, filing and Bucket survive', async () => {
  test.setTimeout(90_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_GOOGLE: JSON.stringify({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        authorizeUrl: google.authorizeUrl,
        tokenUrl: google.tokenUrl,
        userinfoUrl: google.userinfoUrl,
        gmailUrl: google.gmailUrl,
      }),
    },
  });
  const window = await commander.window();
  const section = await connectGoogle(window);
  await expect(section.getByTestId('account-synced')).toHaveText(/^Synced \d\d:\d\d · 2 emails$/);

  const { id: danaId, externalId: danaMessage } = await arrange(window);
  const before = await look(window, danaId);
  expect(before).toMatchObject({
    filedBy: 'user',
    bucket: { bucketId: 'needs-reply', sortedBy: 'user' },
    read: false,
    backlinks: ['made-from Reply to Dana about the offsite'],
  });

  // Meanwhile in Gmail: Dana's email was read, and new mail came.
  google.gmail.relabel(ALEX.email, danaMessage, { remove: ['UNREAD'] });
  google.gmail.deliver(ALEX.email, {
    from: 'Priya Patel <priya@contoso.test>',
    to: ALEX.email,
    subject: 'Staging certificate',
    text: 'The staging certificate expires on Friday.',
    date: Date.now() - HOUR,
  });
  const asked = google.gmail.requests.length;

  // Re-sync asks first, saying nothing of the User's is lost; Cancel does nothing.
  await section.getByRole('button', { name: 'Re-sync', exact: true }).click();
  const dialog = window.getByTestId('resync-account-dialog');
  await expect(dialog).toContainText(`Re-sync Google · ${ALEX.email}?`);
  await expect(dialog).toContainText('Nothing of yours is lost');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(google.gmail.requests.slice(asked).some((path) => path.includes('/profile'))).toBe(false);

  await section.getByRole('button', { name: 'Re-sync', exact: true }).click();
  await dialog.getByRole('button', { name: `Re-sync Google · ${ALEX.email}` }).click();
  await expect(dialog).toHaveCount(0);

  // It reads the window again, as the first download does (Gmail's profile, then the listing), and
  // fetches only the message it doesn't hold.
  await expect(section.getByTestId('account-synced')).toHaveText(/^Synced \d\d:\d\d · 3 emails$/);
  await expect(section.getByTestId('account-next-sync')).toHaveText(/^Next sync /);
  const since = google.gmail.requests.slice(asked);
  expect(since.some((path) => path.includes('/profile'))).toBe(true);
  expect(since.some((path) => path.includes('/messages?') && path.includes('after'))).toBe(true);
  expect(since.filter((path) => /\/messages\/[^/?]+\?format=full/.test(path))).toHaveLength(1);

  // Nothing of the User's is lost, and nothing doubles.
  const after = await look(window, danaId);
  expect(after).toEqual({ ...before, read: true, emails: expect.any(Array) });
  expect(after.emails).toHaveLength(3);
  expect(after.emails).toEqual(expect.arrayContaining(before.emails));
  expect(after.emails.map((email) => email.title).sort()).toEqual([
    'Q4 offsite dates',
    'Staging certificate',
    'Your order has shipped',
  ]);
});
