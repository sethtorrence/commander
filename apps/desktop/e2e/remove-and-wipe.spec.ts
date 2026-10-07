import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { launchCommander } from './launch-commander';

// Removing an Account and wiping Commander (#204), end to end. Removal: a Google Account's mail,
// synced from a fake Google on this machine, leaves no trace in the database file, and a Todo made
// from it keeps its Link, shown as gone. Wipe: Settings → Data → Wipe all Commander data, after typing
// the word, deletes everything in the (throwaway) data folder and the Markdown copy's files if ticked,
// and Commander starts again as new. Every launch has its own throwaway data folder (--user-data-dir),
// so the keyring entry is never touched. Tokens are stored in the real keyring, so the removal needs
// the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

// Words the removed Account's mail is written with, found nowhere else.
const GONE = ['quokkafjord', 'zanzibarite', 'quillsworth'];

// The database file and its write-ahead log, byte by byte, as lower-case text.
const databaseBytes = (userDataDir: string) =>
  ['commander.db', 'commander.db-wal']
    .map((name) => join(userDataDir, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1').toLowerCase())
    .join('\n');

// Stands in for app.relaunch, so the relaunched Commander isn't left running outside the test: the
// test launches it again itself. Says on stdout when Commander asks for it.
const standInForRelaunch = (app: ElectronApplication) =>
  app.evaluate(({ app }) => {
    app.relaunch = () => {
      console.log('commander-e2e: relaunch requested');
    };
  });

const heard = (app: ElectronApplication, text: string) =>
  new Promise<void>((resolve) => {
    app.process().stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes(text)) resolve();
    });
  });

test('removing a Google Account leaves none of its mail in the database; a Todo made from it shows its Link as gone', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  test.setTimeout(120_000);
  const google: FakeGoogle = await startFakeGoogle();
  google.gmail.deliver(ALEX.email, {
    from: 'Ottoline Quillsworth <ottoline@quokkafjord.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Quokkafjord budget',
    text: 'The zanzibarite figures are attached.',
    date: Date.now() - 60 * 60_000,
    labels: ['INBOX'],
  });
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    gmailUrl: google.gmailUrl,
  };
  const commander = await launchCommander({ env: { COMMANDER_TEST_GOOGLE: JSON.stringify(config) } });
  try {
    const page = await commander.window();
    await commander.app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        await fetch(url);
      };
    });
    await openSettings(page, 'Accounts');
    const section = page.getByTestId('accounts-panel').getByTestId('source-google');
    await section.getByRole('button', { name: 'Connect Google' }).click();
    await expect(section.getByTestId('account-synced')).toHaveText(/1 email$/);

    // A Todo made from the email.
    const [mail] = await page.evaluate(() =>
      window.commander.itemStore({ op: 'query', query: { kinds: ['email'] } }),
    );
    expect(mail?.title).toBe('Quokkafjord budget');
    await page.evaluate(async (emailId) => {
      const store = window.commander.itemStore;
      const { itemId } = await store({
        op: 'record',
        action: {
          type: 'create',
          item: {
            kind: 'todo',
            title: 'Reply about the budget',
            detail: { kind: 'todo', origin: 'email', dueOn: null, backedBy: null },
          },
        },
      });
      await store({
        op: 'record',
        action: { type: 'link', from: itemId, linkType: 'made-from', to: emailId },
      });
    }, mail?.id as string);

    // Remove, after reading what it does and what stays in the snapshots.
    await section.getByTestId('account').getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByTestId('remove-account-dialog');
    await expect(dialog).toContainText('removes its emails and calendar events for good');
    await expect(dialog.getByTestId('remove-account-snapshots')).toContainText(
      'each of the last 7 daily snapshots until it ages out (up to 7 days)',
    );
    await expect(dialog.getByTestId('remove-account-snapshots')).toContainText(
      'Wipe all Commander data, in Settings → Data, removes everything at once.',
    );
    await page.getByRole('button', { name: 'Remove Google · alex@gmail.test' }).click();
    await expect(section.getByTestId('account')).toHaveCount(0);

    // The Todo stays, its Link to the email shown as gone.
    await page.keyboard.press('Escape');
    await tab(page, 'Todos').click();
    const todos = page.getByRole('region', { name: 'Todos' });
    await todos.getByText('Reply about the budget').click();
    const links = todos.getByRole('region', { name: 'Todo detail' }).getByRole('region', { name: 'Links' });
    await expect(links.getByRole('button')).toHaveText([
      /Made from\s*Removed with its Account\s*was in Gmail/,
    ]);
    await expect(links.getByRole('button')).toBeDisabled();
    const found = await page.evaluate(() =>
      window.commander.itemStore({ op: 'search', query: { text: 'Quokkafjord' } }),
    );
    expect(found.hits).toEqual([]);

    // Nothing of it is left in the database file.
    await commander.app.close();
    const bytes = databaseBytes(commander.userDataDir);
    expect(bytes).toContain('reply about the budget');
    for (const word of GONE) expect({ word, inFile: bytes.includes(word) }).toEqual({ word, inFile: false });
  } finally {
    await commander.close().catch(() => {});
    await google.close();
  }
});

// Blocks in today's Daily Note, through the Item store (the template left empty).
const writeBlock = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const store = window.commander.itemStore;
    await store({ op: 'save-daily-template', template: { blocks: [] } });
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const note = await store({ op: 'daily-note', day });
    await store({
      op: 'record',
      action: {
        type: 'create',
        item: {
          kind: 'block',
          title: text,
          detail: {
            kind: 'block',
            dailyNoteId: note.id,
            parentId: null,
            position: 'a0',
            text,
            folded: false,
          },
        },
      },
    });
  }, text);

const liveBlocks = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['block'] } }));

test('Wipe all Commander data deletes everything Commander keeps, the Markdown copy only when ticked, and starts again as new', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const vault = mkdtempSync(join(tmpdir(), 'commander-e2e-vault-'));
  const launched: ElectronApplication[] = [];
  const launch = async () => {
    const commander = await launchCommander({ userDataDir });
    launched.push(commander.app);
    return commander;
  };
  try {
    // What Commander keeps beside the database, as an earlier start left it.
    writeFileSync(join(userDataDir, 'secrets.json'), '{}');
    for (const folder of ['email-parts/google-1/m1', 'compose-files'])
      mkdirSync(join(userDataDir, folder), { recursive: true });
    writeFileSync(join(userDataDir, 'email-parts/google-1/m1/Agenda.pdf'), 'cached');
    writeFileSync(join(userDataDir, 'compose-files/1b4e28ba-2fa1-11d2-883f-0016d3cca427'), 'waiting');
    writeFileSync(join(vault, 'Ideas.md'), 'mine');

    const first = await launch();
    const page = await first.window();
    await writeBlock(page, 'Written before the wipe');
    await page.evaluate(() => localStorage.setItem('commander-e2e-wipe', 'set before the wipe'));
    // The Markdown copy, into the vault (the system picker stood in for).
    await first.app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never;
    }, vault);
    await openSettings(page, 'Data');
    const copy = page.getByTestId('markdown-copy');
    await copy.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(copy.getByTestId('markdown-copy-state')).toHaveText(/^Up to date/);
    await expect.poll(() => readdirSync(vault).filter((name) => name.endsWith('.md')).length).toBe(2);
    expect(existsSync(join(userDataDir, 'commander.db'))).toBe(true);
    expect(readdirSync(join(userDataDir, 'snapshots')).length).toBeGreaterThan(0);

    // Wipe, after typing the word; the Markdown copy is offered, unticked.
    const wipe = page.getByTestId('wipe-setting');
    await wipe.getByRole('button', { name: 'Wipe all Commander data…' }).click();
    const confirm = page.getByTestId('wipe-confirm');
    await expect(confirm).toContainText(vault);
    const tick = confirm.getByTestId('wipe-markdown-copy');
    await expect(tick).not.toBeChecked();
    const button = confirm.getByRole('button', { name: 'Wipe and relaunch' });
    await confirm.getByLabel(/to confirm/).fill('wiped');
    await expect(button).toBeDisabled();
    await confirm.getByLabel(/to confirm/).fill('wipe');
    await tick.check();

    await standInForRelaunch(first.app);
    const relaunchAsked = heard(first.app, 'commander-e2e: relaunch requested');
    const keyringLeft = heard(
      first.app,
      'Left the keyring entry: this Commander runs on a data folder of its own',
    );
    const closed = first.app.waitForEvent('close', { timeout: 30_000 });
    await button.click();
    await expect(page.getByTestId('wipe-relaunching')).toBeVisible();
    await relaunchAsked;
    await keyringLeft;
    await closed;

    // Everything Commander kept is gone; of the vault, only what the copy wrote.
    const left = readdirSync(userDataDir);
    for (const name of [
      'commander.db',
      'commander.db-wal',
      'snapshots',
      'attachments',
      'secrets.json',
      'email-parts',
      'compose-files',
      'models',
      'logs',
    ])
      expect({ name, left: left.includes(name) }).toEqual({ name, left: false });
    expect(readdirSync(vault)).toEqual(['Ideas.md']);

    // Relaunched: as new.
    const second = await launch();
    const fresh = await second.window();
    await expect(fresh.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    expect((await liveBlocks(fresh)).map((block) => block.title)).not.toContain('Written before the wipe');
    expect(await fresh.evaluate(() => localStorage.getItem('commander-e2e-wipe'))).toBeNull();
    await openSettings(fresh, 'Data');
    await expect(fresh.getByTestId('markdown-copy').getByTestId('markdown-copy-state')).toHaveText('Off');
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
