import { type ElectronApplication, expect, type Locator, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import {
  type FakeMicrosoft,
  type FakeOutlookEvent,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Outlook Calendar sync end to end, against a fake Microsoft identity platform and Graph on this
// machine, never the real ones: connect an Outlook Account → its calendars listed in Settings, each
// switchable → events in the Agenda (with Google's, when a Google Account is connected too) → open
// one → hand Edit and New event to Outlook on the web → file it with b → the next sync brings changes
// and deletions through the delta link → an expired delta link syncs again from scratch → a shared
// calendar switched on joins the Agenda. Tokens are stored in the real keyring, so these need the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DEFAULT = 'AAMkAGI2-cal-default=';
const TITANLINK = 'AAMkAGI2-cal-titanlink=';
const SHARED = 'AAMkAGI2-cal-dana=';
const DANA = { name: 'Dana Ruiz', address: 'dana@titanlink.test' };
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

// Minutes from a start to the end of its day: the longer Design review must not run past midnight, or
// the Agenda shows its last part again the next day (a test run late in the evening).
const toMidnight = (start: number) => (new Date(start).setHours(24, 0, 0, 0) - start) / 60_000;

// Graph's calendarView times: UTC, seven decimals, no offset.
const graphTime = (time: number) => ({
  dateTime: `${new Date(time).toISOString().slice(0, 23)}0000`,
  timeZone: 'UTC',
});
const webLink = (id: string) =>
  `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`;

function timed(
  id: string,
  subject: string,
  start: number,
  minutes: number,
  extra: Record<string, unknown> = {},
): FakeOutlookEvent {
  return {
    id,
    subject,
    start: graphTime(start),
    end: graphTime(start + minutes * 60_000),
    originalStartTimeZone: 'GMT Standard Time',
    isAllDay: false,
    isCancelled: false,
    isOrganizer: true,
    showAs: 'busy',
    sensitivity: 'normal',
    type: 'singleInstance',
    webLink: webLink(id),
    responseStatus: { response: 'organizer', time: '0001-01-01T00:00:00Z' },
    organizer: { emailAddress: { name: SAM.displayName, address: SAM.userPrincipalName } },
    attendees: [],
    body: { contentType: 'text', content: '' },
    ...extra,
  };
}

let microsoft: FakeMicrosoft;
let google: FakeGoogle | undefined;
let commander: LaunchedCommander | undefined;
let now: number;
// Whole hours from now, so the events don't straddle the minute the test runs in.
let soon: number;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  now = Date.now();
  soon = Math.ceil(now / HOUR) * HOUR + HOUR;
  microsoft.setCalendars(SAM.id, [
    {
      calendar: { id: DEFAULT, name: 'Calendar', isDefaultCalendar: true },
      events: [
        timed('AAMkAGI2-evt-designreview=', 'Design review: onboarding', soon, 60, {
          isOrganizer: false,
          showAs: 'tentative',
          location: { displayName: 'Room 4' },
          body: {
            contentType: 'html',
            content:
              '<html><head><style>p{margin:0}</style></head><body><p>Walk through the <b>new onboarding</b>.</p><p><a href="https://docs.example.test/onboarding">Notes</a></p><img src="http://127.0.0.1:9/pixel.png"></body></html>',
          },
          organizer: { emailAddress: DANA },
          attendees: [
            { type: 'required', status: { response: 'none' }, emailAddress: DANA },
            {
              type: 'required',
              status: { response: 'none' },
              emailAddress: { name: SAM.displayName, address: SAM.userPrincipalName },
            },
          ],
          responseStatus: { response: 'notResponded', time: '0001-01-01T00:00:00Z' },
          onlineMeeting: {
            joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_onboarding%40thread.v2/0',
          },
        }),
        timed('AAMkAGI2-evt-dentist=', 'Dentist', soon + DAY, 45, { sensitivity: 'private' }),
      ],
    },
    {
      calendar: { id: TITANLINK, name: 'Titanlink', hexColor: '#33b679' },
      events: [1, 2].map((day) =>
        timed(`AAMkAGI2-evt-standup-${day}=`, 'TL standup', soon + day * DAY - 2 * HOUR, 15, {
          type: 'occurrence',
          seriesMasterId: 'AAMkAGI2-evt-standup=',
          originalStartTimeZone: 'Pacific Standard Time',
        }),
      ),
    },
    {
      calendar: { id: SHARED, name: 'Dana Ruiz', canEdit: false, owner: DANA },
      events: [
        timed(
          'AAMkAGI2-evt-offsite=',
          'Offsite planning',
          soon + 3 * DAY,
          Math.min(120, toMidnight(soon + 3 * DAY)),
          { isOrganizer: false },
        ),
      ],
    },
  ]);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
  await google?.close();
  google = undefined;
});

// The system browser: follows the sign-in pages (which the fakes approve at once) back to Commander's
// loopback listener; anything else it is asked to open is only noted.
async function standInForTheBrowser(app: ElectronApplication, signIns: string[]) {
  await app.evaluate(({ shell }, followed) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      if (followed.some((prefix) => url.startsWith(prefix))) await fetch(url);
      else opened.push(url);
    };
  }, signIns);
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

const microsoftEnv = () => ({
  COMMANDER_TEST_MICROSOFT: JSON.stringify({
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  }),
});

const rows = (section: Locator) => section.getByTestId('calendar-event');

test('connect Outlook → events in the Agenda → open one in Outlook on the web → file it → the next syncs', async () => {
  commander = await launchCommander({ env: microsoftEnv() });
  const { app } = commander;
  const window = await app.firstWindow();
  const openedExternally = await standInForTheBrowser(app, [microsoft.loginUrl]);

  // Connect, and the Account's calendars are listed: the default and the User's own on, Dana's off.
  await openSettings(window, 'Accounts');
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  const switches = outlook.getByTestId('calendar-switches');
  await expect(switches.getByRole('switch')).toHaveCount(3);
  await expect(switches.getByRole('switch', { name: 'Calendar', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(switches.getByRole('switch', { name: 'Titanlink' })).toHaveAttribute('aria-checked', 'true');
  const shared = switches.getByRole('switch', { name: 'Dana Ruiz' });
  await expect(shared).toHaveAttribute('aria-checked', 'false');
  // The shared calendar is never read until switched on; every calendar read asks for immutable ids.
  expect(microsoft.graphRequests.some((request) => request.includes(SHARED))).toBe(false);
  expect(microsoft.calendarPrefers.length).toBeGreaterThan(0);
  expect(microsoft.calendarPrefers.every((prefer) => prefer.includes('IdType="ImmutableId"'))).toBe(true);

  await settingsPage(window, 'Projects');
  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Titanlink');
  await newProject.getByLabel('Badge code').fill('TL');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /TLTitanlink/,
  ]);

  // Opening the Section syncs Outlook Calendar again (from its delta links), and lists the Agenda.
  const requestsBefore = microsoft.graphRequests.length;
  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  await expect.poll(() => microsoft.graphRequests.length).toBeGreaterThan(requestsBefore);
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
  await expect(pane.locator('[data-field="meeting"] dd')).toContainText('teams.microsoft.com');
  const description = pane.getByTestId('event-description');
  await expect(description).toContainText('Walk through the new onboarding.');
  await expect(description.getByRole('link', { name: /docs\.example\.test\/onboarding/ })).toBeVisible();
  await expect(pane.locator('img')).toHaveCount(0);

  // Edit and New event open Outlook on the web, for this Account, in the system browser.
  await pane.getByRole('button', { name: /Edit in Outlook/ }).click();
  await section.getByRole('button', { name: /New event/ }).click();
  await expect
    .poll(openedExternally)
    .toEqual([
      `${webLink('AAMkAGI2-evt-designreview=')}&login_hint=sam%40contoso.test`,
      'https://outlook.office.com/calendar/deeplink/compose?login_hint=sam%40contoso.test',
    ]);

  // File it with b.
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('tl');
  await picker.getByRole('combobox').press('Enter');
  const review = rows(section).filter({ hasText: 'Design review' });
  await expect(review.getByRole('img', { name: 'Titanlink' })).toBeVisible();

  // Back from Outlook (the window regains focus): the Account syncs from its delta links.
  microsoft.putEvent(
    SAM.id,
    DEFAULT,
    timed(
      'AAMkAGI2-evt-designreview=',
      'Design review: onboarding v2',
      soon,
      Math.min(90, toMidnight(soon)),
      {
        organizer: { emailAddress: DANA },
      },
    ),
  );
  microsoft.removeEvent(SAM.id, DEFAULT, 'AAMkAGI2-evt-dentist=');
  await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(rows(section)).toHaveText([/Design review: onboarding v2/, /TL standup/, /TL standup/]);
  // Still filed.
  await expect(rows(section).first().getByRole('img', { name: 'Titanlink' })).toBeVisible();
  expect(microsoft.graphRequests.some((request) => request.includes('$deltatoken='))).toBe(true);

  // Graph forgets its delta links: the next sync reads every calendar again from scratch.
  microsoft.expireDeltaLinks();
  microsoft.putEvent(SAM.id, TITANLINK, timed('AAMkAGI2-evt-retro=', 'Sprint retro', soon + DAY + HOUR, 30));
  const beforeExpiry = microsoft.graphRequests.length;
  // Coming back to the Section syncs its Accounts.
  await tab(window, 'Todos').click();
  await tab(window, 'Calendar').click();
  await expect(rows(section).filter({ hasText: 'Sprint retro' })).toHaveCount(1);
  expect(
    microsoft.graphRequests.slice(beforeExpiry).some((request) => request.includes('startDateTime=')),
  ).toBe(true);
  await expect(rows(section).first().getByRole('img', { name: 'Titanlink' })).toBeVisible();

  // Switching Dana's shared calendar on in Settings syncs it, and its event joins the Agenda.
  await window.keyboard.press('Escape');
  await openSettings(window, 'Accounts');
  await shared.click();
  await expect(shared).toHaveAttribute('aria-checked', 'true');
  await tab(window, 'Calendar').click();
  await expect(rows(section).filter({ hasText: 'Offsite planning' })).toHaveCount(1);
});

test('Graph’s delta answers events bare: each is read in full, the Agenda shows real titles, and no Busy copy', async () => {
  // As Graph's per-calendar delta answered the User's work account (#241): ids, types, series and
  // times, nothing else. The fake does so unless told otherwise; here it is said out loud.
  microsoft.bareDeltaEvents(true);
  // Commander's own busy copy of an event in another Account, known by its transactionId alone.
  const copyAt = soon + 2 * DAY;
  microsoft.putEvent(
    SAM.id,
    DEFAULT,
    timed('AAMkAGI2-evt-busycopy=', 'Busy', copyAt, Math.min(30, toMidnight(copyAt)), {
      sensitivity: 'private',
      isReminderOn: false,
      transactionId: 'busy-block:7d9c2f3e-41a6-4c1b-9e57-2b8d0f6a1c34',
    }),
  );
  commander = await launchCommander({ env: microsoftEnv() });
  const { app } = commander;
  const window = await app.firstWindow();
  await standInForTheBrowser(app, [microsoft.loginUrl]);

  await openSettings(window, 'Accounts');
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(outlook.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(3);

  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  await expect(rows(section)).toHaveText([
    /Design review: onboarding/,
    /TL standup/,
    /Dentist/,
    /TL standup/,
  ]);
  await expect(rows(section).filter({ hasText: 'No title' })).toHaveCount(0);
  await expect(rows(section).filter({ hasText: 'Busy' })).toHaveCount(0);
  // Each was read in full by its id, with the properties Commander shows.
  const reads = microsoft.graphRequests.filter((request) => request.startsWith('/v1.0/me/events/'));
  expect(reads.some((request) => request.includes('AAMkAGI2-evt-designreview=?$select='))).toBe(true);
  expect(reads.some((request) => request.includes('AAMkAGI2-evt-standup-1=?$select='))).toBe(true);
  expect(reads.every((request) => /\$select=.*subject.*organizer.*attendees/.test(request))).toBe(true);

  // Opened, the design review has all of itself: organiser, place, Teams link and notes.
  await rows(section).filter({ hasText: 'Design review' }).click();
  const pane = section.getByRole('region', { name: 'Event detail' });
  await expect(pane.locator('[data-field="location"] dd')).toHaveText('Room 4');
  await expect(pane.locator('[data-field="organiser"] dd')).toHaveText('Dana Ruiz');
  await expect(pane.locator('[data-field="meeting"] dd')).toContainText('teams.microsoft.com');
  await expect(pane.getByTestId('event-description')).toContainText('Walk through the new onboarding.');

  // The busy copy is still on the calendar, holding the time.
  expect(microsoft.eventsOn(SAM.id, DEFAULT).map((event) => event.id)).toContain('AAMkAGI2-evt-busycopy=');
});

test('with a Google Account too, the Agenda shows both Accounts’ events together, calendars grouped by Account', async () => {
  // Delta answers full events here, as the primary calendar's does: none is read again.
  microsoft.bareDeltaEvents(false);
  google = await startFakeGoogle();
  google.setCalendars(ALEX.sub, [
    {
      calendar: {
        id: ALEX.email,
        summary: ALEX.email,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
        primary: true,
      },
      events: [
        {
          id: 'lunchpriya',
          summary: 'Lunch with Priya',
          htmlLink: 'https://www.google.com/calendar/event?eid=lunchpriya',
          start: { dateTime: new Date(soon + 3 * HOUR).toISOString() },
          end: { dateTime: new Date(soon + 4 * HOUR).toISOString() },
          organizer: { email: ALEX.email, self: true },
        },
      ],
    },
  ]);
  commander = await launchCommander({
    env: {
      ...microsoftEnv(),
      COMMANDER_TEST_GOOGLE: JSON.stringify({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        authorizeUrl: google.authorizeUrl,
        tokenUrl: google.tokenUrl,
        userinfoUrl: google.userinfoUrl,
        calendarUrl: google.calendarUrl,
      }),
    },
  });
  const { app } = commander;
  const window = await app.firstWindow();
  await standInForTheBrowser(app, [microsoft.loginUrl, google.authorizeUrl]);

  await openSettings(window, 'Accounts');
  const panel = window.getByTestId('accounts-panel');
  await panel.getByTestId('source-outlook').getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(
    panel.getByTestId('source-outlook').getByTestId('calendar-switches').getByRole('switch'),
  ).toHaveCount(3);
  await panel.getByTestId('source-google').getByRole('button', { name: 'Connect Google' }).click();
  await expect(
    panel.getByTestId('source-google').getByTestId('calendar-switches').getByRole('switch'),
  ).toHaveCount(1);

  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  await expect(rows(section)).toHaveText([
    /Design review: onboarding/,
    /Lunch with Priya/,
    /TL standup/,
    /Dentist/,
    /TL standup/,
  ]);
  // Each row names its Account when there are several.
  await expect(rows(section).filter({ hasText: 'Lunch with Priya' })).toContainText(ALEX.email);
  await expect(rows(section).filter({ hasText: 'Dentist' })).toContainText(SAM.userPrincipalName);
  const groups = window.getByTestId('calendar-list').getByTestId('calendar-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText(`${ALEX.email} · Google`);
  await expect(groups.nth(1)).toContainText(`${SAM.userPrincipalName} · Outlook`);
  // A New event button for each Account.
  await expect(section.getByRole('button', { name: /New event/ })).toHaveCount(2);
  expect(microsoft.graphRequests.some((request) => request.startsWith('/v1.0/me/events/'))).toBe(false);
});
