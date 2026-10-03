import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, tab } from './frame';
import { launchCommander } from './launch-commander';

// The daily template: each Daily Note made as today starts from it; Settings → Notes edits it.

const DEFAULTS = ['Morning', 'Meetings', 'Todos', 'Ideas', 'Evening'];

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// The Blocks shown in a container (a day's sheet, or the template editor): id, text and depth.
const shownBlocks = (container: Locator) =>
  container.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('.n-blk[data-block]')].map((block) => {
      let depth = 0;
      for (let up = block.parentElement?.closest('.n-blk'); up; up = up.parentElement?.closest('.n-blk'))
        depth++;
      const text = block.querySelector(':scope > .n-row [data-block-text]')?.textContent ?? '';
      return { id: block.dataset.block ?? '', text, depth };
    }),
  );
const outlineOf = async (container: Locator) =>
  (await shownBlocks(container)).map(({ text, depth }) => `${'  '.repeat(depth)}${text}`);

const block = (container: Locator, text: string) =>
  container.locator('[data-block-text]', { hasText: new RegExp(`^${text}$`) });

// The titles of a day's saved Blocks.
const savedBlockTitles = (page: Page, day: string) =>
  page.evaluate(async (key) => {
    const { notes } = await window.commander.itemStore({ op: 'daily-notes', query: { from: key, to: key } });
    const id = notes[0]?.item.id;
    if (!id) return [];
    return (await window.commander.itemStore({ op: 'blocks', dailyNoteIds: [id] })).map((b) => b.title);
  }, day);

const savedTemplate = (page: Page) =>
  page.evaluate(() => window.commander.itemStore({ op: 'daily-template' }));

const savedOutline = (page: Page) =>
  savedTemplate(page).then(({ blocks }) => {
    const lines: string[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const b of blocks
        .filter((x) => x.parentId === parentId)
        .sort((x, y) => (x.position < y.position ? -1 : 1))) {
        lines.push(`${'  '.repeat(depth)}${b.text}`);
        walk(b.id, depth + 1);
      }
    };
    walk(null, 0);
    return lines;
  });

test('on a fresh database, today’s Daily Note starts with Morning, Meetings, Todos, Ideas and Evening', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await tab(window, 'Notes').click();
  const today = await window.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

  await expect.poll(() => outlineOf(window.locator(`#day-${today}`))).toEqual(DEFAULTS);
  await commander.close();
});

test('the template edited in Settings makes the next day, at midnight while running, and leaves today alone', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  // The window's clock, two minutes before midnight, so the test can move it past midnight.
  const lateEvening = new Date(2026, 10, 10, 23, 58);
  const [today, tomorrow] = [keyOf(lateEvening), keyOf(new Date(2026, 10, 11))];
  await window.clock.install({ time: lateEvening });
  await window.reload();

  await tab(window, 'Notes').click();
  const todaySheet = window.locator(`#day-${today}`);
  await expect.poll(() => outlineOf(todaySheet)).toEqual(DEFAULTS);
  const todayBefore = await shownBlocks(todaySheet);

  // Settings → Notes → Daily template, in the same outliner: add and nest, remove, retype.
  await openSettings(window);
  const editor = window.getByTestId('daily-template');
  await expect.poll(() => outlineOf(editor)).toEqual(DEFAULTS);
  await block(editor, 'Morning').click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Coffee');
  await window.keyboard.press('Tab');
  await block(editor, 'Ideas').click();
  await window.keyboard.press('End');
  for (let i = 0; i <= 'Ideas'.length; i++) await window.keyboard.press('Backspace');
  await block(editor, 'Evening').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' review');
  await window.keyboard.press('Escape');
  const edited = ['Morning', '  Coffee', 'Meetings', 'Todos', 'Evening review'];
  await expect.poll(() => outlineOf(editor)).toEqual(edited);
  await expect.poll(() => savedOutline(window)).toEqual(edited);

  // Today keeps what it started with.
  await tab(window, 'Notes').click();
  expect(await shownBlocks(todaySheet)).toEqual(todayBefore);

  // Past midnight while running, the new day comes in on top, made from the edited template.
  await window.clock.fastForward('03:00');
  const tomorrowSheet = window.locator(`#day-${tomorrow}`);
  await expect.poll(() => outlineOf(tomorrowSheet)).toEqual(edited);
  await expect(window.locator('[data-testid=daily-note]').first()).toHaveAttribute('data-day', tomorrow);
  expect(await shownBlocks(todaySheet)).toEqual(todayBefore);

  // Its Blocks are Items of its own, not the template's Blocks.
  const templateIds = (await savedTemplate(window)).blocks.map((b) => b.id);
  const newIds = (await shownBlocks(tomorrowSheet)).map((b) => b.id);
  for (const id of newIds) {
    expect(templateIds).not.toContain(id);
    expect(todayBefore.map((b) => b.id)).not.toContain(id);
  }
  // Editing the new day leaves the template alone.
  await block(tomorrowSheet, 'Meetings').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' at 10');
  await window.keyboard.press('Escape');
  await expect.poll(() => outlineOf(tomorrowSheet)).toContain('Meetings at 10');
  expect(await savedOutline(window)).toEqual(edited);
  await commander.close();
});

test('a blank past day opened from the week strip starts empty', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await tab(window, 'Notes').click();
  const twoAgo = await window.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await expect(window.locator('[data-testid=daily-note]').first().locator('.n-blk[data-block]')).toHaveCount(
    DEFAULTS.length,
  );

  const strip = window.getByTestId('week-strip');
  if ((await strip.locator(`[data-day="${twoAgo}"]`).count()) === 0) {
    await strip.getByRole('button', { name: 'Previous week' }).click();
  }
  await strip.locator(`[data-day="${twoAgo}"]`).click();
  const blank = window.locator(`#day-${twoAgo}`);
  await expect(blank).toBeInViewport();
  expect(await shownBlocks(blank)).toEqual([]);

  // Writing in it makes its Daily Note, still without the template.
  await blank.locator('[data-block-text]').first().click();
  await window.keyboard.type('Remembered later');
  await window.keyboard.press('Escape');
  await expect.poll(() => outlineOf(blank)).toEqual(['Remembered later']);
  expect(await savedBlockTitles(window, twoAgo)).toEqual(['Remembered later']);
  await commander.close();
});
