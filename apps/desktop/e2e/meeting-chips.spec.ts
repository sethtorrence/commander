import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import {
  ALEX,
  type FakeCalendarEvent,
  type FakeGoogle,
  startFakeGoogle,
} from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Today's meetings end to end (#128), against a fake Google on this machine: connect Google → today's
// events sync → today's Daily Note lists them as meeting chips under Meetings (not the declined or
// all-day ones) → write a note under a chip → the event is cancelled in Google → its chip shows struck
// through as Cancelled, with the note kept, while a chip with nothing under it goes. And the opt-in
// heads-up: off by default; turned on, it comes 2 minutes before a meeting and opens it. Tokens are
// stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIMARY = ALEX.email;
const iso = (time: number) => new Date(time).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (time: number) => `${pad(new Date(time).getHours())}:${pad(new Date(time).getMinutes())}`;
const dayOf = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
// A time today, on this machine's clock: always today, whenever the test runs.
const todayAt = (hour: number, minute: number) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
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

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
});

const primary = (events: FakeCalendarEvent[]) =>
  google.setCalendars(ALEX.sub, [
    {
      calendar: {
        id: PRIMARY,
        summary: PRIMARY,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
        primary: true,
      },
      events,
    },
  ]);

// Launches Commander against the fake Google and connects Alex's Google Account.
async function connectGoogle(): Promise<{ app: ElectronApplication; window: Page }> {
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_HOOKS: '1',
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
  const window = await commander.window();
  // The system browser: follows Google's consent page (which the fake approves at once).
  await app.evaluate(({ shell }, authorize) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(authorize)) await fetch(url);
    };
  }, google.authorizeUrl);
  await openSettings(window, 'Accounts');
  const accounts = window.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  return { app, window };
}

// The meeting chips shown in a day's sheet, as their cards read.
const chips = (sheet: Locator) => sheet.locator('[data-chip="event"]');

// A Block's saved children's text, by the Block's id.
const savedChildren = (page: Page, parentId: string) =>
  page.evaluate(async (id) => {
    const view = await window.commander.itemStore({ op: 'get', itemId: id });
    const note = view?.item.detail?.kind === 'block' ? view.item.detail.dailyNoteId : null;
    if (!note) return [];
    const blocks = await window.commander.itemStore({ op: 'blocks', dailyNoteIds: [note] });
    return blocks.flatMap((b) =>
      b.detail?.kind === 'block' && b.detail.parentId === id ? [b.detail.text] : [],
    );
  }, parentId);

test('sync → meeting chips in today’s note → a note under one → the meeting cancelled → struck through, note kept', async () => {
  const standup = todayAt(0, 15);
  const sync = todayAt(0, 30);
  const tomorrow = new Date(sync);
  tomorrow.setDate(tomorrow.getDate() + 1);
  primary([
    timed('sync', 'Weekly sync with Priya', sync, 30, {
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    }),
    timed('standup', 'Standup', standup, 15),
    timed('offsite', 'Offsite planning', todayAt(0, 45), 60, {
      organizer: { email: 'dana@titanlink.test' },
      attendees: [{ email: PRIMARY, self: true, responseStatus: 'declined' }],
    }),
    {
      id: 'holiday',
      summary: 'Bank holiday',
      start: { date: dayOf(sync) },
      end: { date: dayOf(tomorrow.getTime()) },
      transparency: 'transparent',
    },
    timed('dentist', 'Dentist', tomorrow.getTime(), 45),
  ]);
  const { window } = await connectGoogle();

  // Today's Daily Note (made from the daily template) lists today's meetings under Meetings, in time
  // order: not the declined one, nor the all-day one.
  await tab(window, 'Notes').click();
  const sheet = window.locator(`#day-${dayOf(Date.now())}`);
  await expect(chips(sheet)).toHaveCount(2);
  await expect(chips(sheet).nth(0)).toHaveAttribute(
    'data-label',
    `${clock(standup)}–${clock(standup + 15 * 60_000)} Standup`,
  );
  await expect(chips(sheet).nth(1)).toHaveAttribute(
    'data-label',
    `${clock(sync)}–${clock(sync + 30 * 60_000)} Weekly sync with Priya`,
  );
  await expect(chips(sheet).nth(1).locator('.n-meet-join')).toHaveAttribute(
    'data-join',
    'https://meet.google.com/abc-defg-hij',
  );
  await expect(sheet.getByRole('complementary', { name: 'Daily Note details' })).toContainText('Meetings02');

  // Write a note under the Weekly sync chip: the caret past the chip (End), Enter, Tab, and type.
  const syncBlock = sheet.locator(
    '[data-block-text]:has([data-chip="event"][data-label$="Weekly sync with Priya"])',
  );
  const syncId = (await syncBlock.getAttribute('data-block-id')) as string;
  // (Focused rather than clicked: a click on the card would open the event.)
  await syncBlock.focus();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Tab');
  await window.keyboard.type('Priya owns the launch checklist');
  await expect.poll(() => savedChildren(window, syncId)).toEqual(['Priya owns the launch checklist']);

  // The Dashboard's side column shows tomorrow's schedule.
  await tab(window, 'Dashboard').click();
  await expect(window.getByRole('region', { name: 'Meetings · Tomorrow' })).toContainText('Dentist');

  // Both meetings are cancelled in Google; opening the Calendar Section syncs.
  google.cancelEvent(ALEX.sub, PRIMARY, 'sync');
  google.cancelEvent(ALEX.sub, PRIMARY, 'standup');
  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  await expect(section.getByTestId('calendar-event').filter({ hasText: 'Standup' })).toHaveCount(0);

  // Back in Notes: the Weekly sync chip shows struck through as Cancelled, the note still under it;
  // the standup's chip, with nothing under it, is gone.
  await tab(window, 'Notes').click();
  await expect(chips(sheet)).toHaveCount(1);
  await expect(chips(sheet).first()).toHaveAttribute('data-state', 'struck');
  await expect(chips(sheet).first().locator('.n-meet-note')).toHaveAttribute('data-note', 'Cancelled');
  await expect(chips(sheet).first().locator('.n-meet-join')).toHaveCount(0);
  await expect(
    sheet.locator('[data-block-text]', { hasText: 'Priya owns the launch checklist' }),
  ).toBeVisible();
  expect(await savedChildren(window, syncId)).toEqual(['Priya owns the launch checklist']);
  await expect(sheet.getByRole('complementary', { name: 'Daily Note details' })).toContainText('Meetings00');
});

test('the heads-up is off by default; turned on, it comes 2 minutes before a meeting and opens it', async () => {
  test.setTimeout(90_000);
  // Starting in under 2 minutes: due at once, and for long enough to turn the setting on.
  const start = Date.now() + 115_000;
  primary([timed('review', 'Design review', start, 30)]);
  const { app, window } = await connectGoogle();
  const shown = () =>
    app.evaluate(() =>
      (
        globalThis as unknown as { commanderTestHooks: { meetingHeadsUps: () => { title: string }[] } }
      ).commanderTestHooks.meetingHeadsUps(),
    );

  // Off by default: the Core looks every 10 seconds, and says nothing.
  await settingsPage(window, 'Calendar');
  const headsUp = window.getByRole('switch', { name: 'Notify me 2 minutes before a meeting' });
  await expect(headsUp).toHaveAttribute('aria-checked', 'false');
  await tab(window, 'Calendar').click();
  // (Synced: the Agenda has it, on two days if it runs past midnight.)
  await expect(window.getByTestId('section-calendar').getByTestId('calendar-event').first()).toContainText(
    'Design review',
  );
  await window.waitForTimeout(11_000);
  expect(await shown()).toEqual([]);

  // On: it comes within the next look, with the meeting's title and time, and only once.
  await openSettings(window, 'Calendar');
  await headsUp.click();
  await expect(headsUp).toHaveAttribute('aria-checked', 'true');
  await expect.poll(shown, { timeout: 20_000 }).toEqual([
    expect.objectContaining({
      title: 'Design review',
      body: `${clock(start)}–${clock(start + 30 * 60_000)} · starts in 2 minutes`,
    }),
  ]);

  // Clicking it opens the event in the Calendar Section.
  await app.evaluate(() =>
    (
      globalThis as unknown as { commanderTestHooks: { clickMeetingHeadsUp: (index: number) => void } }
    ).commanderTestHooks.clickMeetingHeadsUp(0),
  );
  const pane = window.getByTestId('section-calendar').getByRole('region', { name: 'Event detail' });
  await expect(pane.getByRole('heading', { name: 'Design review' })).toBeVisible();
});
