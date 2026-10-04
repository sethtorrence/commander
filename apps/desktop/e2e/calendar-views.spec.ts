import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import {
  ALEX,
  type FakeCalendarEvent,
  type FakeGoogle,
  type FakeGoogleUser,
  startFakeGoogle,
} from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The Calendar views end to end (#127), against a fake Google on this machine with two Google
// Accounts, a personal one and a work one: switch between Agenda, Week, Month and Day with the keys
// → spot the clash between the two Accounts (and none on a declined event) → add a second time zone
// in Settings → file an event with b in the Week view → restart: the view and the second zone are
// still there. Tokens are stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const SAM: FakeGoogleUser = { sub: '204512345678901234567', email: 'sam@work.test', name: 'Sam Rivera' };
const SECOND_ZONE = 'Asia/Tokyo';
const iso = (time: number) => new Date(time).toISOString();
// A time today, on this machine's clock.
const todayAt = (hour: number, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
};

function timed(
  owner: string,
  id: string,
  summary: string,
  start: number,
  minutes: number,
  extra: Record<string, unknown> = {},
): FakeCalendarEvent {
  return {
    id,
    summary,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    start: { dateTime: iso(start) },
    end: { dateTime: iso(start + minutes * 60_000) },
    organizer: { email: owner, self: true },
    ...extra,
  };
}

const primary = (user: FakeGoogleUser, colour: string, events: FakeCalendarEvent[]) => [
  {
    calendar: {
      id: user.email,
      summary: user.email,
      accessRole: 'owner' as const,
      backgroundColor: colour,
      primary: true,
    },
    events,
  },
];

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  google.setCalendars(
    ALEX.sub,
    primary(ALEX, '#9fe1e7', [timed(ALEX.email, 'designreview', 'Design review', todayAt(14), 60)]),
  );
  google.setCalendars(
    SAM.sub,
    primary(SAM, '#f6bf26', [
      timed(SAM.email, 'boardprep', 'Board prep', todayAt(14, 30), 60),
      timed('dana@work.test', 'skipped', 'Vendor sync', todayAt(14, 15), 30, {
        attendees: [
          { email: 'dana@work.test', organizer: true, responseStatus: 'accepted' },
          { email: SAM.email, self: true, responseStatus: 'declined' },
        ],
      }),
    ]),
  );
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
});

const env = () => ({
  COMMANDER_TEST_GOOGLE: JSON.stringify({
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    calendarUrl: google.calendarUrl,
  }),
});

// The system browser: follows Google's consent page (which the fake approves at once).
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, authorize) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(authorize)) await fetch(url);
    };
  }, google.authorizeUrl);
}

const blocks = (window: Page) => window.getByTestId('section-calendar').getByTestId('calendar-block');
const block = (window: Page, title: string) => blocks(window).filter({ hasText: title });

test('switch views, spot a clash between two Accounts, add a second time zone, file an event, and keep it all over a restart', async () => {
  commander = await launchCommander({ env: env() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);

  // Two Google Accounts: Alex's own, then Sam's work one.
  await openSettings(window);
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('account-name')).toHaveText(['Google · alex@gmail.test']);
  google.approve(SAM);
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('account-name')).toHaveCount(2);

  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Titanlink');
  await newProject.getByLabel('Badge code').fill('TL');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /TLTitanlink/,
  ]);
  await window.keyboard.press('Escape');

  // The Agenda first: both Accounts' events, the clashing pair marked, the declined one not.
  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  const agenda = section.getByTestId('calendar-event');
  await expect(agenda.filter({ hasText: 'Board prep' })).toHaveCount(1);
  await expect(agenda.filter({ hasText: 'Design review' }).getByTestId('clash-mark')).toBeVisible();
  await expect(agenda.filter({ hasText: 'Board prep' }).getByTestId('clash-mark')).toBeVisible();
  await expect(agenda.filter({ hasText: 'Vendor sync' }).getByTestId('clash-mark')).toHaveCount(0);

  // Week, with w: the time grid, the clash marked on both blocks, the "now" line on today.
  await window.keyboard.press('w');
  await expect(section.getByTestId('time-grid')).toBeVisible();
  await expect(section.getByRole('radio', { name: /Week/ })).toHaveAttribute('aria-checked', 'true');
  await expect(block(window, 'Design review').getByTestId('clash-mark')).toBeVisible();
  await expect(block(window, 'Board prep').getByTestId('clash-mark')).toBeVisible();
  await expect(block(window, 'Vendor sync').getByTestId('clash-mark')).toHaveCount(0);
  await expect(section.getByTestId('now-line')).toHaveCount(1);
  // The overlapping events sit side by side: each narrower than the day.
  const [review, board] = await Promise.all([
    block(window, 'Design review').boundingBox(),
    block(window, 'Board prep').boundingBox(),
  ]);
  expect(
    review && board && (review.x + review.width <= board.x + 1 || board.x + board.width <= review.x + 1),
  ).toBe(true);

  // Month and Day, and back to the week; [ and ] move by the view's span, t comes back to today.
  const range = section.getByTestId('calendar-range');
  const thisWeek = await range.textContent();
  await window.keyboard.press('m');
  await expect(section.getByTestId('month-grid')).toBeVisible();
  await window.keyboard.press('d');
  await expect(blocks(window).filter({ hasText: 'Design review' })).toHaveCount(1);
  await window.keyboard.press('w');
  await window.keyboard.press(']');
  await expect(range).not.toHaveText(thisWeek ?? '');
  await window.keyboard.press('t');
  await expect(range).toHaveText(thisWeek ?? '');

  // The clash in the detail pane.
  await block(window, 'Board prep').click();
  const pane = section.getByRole('region', { name: 'Event detail' });
  await expect(pane.getByTestId('event-clash')).toContainText(
    'Clashes with Design review in your alex@gmail.test calendar',
  );

  // A second time zone, from Settings → Calendar: a second column of hours, and its time in the pane.
  await openSettings(window);
  const zone = window.getByRole('combobox', { name: 'Second time zone' });
  await zone.fill(SECOND_ZONE);
  await zone.press('Enter');
  await expect(window.getByText(/^Tokyo · \d\d:\d\d there now$/)).toBeVisible();
  await window.keyboard.press('Escape');
  await tab(window, 'Calendar').click();
  await expect(section.getByTestId('second-zone-head')).toHaveText('Tokyo');
  await expect(section.getByTestId('second-zone-hour')).toHaveCount(23);
  await expect(pane.getByTestId('event-zones')).toHaveText(/^14:30 here · \d\d:\d\d Tokyo/);

  // File Design review with b, from the grid.
  await block(window, 'Design review').click();
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('tl');
  await picker.getByRole('combobox').press('Enter');
  await expect(block(window, 'Design review').getByRole('img', { name: 'Titanlink' })).toBeVisible();

  // Restart on the same data: the Week view and the second zone are kept.
  const { userDataDir } = commander;
  await commander.app.close();
  commander = await launchCommander({ env: env(), userDataDir });
  const again = await commander.window();
  await tab(again, 'Calendar').click();
  await expect(again.getByTestId('section-calendar').getByTestId('time-grid')).toBeVisible();
  await expect(again.getByTestId('second-zone-head')).toHaveText('Tokyo');
  await expect(block(again, 'Design review').getByRole('img', { name: 'Titanlink' })).toBeVisible();
});
