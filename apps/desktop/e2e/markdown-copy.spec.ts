import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The read-only Markdown copy of the Daily Notes (#53): Settings → Notes → Markdown copy folder, chosen
// with the system folder picker (stood in for here, from the main process), and the files the Core
// writes there.

const NOTICE = '<!-- Read-only copy written by Commander. Edits here are overwritten. -->';
const PAST_DAY = '2026-09-01';

let commander: LaunchedCommander;
let vault: string;

test.beforeEach(async () => {
  commander = await launchCommander();
  vault = mkdtempSync(join(tmpdir(), 'commander-e2e-vault-'));
});

test.afterEach(async () => {
  await commander.close();
  rmSync(vault, { recursive: true, force: true });
});

// The system folder picker answers with this folder, as if the User had chosen it.
const pickerChooses = (app: ElectronApplication, folder: string) =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never;
  }, folder);

const today = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });

const fileIn = (name: string) => {
  const path = join(vault, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

// A past day with a heading filed under a Project, nesting, formatting, a ticked Todo, a day link, a
// Project link and an image. Returns the image's file name.
const writePastDay = (page: Page) =>
  page.evaluate(async (day) => {
    const store = window.commander.itemStore;
    const { project } = await store({
      op: 'change-project',
      action: { type: 'create', project: { name: 'Longtail', code: 'LT', accent: 'blue' } },
    });
    if (!project) throw new Error('No Project');
    const note = await store({ op: 'daily-note', day });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { name } = await store({ op: 'save-attachment', bytes });
    const [heading, standUp, todoBlock, link, image, todo] = Array.from({ length: 6 }, () =>
      crypto.randomUUID(),
    ) as [string, string, string, string, string, string];
    const block = (id: string, text: string, parentId: string | null, position: string) => ({
      type: 'create' as const,
      item: {
        id,
        kind: 'block' as const,
        title: text,
        detail: { kind: 'block' as const, dailyNoteId: note.id, parentId, position, text, folded: false },
      },
    });
    const meetings = block(heading, '# Meetings', null, 'a0');
    await store({
      op: 'record-all',
      actions: [
        { ...meetings, item: { ...meetings.item, filing: { projectId: project.id, filedBy: 'user' } } },
        block(standUp, 'Stand-up with **Ana**', heading, 'a0'),
        block(link, `See [[2026-09-02]] and [[project:${project.id}]]`, standUp, 'a0'),
        block(todoBlock, 'Send the deck', heading, 'a1'),
        {
          type: 'create',
          item: {
            id: todo,
            kind: 'todo',
            title: 'Send the deck',
            status: 'done',
            detail: { kind: 'todo', origin: 'daily-note', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: todo, linkType: 'made-from', to: todoBlock },
        block(image, `![](attachments/${name})`, null, 'a1'),
      ],
    });
    return name;
  }, PAST_DAY);

test('choosing a folder writes each day; edits rewrite it within seconds, over any hand edits', async () => {
  const page = await commander.window();
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  const image = await writePastDay(page);
  writeFileSync(join(vault, 'My own note.md'), 'mine');

  // Nothing is written until a folder is chosen.
  await openSettings(page);
  const setting = page.getByTestId('markdown-copy');
  await expect(setting.getByTestId('markdown-copy-folder')).toHaveText('None chosen');
  await expect(setting.getByTestId('markdown-copy-state')).toHaveText('Off');
  expect(readdirSync(vault)).toEqual(['My own note.md']);

  await pickerChooses(commander.app, vault);
  await setting.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(setting.getByTestId('markdown-copy-folder')).toHaveText(vault);
  await expect(setting.getByTestId('markdown-copy-state')).toHaveText(/^Up to date/);

  expect(fileIn(`${PAST_DAY}.md`)).toBe(
    [
      NOTICE,
      '',
      '# Meetings #LT',
      '',
      '- Stand-up with **Ana**',
      '\t- See [[2026-09-02]] and [[Longtail]]',
      '- [x] Send the deck',
      '',
      `- ![](attachments/${image})`,
      '',
    ].join('\n'),
  );
  expect(readdirSync(join(vault, 'attachments'))).toEqual([image]);
  // Only days with something written get a file (2026-09-02 is just a link's target), and nothing
  // else in the folder is touched.
  expect(readdirSync(vault).sort()).toEqual([`${PAST_DAY}.md`, 'My own note.md', 'attachments']);
  expect(fileIn('My own note.md')).toBe('mine');

  // Writing in today's Daily Note writes today's file, a moment later.
  const day = await today(page);
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${day}`);
  await sheet.locator('[data-block-text]').first().click();
  await page.keyboard.type('Written today');
  await expect.poll(() => fileIn(`${day}.md`), { timeout: 15_000 }).toBe(`${NOTICE}\n\n- Written today\n`);

  // A hand edit changes nothing in Commander, and the next write overwrites it.
  writeFileSync(join(vault, `${day}.md`), '- Edited by hand\n');
  await page.keyboard.type(', and again');
  await expect
    .poll(() => fileIn(`${day}.md`), { timeout: 15_000 })
    .toBe(`${NOTICE}\n\n- Written today, and again\n`);
  await expect(sheet.locator('[data-block-text]').first()).toHaveText('Written today, and again');

  // Turned off, nothing more is written.
  await openSettings(page);
  await setting.getByRole('button', { name: 'Turn off' }).click();
  await expect(setting.getByTestId('markdown-copy-state')).toHaveText('Off');
});

test('a folder that can’t be written shows a notice in Settings, and editing carries on', async () => {
  const page = await commander.window();
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await openSettings(page);
  const setting = page.getByTestId('markdown-copy');
  await pickerChooses(commander.app, vault);
  await setting.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(setting.getByTestId('markdown-copy-state')).toHaveText(/^Up to date/);

  // The folder goes away (a disk unplugged, say).
  rmSync(vault, { recursive: true, force: true });
  const day = await today(page);
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${day}`);
  await sheet.locator('[data-block-text]').first().click();
  await page.keyboard.type('Still saved');
  await expect
    .poll(
      () =>
        page.evaluate(async () =>
          (await window.commander.itemStore({ op: 'query', query: { kinds: ['block'] } })).map(
            (b) => b.title,
          ),
        ),
      { timeout: 15_000 },
    )
    .toContain('Still saved');

  await openSettings(page);
  await expect(setting.getByTestId('markdown-copy-problem')).toContainText(vault, { timeout: 15_000 });
  await expect(setting.getByTestId('markdown-copy-problem')).toContainText('can’t be found');
  await expect(setting.getByTestId('markdown-copy-state')).toHaveText('Not writing');
});

test('Commander’s own data folder is refused, with the reason', async () => {
  const page = await commander.window();
  await openSettings(page);
  const setting = page.getByTestId('markdown-copy');
  await pickerChooses(commander.app, commander.userDataDir);
  await setting.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(setting.getByTestId('markdown-copy-refused')).toContainText('Commander’s own data folder');
  await expect(setting.getByTestId('markdown-copy-state')).toHaveText('Off');
});
