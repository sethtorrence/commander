import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  ALEX,
  type FakeCalendarEvent,
  type FakeGoogle,
  startFakeGoogle,
} from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Daily Notes write like Markdown (#239): a new line is a plain line; `## `, `- `, `1. ` and `[ ] `
// at the start of a line give it a style, Backspace at its start takes it off, only list items nest,
// and the Markdown copy writes each style as Markdown. A meeting is a quote, and the notes written in
// it stay inside it with its Project until an empty line leaves it.

const NOTICE = '<!-- Read-only copy written by Commander. Edits here are overwritten. -->';
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

let commander: LaunchedCommander | undefined;
let vault: string | undefined;

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  if (vault) rmSync(vault, { recursive: true, force: true });
  vault = undefined;
});

// The window's today, as the Notes Section keys it.
const todayIn = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  });

// The Blocks shown in a day's sheet, in outline order: their text and style.
const shownLines = (sheet: Locator) =>
  sheet.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('.n-blk[data-block]')].map((block) => {
      const text = block.querySelector(':scope > .n-row [data-block-text]')?.textContent ?? '';
      return `${block.dataset.style}: ${text}`;
    }),
  );

// Today's saved Blocks: text, style, parent's text and how each is filed.
const savedBlocks = (page: Page, day: string) =>
  page.evaluate(async (key) => {
    const store = window.commander.itemStore;
    const { notes } = await store({ op: 'daily-notes', query: { from: key, to: key } });
    const id = notes[0]?.item.id;
    if (!id) return [];
    const blocks = await store({ op: 'blocks', dailyNoteIds: [id] });
    const textOf = (blockId: string | null) => {
      const found = blocks.find((b) => b.id === blockId)?.detail;
      return found?.kind === 'block' ? found.text : null;
    };
    return blocks.flatMap((b) =>
      b.detail?.kind === 'block'
        ? [
            {
              text: b.detail.text,
              style: b.detail.style,
              parent: textOf(b.detail.parentId),
              filedBy: b.filing?.filedBy ?? null,
            },
          ]
        : [],
    );
  }, day);

const line = (sheet: Locator, text: string) =>
  sheet.locator('[data-block-text]', { hasText: new RegExp(`^${text}$`) });

// The Block (its whole .n-blk) holding `text`, with this style.
const styled = (container: Locator, style: string, text: string) =>
  container.locator(`.n-blk[data-style="${style}"]`).filter({
    has: container.page().locator(':scope > .n-row [data-block-text]', { hasText: new RegExp(`^${text}$`) }),
  });

test('each line style from its shorthand, lists that go on and nest, a checkbox Todo, and the Markdown copy of them', async () => {
  commander = await launchCommander();
  const page = await commander.window();
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  // The Markdown copy goes to a folder of the test's own (the system picker stood in for).
  vault = mkdtempSync(join(tmpdir(), 'commander-e2e-markdown-'));
  await commander.app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never;
  }, vault);
  await openSettings(page, 'Data');
  await page.getByTestId('markdown-copy').getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByTestId('markdown-copy').getByTestId('markdown-copy-state')).toHaveText(
    /^Up to date/,
  );

  await tab(page, 'Notes').click();
  const day = await todayIn(page);
  const sheet = page.locator(`#day-${day}`);
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-block-text]').first().click();

  // A subheading, then plain lines: Enter after a heading or a plain line makes a plain line.
  await page.keyboard.type('## Plan');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A plain line');
  await page.keyboard.press('Enter');
  // Tab does nothing on a plain line.
  await page.keyboard.press('Tab');
  // A bullet list goes on with Enter; Tab nests an item under the one above.
  await page.keyboard.type('- Milk');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Eggs');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Free range');
  // Enter on an empty nested item steps it out; on an empty top item it ends the list.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  // A numbered list numbers itself.
  await page.keyboard.type('1. First');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  // `[ ] ` makes a checkbox Todo.
  await page.keyboard.type('[ ] Send the deck');
  await page.keyboard.press('Escape');

  await expect
    .poll(() => shownLines(sheet))
    .toEqual([
      'heading-2: Plan',
      'plain: A plain line',
      'bullet: Milk',
      'bullet: Eggs',
      'bullet: Free range',
      'numbered: First',
      'numbered: Second',
      'todo: Send the deck',
    ]);
  const numbers = sheet.locator('.n-blk[data-style="numbered"] > .n-row .n-ord');
  await expect(numbers).toHaveText(['1.', '2.']);
  await expect(sheet.locator('.n-blk[data-style="plain"] > .n-row > .n-bullet i')).toBeHidden();
  await expect
    .poll(() => savedBlocks(page, day))
    .toEqual(
      expect.arrayContaining([
        { text: 'Plan', style: 'heading-2', parent: null, filedBy: null },
        { text: 'Free range', style: 'bullet', parent: 'Eggs', filedBy: null },
        { text: 'Second', style: 'numbered', parent: null, filedBy: null },
        { text: 'Send the deck', style: 'todo', parent: null, filedBy: null },
      ]),
    );

  // Ticking the checkbox completes its Todo.
  const todoRow = sheet.locator('.n-blk[data-style="todo"]');
  await todoRow.getByRole('checkbox').click();
  await expect(todoRow.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.commander
          .itemStore({ op: 'query', query: { kinds: ['todo'] } })
          .then((todos) => todos.map((todo) => [todo.title, todo.status])),
      ),
    )
    .toEqual([['Send the deck', 'done']]);

  // The Markdown copy writes each style as Markdown.
  const file = join(vault, `${day}.md`);
  await expect
    .poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : null), { timeout: 15_000 })
    .toBe(
      [
        NOTICE,
        '',
        '## Plan',
        '',
        'A plain line',
        '',
        '- Milk',
        '- Eggs',
        '\t- Free range',
        '1. First',
        '2. Second',
        '- [x] Send the deck',
        '',
      ].join('\n'),
    );

  // Backspace at the start of a styled line makes it a plain line again; the text stays.
  await line(sheet, 'Milk').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await line(sheet, 'Plan').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect
    .poll(() => shownLines(sheet).then((lines) => lines.slice(0, 3)))
    .toEqual(['plain: Plan', 'plain: A plain line', 'plain: Milk']);
  await expect
    .poll(() => (existsSync(file) ? readFileSync(file, 'utf8') : ''), { timeout: 15_000 })
    .toContain(`${NOTICE}\n\nPlan\n\nA plain line\n\nMilk\n\n- Eggs\n`);
});

// ---- a meeting's notes, against a fake Google on this machine ----

// Tokens are stored in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
let google: FakeGoogle | undefined;

test.afterEach(async () => {
  await google?.close();
  google = undefined;
});

function meeting(id: string, summary: string, start: number, minutes: number): FakeCalendarEvent {
  return {
    id,
    summary,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    start: { dateTime: new Date(start).toISOString() },
    end: { dateTime: new Date(start + minutes * 60_000).toISOString() },
    organizer: { email: ALEX.email, self: true },
  };
}

test('a meeting is a quote: the notes typed in it stay inside it with its Project, and an empty line leaves it', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  // A time today on this machine's clock, whenever the test runs.
  const start = new Date();
  start.setHours(0, 30, 0, 0);
  google.setCalendars(ALEX.sub, [
    {
      calendar: {
        id: ALEX.email,
        summary: ALEX.email,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
        primary: true,
      },
      events: [meeting('sync', 'Weekly sync with Priya', start.getTime(), 30)],
    },
  ]);
  const fake = google;
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_HOOKS: '1',
      COMMANDER_TEST_GOOGLE: JSON.stringify({
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        authorizeUrl: fake.authorizeUrl,
        tokenUrl: fake.tokenUrl,
        userinfoUrl: fake.userinfoUrl,
        calendarUrl: fake.calendarUrl,
      }),
    },
  });
  const page = await commander.window();
  // The system browser: follows Google's consent page (which the fake approves at once).
  await commander.app.evaluate(({ shell }, authorize) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(authorize)) await fetch(url);
    };
  }, fake.authorizeUrl);
  // A Project, made in Settings as the User would, so Notes offers it.
  await openSettings(page, 'Projects');
  const form = page.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill('Longtail');
  await form.getByLabel('Badge code').fill('LT');
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveCount(1);
  await settingsPage(page, 'Accounts');
  const accounts = page.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);

  await tab(page, 'Notes').click();
  const day = dayKey(new Date());
  const sheet = page.locator(`#day-${day}`);
  const chipText = sheet.locator('[data-block-text]:has([data-chip="event"])');
  await expect(chipText).toHaveCount(1);
  const chipId = (await chipText.getAttribute('data-block-id')) as string;
  const chipBlock = sheet.locator(`.n-blk[data-block="${chipId}"]`);
  // Under the Meetings subheading, the meeting shows as a quote.
  await expect(sheet.locator('.n-blk[data-style="heading-2"]', { hasText: 'Meetings' })).toHaveCount(1);
  await expect(chipBlock).toHaveClass(/\bquote\b/);

  // Filed under Longtail (`#l`, chosen from the picker), then notes typed in the meeting: Enter after
  // the chip goes into its quote, and the quote goes on; a list in it nests.
  // (Focused rather than clicked: a click on the card would open the event.)
  await chipText.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(' #l');
  await expect(page.getByTestId('tag-picker').getByRole('option')).toHaveText([/Longtail/]);
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Budget is fine');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Risks');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Hiring');
  // Out of the nested item, out of the list (a quote line again), then out of the meeting.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the meeting');
  await page.keyboard.press('Escape');

  await expect(styled(chipBlock, 'quote', 'Budget is fine')).toBeVisible();
  await expect(styled(chipBlock, 'bullet', 'Hiring')).toBeVisible();
  await expect(chipBlock.locator('[data-block-text]', { hasText: 'After the meeting' })).toHaveCount(0);
  await expect(line(sheet, 'After the meeting')).toBeVisible();
  const chipLine = (await chipText.textContent()) ?? '';
  await expect
    .poll(() =>
      savedBlocks(page, day).then((blocks) => blocks.filter((b) => b.text !== '' && b.parent !== null)),
    )
    .toEqual(
      expect.arrayContaining([
        { text: chipLine, style: 'quote', parent: 'Meetings', filedBy: 'user' },
        { text: 'Budget is fine', style: 'quote', parent: chipLine, filedBy: 'inherited' },
        { text: 'Risks', style: 'bullet', parent: chipLine, filedBy: 'inherited' },
        { text: 'Hiring', style: 'bullet', parent: 'Risks', filedBy: 'inherited' },
        { text: 'After the meeting', style: 'plain', parent: 'Meetings', filedBy: null },
      ]),
    );
  // The meeting holds its two lines (the list nested in one); the line after it is not among them.
  await expect(chipBlock.locator(':scope > .n-kids > .n-blk')).toHaveCount(2);
});
