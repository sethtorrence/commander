import { type ElectronApplication, expect, type Locator, test } from '@playwright/test';
import {
  ALEX,
  type FakeCalendarEvent,
  type FakeGoogle,
  startFakeGoogle,
} from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Google Calendar sync end to end, against a fake Google (sign-in and the Calendar API) on this
// machine, never the real one: connect a Google Account → its calendars listed in Settings, each
// switchable → events in the Agenda → open one → hand Edit and New event to Google Calendar → file
// it with b → find it with Ctrl+K → the next sync brings changes and cancellations. Tokens are stored
// in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIMARY = ALEX.email;
const STANDUPS = 'c_tl_standups@group.calendar.google.com';
const HOLIDAYS = 'en.uk#holiday@group.v.calendar.google.com';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

// Minutes from a start to the end of its day: the longer Design review must not run past midnight, or
// the Agenda shows its last part again the next day (a test run late in the evening).
const toMidnight = (start: number) => (new Date(start).setHours(24, 0, 0, 0) - start) / 60_000;

const iso = (time: number) => new Date(time).toISOString();
const localDay = (time: number) => new Date(time).toDateString();
const dateOnly = (time: number) => {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

function timed(
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
    organizer: { email: PRIMARY, self: true },
    ...extra,
  };
}

let google: FakeGoogle;
let commander: LaunchedCommander | undefined;
let now: number;
// Whole hours from now, so the events don't straddle the minute the test runs in.
let soon: number;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  now = Date.now();
  soon = Math.ceil(now / HOUR) * HOUR + HOUR;
  google.setCalendars(ALEX.sub, [
    {
      calendar: {
        id: PRIMARY,
        summary: PRIMARY,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
        primary: true,
      },
      events: [
        timed('designreview', 'Design review: onboarding', soon, 60, {
          location: 'Room 4',
          description:
            '<p>Walk through the <b>new onboarding</b>.</p><p><a href="https://docs.example.test/onboarding">Notes</a></p><img src="http://127.0.0.1:9/pixel.png">',
          organizer: { email: 'dana@titanlink.test', displayName: 'Dana Ruiz' },
          attendees: [
            {
              email: 'dana@titanlink.test',
              displayName: 'Dana Ruiz',
              organizer: true,
              responseStatus: 'accepted',
            },
            { email: PRIMARY, self: true, responseStatus: 'needsAction' },
          ],
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
        }),
        timed('dentist', 'Dentist', soon + DAY, 45),
      ],
    },
    {
      calendar: {
        id: STANDUPS,
        summary: 'Titanlink Standups',
        accessRole: 'owner',
        backgroundColor: '#33b679',
      },
      events: [1, 2].map((day) =>
        timed(`standup_${day}`, 'TL standup', soon + day * DAY - 2 * HOUR, 15, {
          recurringEventId: 'standup',
        }),
      ),
    },
    {
      calendar: {
        id: HOLIDAYS,
        summary: 'Holidays in United Kingdom',
        accessRole: 'reader',
        backgroundColor: '#16a765',
      },
      events: [
        {
          id: 'bankholiday',
          summary: 'Bank holiday',
          start: { date: dateOnly(now + 3 * DAY) },
          end: { date: dateOnly(now + 4 * DAY) },
          transparency: 'transparent',
        },
      ],
    },
  ]);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
});

// The system browser: follows Google's consent page (which the fake approves at once) back to
// Commander's loopback listener; anything else it is asked to open is only noted.
async function standInForTheBrowser(app: ElectronApplication, authorizeUrl: string) {
  await app.evaluate(({ shell }, authorize) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      if (url.startsWith(authorize)) await fetch(url);
      else opened.push(url);
    };
  }, authorizeUrl);
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

const rows = (section: Locator) => section.getByTestId('calendar-event');

test('connect Google → events in the Agenda → open one → hand it to Google Calendar → file it → find it', async () => {
  const env = {
    COMMANDER_TEST_GOOGLE: JSON.stringify({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      authorizeUrl: google.authorizeUrl,
      tokenUrl: google.tokenUrl,
      userinfoUrl: google.userinfoUrl,
      calendarUrl: google.calendarUrl,
    }),
  };
  commander = await launchCommander({ env });
  const { app } = commander;
  const window = await commander.window();
  const openedExternally = await standInForTheBrowser(app, google.authorizeUrl);

  // Connect, and the Account's calendars are listed: the primary and owned ones on, holidays off.
  await openSettings(window, 'Accounts');
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  const switches = accounts.getByTestId('calendar-switches');
  await expect(switches.getByRole('switch')).toHaveCount(3);
  await expect(switches.getByRole('switch', { name: PRIMARY })).toHaveAttribute('aria-checked', 'true');
  await expect(switches.getByRole('switch', { name: 'Titanlink Standups' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const holidays = switches.getByRole('switch', { name: 'Holidays in United Kingdom' });
  await expect(holidays).toHaveAttribute('aria-checked', 'false');
  // The subscribed calendar is never read until switched on.
  expect(google.calendarRequests.some((request) => request.includes(HOLIDAYS))).toBe(false);

  await settingsPage(window, 'Projects');
  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Titanlink');
  await newProject.getByLabel('Badge code').fill('TL');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /TLTitanlink/,
  ]);

  // The tab counts today's events still to come.
  const toCome = localDay(soon) === localDay(now) ? 1 : 0;
  if (toCome) await expect(tab(window, 'Calendar').locator('.tc')).toHaveText('01');

  // Opening the Section syncs Google Calendar again, and lists the Agenda by day.
  const requestsBefore = google.calendarRequests.length;
  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  await expect.poll(() => google.calendarRequests.length).toBeGreaterThan(requestsBefore);
  await expect(section.getByTestId('calendar-sync-status')).toHaveText(/^Synced \d\d:\d\d$/);
  await expect(rows(section)).toHaveText([
    /Design review: onboarding/,
    /TL standup/,
    /Dentist/,
    /TL standup/,
  ]);
  await expect(window.getByTestId('calendar-list').getByRole('switch')).toHaveCount(2);

  // Open the design review: its fields, and the description as safe text (no image fetched).
  await rows(section).filter({ hasText: 'Design review' }).click();
  const pane = section.getByRole('region', { name: 'Event detail' });
  await expect(pane.getByRole('heading', { name: 'Design review: onboarding' })).toBeVisible();
  await expect(pane.locator('[data-field="location"] dd')).toHaveText('Room 4');
  await expect(pane.locator('[data-field="organiser"] dd')).toHaveText('Dana Ruiz');
  await expect(pane.locator('[data-field="response"] dd')).toHaveText('Not answered');
  await expect(pane.locator('[data-field="meeting"] dd')).toHaveText('meet.google.com/abc-defg-hij');
  const description = pane.getByTestId('event-description');
  await expect(description).toContainText('Walk through the new onboarding.');
  await expect(description.getByRole('link', { name: /docs\.example\.test\/onboarding/ })).toBeVisible();
  await expect(pane.locator('img')).toHaveCount(0);

  // Edit and New event open Google Calendar, as this Account, in the system browser.
  await pane.getByRole('button', { name: /Edit in Google Calendar/ }).click();
  await section.getByRole('button', { name: /New event/ }).click();
  await expect
    .poll(openedExternally)
    .toEqual([
      'https://www.google.com/calendar/event?eid=designreview&authuser=alex%40gmail.test',
      'https://calendar.google.com/calendar/r/eventedit?authuser=alex%40gmail.test',
    ]);

  // File it with b.
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('tl');
  await picker.getByRole('combobox').press('Enter');
  const review = rows(section).filter({ hasText: 'Design review' });
  await expect(review.getByRole('img', { name: 'Titanlink' })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Activity' }).getByRole('listitem').first()).toContainText(
    'Filed under TL by you',
  );

  // Back from Google Calendar (the window regains focus): the Account syncs, bringing what changed.
  google.putEvent(
    ALEX.sub,
    PRIMARY,
    timed('designreview', 'Design review: onboarding v2', soon, Math.min(90, toMidnight(soon))),
  );
  google.cancelEvent(ALEX.sub, PRIMARY, 'dentist');
  await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(rows(section)).toHaveText([/Design review: onboarding v2/, /TL standup/, /TL standup/]);
  // Still filed.
  await expect(rows(section).first().getByRole('img', { name: 'Titanlink' })).toBeVisible();
  expect(google.calendarRequests.some((request) => request.includes('syncToken=fake-sync-'))).toBe(true);

  // Ctrl+K finds events, in their own group.
  await window.keyboard.press('Escape');
  await window.keyboard.press('Control+k');
  const palette = window.getByTestId('palette');
  await palette.getByRole('combobox', { name: 'Search Commander' }).fill('standup');
  await expect(
    palette
      .getByRole('group', { name: 'Calendar' })
      .getByRole('option', { name: /TL standup/ })
      .first(),
  ).toBeVisible();
  await window.keyboard.press('Escape');

  // Switching the holidays calendar on in Settings syncs it, and its event joins the Agenda.
  await openSettings(window, 'Accounts');
  await holidays.click();
  await expect(holidays).toHaveAttribute('aria-checked', 'true');
  await tab(window, 'Calendar').click();
  await expect(rows(section).filter({ hasText: 'Bank holiday' })).toHaveCount(1);
  await expect(rows(section).filter({ hasText: 'Bank holiday' })).toContainText('All day');
});
