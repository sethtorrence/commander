import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { tab } from './frame';
import { launchCommander } from './launch-commander';

// Block formatting (Markdown in the Block's text, rendered in the row), links opening in the system
// browser, and pasted images saved next to the database.

const today = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });

// These tests write into an empty day, so the daily template is emptied before today's Daily Note is made.
async function openNotes(window: Page) {
  await window.evaluate(() =>
    self.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await tab(window, 'Notes').click();
  const sheet = window.locator(`#day-${await today(window)}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

// The stored text of each of today's Blocks, from the Item store.
const storedTexts = (page: Page) =>
  page.evaluate(async () => {
    const items = await window.commander.itemStore({ op: 'query', query: { kinds: ['block'] } });
    return items.map((item) => (item.detail?.kind === 'block' ? item.detail.text : '')).sort();
  });

const row = (sheet: Locator, n: number) => sheet.locator('.n-blk[data-block]').nth(n);
const text = (sheet: Locator, n: number) => row(sheet, n).locator('[data-block-text]');

// Stops editing, so the rendered view (marks hidden) shows.
const stopEditing = (window: Page) => window.keyboard.press('Escape');

// Lets the next links "open" into a list instead of the system browser, in the main process.
async function catchOpenedLinks(app: import('@playwright/test').ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedLinks?: string[] }).openedLinks = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { openedLinks?: string[] }).openedLinks ?? []);
}

// Pastes into the focused Block, as the clipboard would: images made on a canvas, or text.
const paste = (page: Page, what: { images?: ('image/png' | 'image/jpeg')[]; text?: string }) =>
  page.evaluate(async ({ images = [], text }) => {
    const data = new DataTransfer();
    for (const [i, type] of images.entries()) {
      const canvas = document.createElement('canvas');
      canvas.width = 160 + i * 40;
      canvas.height = 90;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      context.fillStyle = i % 2 ? '#1b1c1e' : '#ff5f00';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), type));
      data.items.add(new File([blob], `shot-${i}.${type.slice(6)}`, { type }));
    }
    if (text !== undefined) data.setData('text/plain', text);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, what);

test('each kind of formatting types with its Markdown and with its shortcut, shows in both themes, and survives a restart', async () => {
  const first = await launchCommander();
  let window = await first.app.firstWindow();
  let sheet = await openNotes(window);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('# Morning');
  await window.keyboard.press('Enter');
  await window.keyboard.type('## Plans');
  await window.keyboard.press('Enter');
  await window.keyboard.type('### Later');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Typed **bold**, *italic* and `code`');
  await window.keyboard.press('Enter');
  // The shortcuts: with nothing selected they open a pair to type into; on a selection they wrap it.
  await window.keyboard.press('Control+b');
  await window.keyboard.type('strong');
  await window.keyboard.press('End');
  await window.keyboard.type(' ');
  await window.keyboard.press('Control+i');
  await window.keyboard.type('slanted');
  await window.keyboard.press('End');
  await window.keyboard.type(' run ');
  await window.keyboard.type('npm test');
  for (let i = 0; i < 8; i++) await window.keyboard.press('Shift+ArrowLeft');
  await window.keyboard.press('Control+e');
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('#LT is the Project shorthand, not a heading');

  const expected = [
    '# Morning',
    '## Plans',
    '### Later',
    'Typed **bold**, *italic* and `code`',
    '**strong** *slanted* run `npm test`',
    '#LT is the Project shorthand, not a heading',
  ];
  await expect.poll(() => storedTexts(window)).toEqual([...expected].sort());

  const check = async () => {
    await expect(row(sheet, 0)).toHaveAttribute('data-heading', '1');
    await expect(row(sheet, 1)).toHaveAttribute('data-heading', '2');
    await expect(row(sheet, 2)).toHaveAttribute('data-heading', '3');
    await expect(row(sheet, 5)).not.toHaveAttribute('data-heading');
    await expect(text(sheet, 3).locator('strong')).toHaveText('**bold**');
    await expect(text(sheet, 3).locator('em')).toHaveText('*italic*');
    await expect(text(sheet, 3).locator('code')).toHaveText('`code`');
    await expect(text(sheet, 4).locator('strong')).toHaveText('**strong**');
    await expect(text(sheet, 4).locator('em')).toHaveText('*slanted*');
    await expect(text(sheet, 4).locator('code')).toHaveText('`npm test`');
    // Not editing: the marks are hidden, and what's left reads as formatted text.
    await expect(text(sheet, 3).locator('.n-mk').first()).toBeHidden();
    await expect(text(sheet, 0)).toHaveText('# Morning');
    expect(await text(sheet, 0).evaluate((el) => (el as HTMLElement).innerText)).toBe('MORNING');
    expect(
      await text(sheet, 3)
        .locator('strong')
        .evaluate((el) => getComputedStyle(el).fontWeight),
    ).toBe('700');
    expect(
      await text(sheet, 3)
        .locator('code')
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain('IBM Plex Mono');
    expect(await text(sheet, 5).evaluate((el) => (el as HTMLElement).innerText)).toBe(
      '#LT is the Project shorthand, not a heading',
    );
  };
  await stopEditing(window);
  await check();
  // While editing, the marks show (faintly) so they can be edited.
  await text(sheet, 3).click();
  await expect(text(sheet, 3).locator('.n-mk').first()).toBeVisible();
  await stopEditing(window);

  await window.getByRole('button', { name: 'Switch to light' }).click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
  await check();
  await first.app.close();

  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  sheet = await openNotes(window);
  await expect.poll(() => storedTexts(window)).toEqual([...expected].sort());
  await check();
  await second.close();
});

test('a link opens in the system browser on a click, only if it is http(s) or mailto; a URL pasted on selected text makes one', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  const sheet = await openNotes(window);
  const opened = await catchOpenedLinks(commander.app);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Docs at https://example.com/docs. Or [mail me](mailto:me@example.com)');
  await window.keyboard.press('Enter');
  await window.keyboard.type('[not this](file:///etc/passwd)');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Read the plan');
  for (let i = 0; i < 4; i++) await window.keyboard.press('Shift+ArrowLeft');
  await paste(window, { text: 'https://example.com/plan' });
  await expect(text(sheet, 2)).toHaveText('Read the [plan](https://example.com/plan)');
  await stopEditing(window);

  await text(sheet, 0).locator('[data-href]').first().click();
  await text(sheet, 0).locator('[data-href]').nth(1).click();
  await text(sheet, 2).locator('[data-href]').click();
  await expect
    .poll(opened)
    .toEqual(['https://example.com/docs', 'mailto:me@example.com', 'https://example.com/plan']);
  // Clicking a link never navigates the window.
  expect(window.url()).not.toContain('example.com');

  await text(sheet, 1).locator('[data-href]').click();
  await expect(window.getByText('Only web and email links open from a Daily Note.')).toBeVisible();
  // The main process refuses it too, whatever the window asks, and never opens a window of its own.
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share'])
    await window.evaluate((u) => void open(u, '_blank'), url);
  expect(await opened()).toHaveLength(3);
  expect(commander.app.windows()).toHaveLength(1);

  // While editing a Block, a click places the caret; Ctrl+click still opens.
  await text(sheet, 2).click({ position: { x: 2, y: 10 } });
  await text(sheet, 2).locator('[data-href]').click();
  expect(await opened()).toHaveLength(3);
  await text(sheet, 2)
    .locator('[data-href]')
    .click({ modifiers: ['Control'] });
  await expect.poll(() => opened().then((links) => links.length)).toBe(4);
  await commander.close();
});

test('pasted PNG and JPEG images are saved under attachments/, show inline, survive a restart, and come back with undo', async () => {
  const first = await launchCommander();
  let window = await first.app.firstWindow();
  let sheet = await openNotes(window);

  await sheet.locator('[data-block-text]').first().click();
  await window.keyboard.type('Whiteboard from standup');
  await paste(window, { images: ['image/png', 'image/jpeg'] });

  const images = sheet.locator('.n-image img');
  await expect(images).toHaveCount(2);
  for (const image of await images.all()) {
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  }
  const files = () =>
    readdirSync(join(first.userDataDir, 'attachments')).sort((a, b) =>
      a.slice(65).localeCompare(b.slice(65)),
    );
  await expect
    .poll(files)
    .toEqual([expect.stringMatching(/^[0-9a-f]{64}\.jpg$/), expect.stringMatching(/^[0-9a-f]{64}\.png$/)]);
  await expect
    .poll(() => storedTexts(window))
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^!\[\]\(attachments\/[0-9a-f]{64}\.png\)$/),
        expect.stringMatching(/^!\[\]\(attachments\/[0-9a-f]{64}\.jpg\)$/),
      ]),
    );
  // The window can't reach anything else through the attachment protocol.
  expect(
    await window.evaluate(() =>
      fetch('attachment://local/../commander.db').then(
        (r) => r.status,
        () => 'refused',
      ),
    ),
  ).not.toBe(200);
  await first.app.close();

  const second = await launchCommander({ userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  sheet = await openNotes(window);
  await expect(sheet.locator('.n-image img')).toHaveCount(2);
  await expect
    .poll(() =>
      sheet
        .locator('.n-image img')
        .first()
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(160);

  // Delete the first image Block, then undo: the image is back.
  await sheet.locator('.n-image').first().click();
  await window.keyboard.press('Backspace');
  await expect(sheet.locator('.n-image img')).toHaveCount(1);
  await expect.poll(() => storedTexts(window).then((texts) => texts.length)).toBe(2);
  await window.keyboard.press('Control+z');
  await expect(sheet.locator('.n-image img')).toHaveCount(2);
  await expect
    .poll(() =>
      sheet
        .locator('.n-image img')
        .first()
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(160);
  await expect.poll(() => storedTexts(window).then((texts) => texts.length)).toBe(3);
  expect(readdirSync(join(first.userDataDir, 'attachments'))).toHaveLength(2);
  await second.close();
});
