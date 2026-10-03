import { expect, type Locator, type Page, test } from '@playwright/test';
import { tab } from './frame';
import { launchCommander } from './launch-commander';

// Days as the app keys them: YYYY-MM-DD in local time, `offset` days from today.
const dayFrom = (page: Page, offset = 0) =>
  page.evaluate((days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }, offset);

const emptyDailyTemplate = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }));

// These tests write into an empty day, so the daily template is emptied before today's Daily Note is
// made (daily-template.spec.ts covers the template).
async function openNotes(window: Page) {
  await emptyDailyTemplate(window);
  await tab(window, 'Notes').click();
  const today = await dayFrom(window);
  const sheet = window.locator(`#day-${today}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

// A Daily Note's Blocks as shown: id, text, depth and whether folded, in outline order.
const shownBlocks = (page: Page, day: string) =>
  page.evaluate((key) => {
    const sheet = document.getElementById(`day-${key}`);
    return [...(sheet?.querySelectorAll<HTMLElement>('.n-blk[data-block]') ?? [])].map((block) => {
      let depth = 0;
      for (let up = block.parentElement?.closest('.n-blk'); up; up = up.parentElement?.closest('.n-blk'))
        depth++;
      const text = block.querySelector(':scope > .n-row [data-block-text]')?.textContent ?? '';
      return { id: block.dataset.block, text, depth, folded: block.classList.contains('folded') };
    });
  }, day);

const block = (sheet: Locator, text: string) =>
  sheet.locator('[data-block-text]', { hasText: new RegExp(`^${text}$`) });

// A Block's bullet, which folds it.
const bullet = (sheet: Locator, text: string) =>
  sheet
    .locator('.n-row')
    .filter({ has: sheet.page().locator('[data-block-text]', { hasText: new RegExp(`^${text}$`) }) })
    .locator('.n-bullet');

const latestActivity = (page: Page) =>
  page.evaluate(() =>
    window.commander.itemStore({ op: 'activity', query: { limit: 1 } }).then(([entry]) => entry),
  );

const blockTitles = (page: Page) =>
  page.evaluate(() =>
    window.commander
      .itemStore({ op: 'query', query: { kinds: ['block'] } })
      .then((items) => items.map((item) => item.title)),
  );

const dailyNoteDays = (page: Page) =>
  page.evaluate(() =>
    window.commander
      .itemStore({ op: 'daily-notes', query: {} })
      .then((found) => found.notes.map((note) => note.day)),
  );

// Seeds an earlier day's Daily Note with top-level Blocks, through the Item store as the window would.
const seedDay = (page: Page, day: string, texts: string[]) =>
  page.evaluate(
    async ({ day, texts }) => {
      const note = await window.commander.itemStore({ op: 'daily-note', day });
      await window.commander.itemStore({
        op: 'record-all',
        actions: texts.map((text, i) => ({
          type: 'create' as const,
          item: {
            kind: 'block' as const,
            title: text,
            detail: {
              kind: 'block' as const,
              dailyNoteId: note.id,
              parentId: null,
              position: `a${i}`,
              text,
              folded: false,
            },
          },
        })),
      });
    },
    { day, texts },
  );

test('Notes opens on today’s Daily Note: part number, rulers and numbered Blocks, in both themes', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const sheet = await openNotes(window);
  const year = new Date().getFullYear();

  await expect(window.locator('[data-testid=daily-note]').first()).toHaveAttribute(
    'data-day',
    await dayFrom(window),
  );
  await expect(sheet.locator('[data-slot=sheet-strip]')).toContainText('Today');
  await expect(sheet.locator('[data-slot=part-number]')).toHaveText(new RegExp(`^DN-${year}-\\d{3}$`));
  await expect(window.locator('[data-slot=ruler-x]')).toContainText('ABCDEFGH');
  await expect(window.locator('[data-slot=ruler-y]')).toContainText('24');
  await expect(sheet.locator('.n-bn').first()).toHaveText('001');
  await expect(window.getByTestId('week-strip')).toBeVisible();

  await window.getByRole('button', { name: 'Switch to light' }).click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(sheet.locator('[data-slot=part-number]')).toBeVisible();
  await expect(sheet.locator('.n-bn').first()).toHaveText('001');

  await commander.close();
});

test('a small outline written with the outliner keys is all back after a restart, ids, nesting and folds included', async () => {
  const first = await launchCommander();
  let window = await first.app.firstWindow();
  let sheet = await openNotes(window);
  const today = await dayFrom(window);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Morning');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Tab');
  await window.keyboard.type('Coffee');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Walk');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Shift+Tab');
  await window.keyboard.type('Evening');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Tab');
  await window.keyboard.type('Read');
  // Evening moves above Morning, taking Read with it.
  await block(sheet, 'Evening').click();
  await window.keyboard.press('Alt+Shift+ArrowUp');
  await expect
    .poll(() => shownBlocks(window, today).then((blocks) => blocks.map((b) => b.text)))
    .toEqual(['Evening', 'Read', 'Morning', 'Coffee', 'Walk']);
  // Fold Evening with Ctrl+. and Morning with its bullet.
  await window.keyboard.press('Control+.');
  await bullet(sheet, 'Morning').click();
  // Typed just before quitting, inside the pause: saved on the way out.
  await block(sheet, 'Morning').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' routine');

  const before = await shownBlocks(window, today);
  expect(before).toMatchObject([
    { text: 'Evening', depth: 0, folded: true },
    { text: 'Morning routine', depth: 0, folded: true },
  ]);
  await first.app.close();

  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  sheet = await openNotes(window);
  await expect.poll(() => shownBlocks(window, today)).toEqual(before);

  // Unfolded, the children come back with their ids, order and nesting.
  await bullet(sheet, 'Evening').click();
  await bullet(sheet, 'Morning routine').click();
  const after = await shownBlocks(window, today);
  expect(after.map(({ text, depth }) => [text, depth])).toEqual([
    ['Evening', 0],
    ['Read', 1],
    ['Morning routine', 0],
    ['Coffee', 1],
    ['Walk', 1],
  ]);
  expect(after.filter((b) => b.depth === 0).map((b) => b.id)).toEqual(before.map((b) => b.id));
  await second.close();
});

test('single-letter app shortcuts never fire while typing in a Block', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const sheet = await openNotes(window);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('3 , ? 1');

  await expect(sheet.locator('[data-block-text]').first()).toHaveText('3 , ? 1');
  await expect(window.getByTestId('header-title')).toHaveText('Daily Notes');
  await expect(window.getByTestId('cheat-sheet')).toHaveCount(0);
  await expect(window.getByTestId('settings')).toBeHidden();
  await commander.close();
});

test('the arrow keys move between Blocks, and Backspace on an empty Block removes it', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const sheet = await openNotes(window);
  const today = await dayFrom(window);
  const texts = () => shownBlocks(window, today).then((blocks) => blocks.map((b) => b.text));

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('First');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Second');
  await window.keyboard.press('ArrowUp');
  await window.keyboard.type('!');
  // Down keeps the caret's column; End takes it to the end of the line.
  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('End');
  await window.keyboard.type('?');
  await expect.poll(texts).toEqual(['First!', 'Second?']);

  await window.keyboard.press('Enter');
  await expect.poll(texts).toEqual(['First!', 'Second?', '']);
  await window.keyboard.press('Backspace');
  await expect.poll(texts).toEqual(['First!', 'Second?']);
  await window.keyboard.type(' still here');
  await expect.poll(texts).toEqual(['First!', 'Second? still here']);
  await commander.close();
});

test('structural changes go in the activity log, and undo reverses the last one, while editing or not', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const sheet = await openNotes(window);
  const today = await dayFrom(window);
  const depthOf = (text: string) =>
    shownBlocks(window, today).then((blocks) => blocks.find((b) => b.text === text)?.depth);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('One');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Two');
  await window.keyboard.press('Tab');
  await expect.poll(() => depthOf('Two')).toBe(1);
  await expect
    .poll(() => latestActivity(window))
    .toMatchObject({ action: 'update', why: 'Indent', by: { kind: 'user' } });

  // While editing: Ctrl+Z in the Block.
  await window.keyboard.press('Control+z');
  await expect.poll(() => depthOf('Two')).toBe(0);
  await expect.poll(() => latestActivity(window)).toMatchObject({ action: 'undo', by: { kind: 'user' } });

  // Not editing: the Section's own Ctrl+Shift+Z and Ctrl+Z.
  await window.keyboard.press('Escape');
  await expect(sheet.locator('[data-block-text]:focus')).toHaveCount(0);
  await window.keyboard.press('Control+Shift+z');
  await expect.poll(() => depthOf('Two')).toBe(1);
  await window.keyboard.press('Control+z');
  await expect.poll(() => depthOf('Two')).toBe(0);
  await expect.poll(() => latestActivity(window)).toMatchObject({ action: 'undo' });
  await commander.close();
});

test('earlier days follow today, newest first; the week strip jumps to a day, a blank one opens empty, and past days save edits', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const [yesterday, threeAgo, twoAgo] = [
    await dayFrom(window, -1),
    await dayFrom(window, -3),
    await dayFrom(window, -2),
  ];
  await seedDay(window, threeAgo, ['Three days back']);
  await seedDay(window, yesterday, ['Yesterday’s note']);
  await openNotes(window);

  await expect(window.locator('[data-testid=daily-note]')).toHaveCount(3);
  expect(
    await window
      .locator('[data-testid=daily-note]')
      .evaluateAll((days) => days.map((d) => d.getAttribute('data-day'))),
  ).toEqual([await dayFrom(window), yesterday, threeAgo]);

  // Jump with the week strip (stepping back a week if the day is in the last one).
  const strip = window.getByTestId('week-strip');
  const jump = async (day: string) => {
    if ((await strip.locator(`[data-day="${day}"]`).count()) === 0) {
      await strip.getByRole('button', { name: 'Previous week' }).click();
    }
    await strip.locator(`[data-day="${day}"]`).click();
  };
  await jump(threeAgo);
  await expect(window.locator(`#day-${threeAgo}`)).toBeInViewport();

  // Editing a past day saves.
  const past = window.locator(`#day-${threeAgo}`);
  await past.locator('[data-block-text]').first().click();
  await window.keyboard.press('End');
  await window.keyboard.type(', edited');
  await window.keyboard.press('Escape');
  await expect.poll(() => blockTitles(window)).toContain('Three days back, edited');

  // A day with nothing written opens blank and is only saved once something is typed.
  await jump(twoAgo);
  const blank = window.locator(`#day-${twoAgo}`);
  await expect(blank).toBeInViewport();
  const notesOn = () => dailyNoteDays(window);
  expect(await notesOn()).not.toContain(twoAgo);
  await blank.locator('[data-block-text]').first().click();
  await window.keyboard.type('Remembered later');
  await window.keyboard.press('Escape');
  await expect.poll(notesOn).toContain(twoAgo);
  await commander.close();
});
