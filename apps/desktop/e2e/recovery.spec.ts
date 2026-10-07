import {
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { launchCommander } from './launch-commander';

// Database health on start (#203): a database that fails its check, or that this version couldn't
// update, opens the recovery screen instead of Commander, never a dead window or a Core restarting
// over and over. Restore relaunches Commander on the snapshot it offers; after a failed update,
// Export everything and Quit are there too. Every launch of a test uses the same throwaway folder.

const PAGE = 4096;

// A Block in today's Daily Note, through the Item store (the template left empty).
const writeBlock = (page: Page, text: string, position: string) =>
  page.evaluate(
    async ({ text, position }) => {
      const store = window.commander.itemStore;
      await store({ op: 'save-daily-template', template: { blocks: [] } });
      const date = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const note = await store({ op: 'daily-note', day });
      await store({
        op: 'record-all',
        actions: [
          {
            type: 'create',
            item: {
              id: crypto.randomUUID(),
              kind: 'block',
              title: text,
              detail: { kind: 'block', dailyNoteId: note.id, parentId: null, position, text, folded: false },
            },
          },
        ],
      });
    },
    { text, position },
  );

const blockTitles = (page: Page) =>
  page.evaluate(() =>
    window.commander
      .itemStore({ op: 'query', query: { kinds: ['block'] } })
      .then((items) => items.map((item) => item.title).sort()),
  );

// Stands in for app.relaunch, so the relaunched Commander isn't left running outside the test.
const standInForRelaunch = (app: ElectronApplication) =>
  app.evaluate(({ app }) => {
    app.relaunch = () => {
      console.log('commander-e2e: relaunch requested');
    };
  });

// Writes over B-tree pages of the closed database, as a failing disk might.
function damage(userDataDir: string) {
  const fd = openSync(join(userDataDir, 'commander.db'), 'r+');
  writeSync(fd, Buffer.alloc(PAGE * 30, 0x5a), 0, PAGE * 30, PAGE * 2);
  closeSync(fd);
}

// The built Core's migrations, plus one more that fails part-way.
function migrationsWithOneThatFails(into: string): { folder: string; tag: string } {
  const folder = join(into, 'migrations');
  cpSync(join(import.meta.dirname, '../out/main/migrations'), folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1) as (typeof journal.entries)[number];
  const tag = `${String(last.idx + 1).padStart(4, '0')}_fails_in_this_test`;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(
    join(folder, `${tag}.sql`),
    ['CREATE TABLE `half_made` (`id` text PRIMARY KEY NOT NULL);', 'SELECT * FROM no_such_table;'].join(
      '\n--> statement-breakpoint\n',
    ),
  );
  return { folder, tag };
}

test('a damaged database opens the recovery screen, and Restore brings back the latest good snapshot', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const launched: ElectronApplication[] = [];
  const launch = async () => {
    const commander = await launchCommander({ userDataDir });
    launched.push(commander.app);
    return commander;
  };
  try {
    // A note, then a start whose daily snapshot holds it, then a later note only the database has.
    const first = await launch();
    let page = await first.window();
    await writeBlock(page, 'In the snapshot', 'a0');
    await expect.poll(() => blockTitles(page)).toEqual(['In the snapshot']);
    await first.app.close();
    for (const name of readdirSync(join(userDataDir, 'snapshots')))
      if (/^commander-\d{4}-\d{2}-\d{2}\.db$/.test(name)) rmSync(join(userDataDir, 'snapshots', name));
    const second = await launch();
    page = await second.window();
    await writeBlock(page, 'Only in the damaged database', 'a1');
    await expect.poll(() => blockTitles(page)).toHaveLength(2);
    await second.app.close();
    damage(userDataDir);

    // The next start: the recovery screen, saying what happened, and Commander's Core never restarted.
    const third = await launch();
    page = await third.window();
    const screen = page.getByTestId('recovery-screen');
    await expect(screen).toBeVisible();
    await expect(screen).toHaveAttribute('data-state', 'damaged');
    await expect(screen.getByRole('heading')).toHaveText('Commander’s database is damaged');
    await expect(screen.getByTestId('recovery-offer')).toContainText('the daily snapshot of');
    await expect(page.getByTestId('core-banner')).toHaveCount(0);
    await expect(screen.getByRole('button', { name: /Export/ })).toHaveCount(0);
    // Anything else asked of the Core fails at once, in plain words.
    await expect(
      page.evaluate(() => window.commander.itemStore({ op: 'query', query: {} }).then(() => 'answered')),
    ).rejects.toThrow('Commander couldn’t open its database.');

    await standInForRelaunch(third.app);
    const closed = third.app.waitForEvent('close', { timeout: 30_000 });
    await screen.getByRole('button', { name: 'Restore the latest good snapshot' }).click();
    await expect(screen.getByTestId('recovery-relaunching')).toBeVisible();
    await closed;

    // Relaunched on the snapshot, with the damaged database kept aside.
    const fourth = await launch();
    page = await fourth.window();
    await expect(page.getByTestId('recovery-screen')).toHaveCount(0);
    await expect.poll(() => blockTitles(page)).toEqual(['In the snapshot']);
    expect(readdirSync(join(userDataDir, 'snapshots')).some((name) => name.includes('before-restore'))).toBe(
      true,
    );
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a migration that fails shows the failed-update screen: Restore, Export everything and Quit', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const scratch = mkdtempSync(join(tmpdir(), 'commander-e2e-update-'));
  const chosen = mkdtempSync(join(tmpdir(), 'commander-e2e-export-'));
  const launched: ElectronApplication[] = [];
  try {
    const first = await launchCommander({ userDataDir });
    launched.push(first.app);
    await writeBlock(await first.window(), 'Kept through the failed update', 'a0');
    await first.app.close();

    // The "new version": its migrations include one that fails.
    const { folder, tag } = migrationsWithOneThatFails(scratch);
    const second = await launchCommander({
      userDataDir,
      env: { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_MIGRATIONS_FOLDER: folder },
    });
    launched.push(second.app);
    const page = await second.window();
    const screen = page.getByTestId('recovery-screen');
    await expect(screen).toHaveAttribute('data-state', 'update-failed');
    await expect(screen.getByRole('heading')).toHaveText('Commander couldn’t update its database');
    await expect(screen).toContainText('Nothing was changed');
    await expect(screen).toContainText(tag);
    await expect(screen.getByTestId('recovery-problem')).toHaveText('no such table: no_such_table');
    await expect(screen.getByTestId('recovery-offer')).toContainText(
      'the snapshot taken just before the update',
    );
    await expect(screen.getByRole('button', { name: 'Restore the pre-update snapshot' })).toBeEnabled();

    // Export everything, into a folder from the system picker (stood in for).
    await second.app.evaluate(({ dialog }, into) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [into] })) as never;
    }, chosen);
    await screen.getByRole('button', { name: 'Export everything…' }).click();
    await expect(screen.getByTestId('recovery-export-done')).toBeVisible();
    const [exported] = readdirSync(chosen);
    expect(readdirSync(join(chosen, exported as string)).sort()).toEqual(['README.txt', 'commander.db']);

    // Quit ends Commander.
    const closed = second.app.waitForEvent('close', { timeout: 30_000 });
    await screen.getByRole('button', { name: 'Quit' }).click();
    await closed;

    // The database is as the previous version left it: that version opens it, the note there.
    const third = await launchCommander({ userDataDir });
    launched.push(third.app);
    const back = await third.window();
    await expect(back.getByTestId('recovery-screen')).toHaveCount(0);
    await expect.poll(() => blockTitles(back)).toEqual(['Kept through the failed update']);
    expect(existsSync(join(userDataDir, 'restore-pending.json'))).toBe(false);
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    for (const path of [userDataDir, scratch, chosen]) rmSync(path, { recursive: true, force: true });
  }
});
