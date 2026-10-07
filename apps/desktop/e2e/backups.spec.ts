import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';

// Backups you can restore (#202): Settings → Data lists the snapshots; Restore (typed confirmation)
// relaunches Commander, which comes back on the older data with the database as it was kept aside;
// Export everything writes into a folder from the system picker (stood in for here). Every launch
// uses the same throwaway data folder.

// Days as the app keys them: YYYY-MM-DD in local time.
const today = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });

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

// Stands in for app.relaunch, so the relaunched Commander isn't left running outside the test: the
// test launches it again itself. Says on stdout when Commander asks for it.
const standInForRelaunch = (app: ElectronApplication) =>
  app.evaluate(({ app }) => {
    app.relaunch = () => {
      console.log('commander-e2e: relaunch requested');
    };
  });

test('restoring a snapshot relaunches Commander on the older data, with the newer kept aside', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'commander-e2e-'));
  const launched: ElectronApplication[] = [];
  const launch = async () => {
    const commander = await launchCommander({ userDataDir });
    launched.push(commander.app);
    return commander;
  };
  try {
    // The first start: a note, then quit.
    const first = await launch();
    let page = await first.window();
    await writeBlock(page, 'Written before the snapshot', 'a0');
    await expect.poll(() => blockTitles(page)).toEqual(['Written before the snapshot']);
    await first.app.close();
    // Today's snapshot was taken when that Commander started, before the note. Removing it here has
    // the next start take one with the note in it, as a later day's snapshot would be.
    for (const name of readdirSync(join(userDataDir, 'snapshots')))
      if (/^commander-\d{4}-\d{2}-\d{2}\.db$/.test(name)) rmSync(join(userDataDir, 'snapshots', name));

    // The next start: its snapshot holds the note; then something written after it.
    const second = await launch();
    page = await second.window();
    await writeBlock(page, 'Written after the snapshot', 'a1');
    await expect
      .poll(() => blockTitles(page))
      .toEqual(['Written after the snapshot', 'Written before the snapshot']);

    await openSettings(page, 'Data');
    const snapshot = page
      .getByTestId('snapshot')
      .filter({ has: page.getByTestId('snapshot-kind').getByText('Daily') });
    await expect(snapshot).toHaveCount(1);
    await snapshot.getByRole('button', { name: /^Restore/ }).click();
    const confirm = page.getByTestId('restore-confirm');
    const restore = confirm.getByRole('button', { name: 'Restore and relaunch' });
    await expect(restore).toBeDisabled();
    await confirm.getByLabel(/to confirm/).fill('restore');

    await standInForRelaunch(second.app);
    const relaunchAsked = new Promise<void>((resolve) => {
      second.app.process().stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('commander-e2e: relaunch requested')) resolve();
      });
    });
    const closed = second.app.waitForEvent('close', { timeout: 30_000 });
    await restore.click();
    await expect(page.getByTestId('restore-relaunching')).toBeVisible();
    await relaunchAsked;
    await closed;

    // Relaunched: the older data, and the database as it was kept aside as the newest snapshot.
    const third = await launch();
    page = await third.window();
    await expect.poll(() => blockTitles(page)).toEqual(['Written before the snapshot']);
    expect(existsSync(join(userDataDir, 'restore-pending.json'))).toBe(false);
    await openSettings(page, 'Data');
    await expect(page.getByTestId('snapshot').first().getByTestId('snapshot-kind')).toHaveText(
      'Before restore',
    );
    await expect(page.getByTestId('restore-done')).toContainText('Restored the daily snapshot of');
    const aside = readdirSync(join(userDataDir, 'snapshots')).filter((name) =>
      name.startsWith('commander-before-restore-'),
    );
    expect(aside).toHaveLength(1);
  } finally {
    for (const app of launched) await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Export everything writes the database, the notes and a README into the folder chosen, never a secret', async () => {
  const commander = await launchCommander();
  const chosen = mkdtempSync(join(tmpdir(), 'commander-e2e-export-'));
  try {
    const page = await commander.window();
    await writeBlock(page, 'Exported note', 'a0');
    await commander.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as never;
    }, chosen);

    await openSettings(page, 'Data');
    const exporting = page.getByTestId('export-setting');
    await exporting.getByRole('button', { name: 'Export everything…' }).click();
    await expect(exporting.getByTestId('export-done')).toBeVisible();
    const folder = (await exporting.getByTestId('export-folder').textContent()) ?? '';
    expect(folder.startsWith(join(chosen, 'Commander export '))).toBe(true);

    const files = readdirSync(folder, { recursive: true, encoding: 'utf8' });
    expect(files).toEqual(
      expect.arrayContaining(['commander.db', 'README.txt', join('Daily Notes', `${await today(page)}.md`)]),
    );
    expect(files.some((name) => /secrets|Local State|Cookies/.test(name))).toBe(false);
    expect(readFileSync(join(folder, 'Daily Notes', `${await today(page)}.md`), 'utf8')).toContain(
      'Exported note',
    );
  } finally {
    await commander.close();
    rmSync(chosen, { recursive: true, force: true });
  }
});
