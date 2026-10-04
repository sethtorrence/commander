import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares's scheduler end to end (#132), against a fake Google (sign-in and the Calendar API, free/busy
// included) and a fake OpenAI-compatible server standing in for Z.ai, never the real ones:
// - The User types "call with Leo Tuesday at 2" in today's Daily Note → Ares's card beside the Block
//   ("Call with Leo · 30 min · Tue …, you're free", Leo's address from an earlier event) → Send your
//   booking link instead copies the text (Leo is outside) → Create → the event is in Google Calendar
//   with Leo invited (sendUpdates=all) and in the Agenda.
// - Find time… from the palette: slots narrowed by a colleague's free/busy, and the outsider said to be
//   unchecked.
// Tokens and the model's key live in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIMARY = ALEX.email;
const LEO = { email: 'leo.park@acme.test', displayName: 'Leo Park' };
const BOOKING_LINK = 'https://calendar.app.google/e2eBookMe';
const DAY = 24 * 60 * 60_000;

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  server = await startFakeOpenAIServer();
  // Last week's renewal call with Leo: how Commander knows Leo's address.
  const lastWeek = Math.floor((Date.now() - 6 * DAY) / 3_600_000) * 3_600_000;
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
        {
          id: 'renewal',
          summary: 'Acme renewal',
          start: { dateTime: new Date(lastWeek).toISOString() },
          end: { dateTime: new Date(lastWeek + 3_600_000).toISOString() },
          organizer: { email: PRIMARY, self: true },
          attendees: [
            { email: PRIMARY, self: true, organizer: true, responseStatus: 'accepted' },
            { ...LEO, responseStatus: 'accepted' },
          ],
        },
      ],
    },
  ]);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await server?.close();
});

async function standInForTheBrowser(app: ElectronApplication, ...followed: string[]) {
  await app.evaluate(({ shell }, prefixes) => {
    shell.openExternal = async (url: string) => {
      if (prefixes.some((prefix) => url.startsWith(prefix))) await fetch(url);
    };
  }, followed);
}

// The fake model: "Propose events" turns "call with Leo Tuesday at 2" into a call with Leo at 14:00 on
// the first Tuesday after today (by the days the prompt lists); every other job finds nothing.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const instructions = messages[0]?.content ?? '';
  const content = messages.at(-1)?.content ?? '';
  if (instructions.includes('propose each as a calendar event')) {
    const ref = /\[(B\d+)\] call with Leo Tuesday at 2/.exec(content)?.[1];
    const tuesdays = [...content.matchAll(/Tue \d+ \w+ = (\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]);
    const today = /\((\d{4}-\d{2}-\d{2})\)/.exec(content)?.[1];
    const tuesday = tuesdays.find((day) => day !== today);
    const events =
      ref && tuesday
        ? [
            {
              blockId: ref,
              title: 'Call with Leo',
              attendees: ['Leo'],
              durationMinutes: 30,
              when: { at: `${tuesday}T14:00` },
              confidence: 0.92,
            },
          ]
        : [];
    return { json: chatCompletion(JSON.stringify({ events }), { prompt: 1_400, completion: 120 }) };
  }
  if (instructions.includes('things the User needs to do')) return { json: chatCompletion('{"todos":[]}') };
  return { json: chatCompletion('{}') };
}

async function connectFakeModel(page: Page) {
  const ares = page.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await page.getByTestId('model-settings-save').click();
  await expect(page.getByTestId('model-settings-saved')).toBeVisible();
  await page.getByTestId('model-key-input').fill('zai-e2e-scheduler-key');
  await page.getByTestId('model-key-save').click();
  await expect(page.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

const todayKey = (page: Page) =>
  page.evaluate(() => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });

async function openNotes(page: Page): Promise<Locator> {
  await page.evaluate(() =>
    window.commander.itemStore({ op: 'save-daily-template', template: { blocks: [] } }),
  );
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${await todayKey(page)}`);
  await expect(sheet).toBeVisible();
  return sheet;
}

test('“call with Leo Tuesday at 2” → Ares’s card → booking link → Create → the event in the Agenda with Leo invited', async () => {
  test.setTimeout(120_000);
  server.respondWith(model);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_HOOKS: '1',
      COMMANDER_TEST_ARES_PAUSE_MS: '1500',
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
  const page = await commander.window();
  await standInForTheBrowser(commander.app, google.authorizeUrl);

  // Connect Google and the model; save the booking link in Settings → Calendar.
  await openSettings(page);
  const accounts = page.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  await connectFakeModel(page);
  const scheduling = page.getByTestId('scheduling-settings');
  await scheduling.getByRole('textbox', { name: 'Google booking link' }).fill(BOOKING_LINK);
  await scheduling.getByRole('button', { name: 'Save' }).click();
  await expect(scheduling.getByRole('button', { name: 'Remove' })).toBeVisible();
  // Leo's address arrives with the calendar sync.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['event'] } })))
          .length,
    )
    .toBe(1);

  // The User writes the call in today's note and pauses.
  const sheet = await openNotes(page);
  await sheet.locator('[data-block-text]').first().click();
  await page.keyboard.type('call with Leo Tuesday at 2');

  // Ares's card beside the Block: the event, its time, the User free, Leo invited.
  const card = sheet.getByRole('group', { name: 'Event suggested by Ares: Call with Leo' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId('meeting-headline')).toHaveText(
    /^Call with Leo · 30 min · Tue \d+ \w+ 14:00$/,
  );
  await expect(card.getByTestId('meeting-status')).toHaveText(/14:00, you’re free$/);
  await expect(card.getByRole('list', { name: 'Guests' })).toHaveText(/Leo Park · leo\.park@acme\.test/);
  await expect(card.getByRole('button', { name: 'Create' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Other times' })).toBeVisible();
  await expect(card.getByRole('button', { name: /Edit in Google Calendar/ })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  // One Deep call at high thinking for it, on the Usage page as "Propose events".
  const call = server.requests.find((request) =>
    (request.body.messages as { content: string }[])[0]?.content.includes('propose each as a calendar event'),
  )?.body as { reasoning_effort: string };
  expect(call.reasoning_effort).toBe('high');
  // Nothing is in Google Calendar until the User says Create.
  expect(google.eventsOn(ALEX.sub, PRIMARY).map((event) => event.id)).toEqual(['renewal']);

  // Leo is outside the User's organisations: the booking link is offered, and copied.
  await card.getByRole('button', { name: 'Send your booking link instead' }).click();
  await expect
    .poll(() => commander?.app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(`Book a time here: ${BOOKING_LINK}`);

  // Create: the event goes in Google Calendar with Leo invited, and Google sends the invitation.
  await card.getByRole('button', { name: 'Create' }).click();
  await expect(card).toHaveCount(0);
  const made = () => google.eventsOn(ALEX.sub, PRIMARY).find((event) => event.summary === 'Call with Leo');
  await expect.poll(made, { timeout: 20_000 }).toBeTruthy();
  expect(made()).toMatchObject({
    attendees: [LEO],
    transparency: 'opaque',
    extendedProperties: { private: { commander: 'meeting' } },
  });
  expect(made()?.visibility).toBeUndefined();
  expect(
    google.calendarRequests.some((request) =>
      request.startsWith(`/calendar/v3/calendars/${PRIMARY}/events?sendUpdates=all`),
    ),
  ).toBe(true);

  // In the Agenda, with Leo among its guests.
  await tab(page, 'Calendar').click();
  const section = page.getByTestId('section-calendar');
  const row = section.getByTestId('calendar-event').filter({ hasText: 'Call with Leo' });
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await row.click();
  await expect(section.getByTestId('event-guests')).toContainText('Leo Park');
  // Made from the Block it was written in.
  await expect(section.getByRole('region', { name: 'Event detail' })).toContainText(
    'call with Leo Tuesday at 2',
  );
});

test('Find time… finds slots free for the User and a colleague, and says the outsider couldn’t be checked', async () => {
  test.setTimeout(90_000);
  server.respondWith(model);
  commander = await launchCommander({
    env: {
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
  const page = await commander.window();
  await standInForTheBrowser(commander.app, google.authorizeUrl);
  await openSettings(page);
  const accounts = page.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  // Priya works where the User's Google Account does: Google shares her free/busy (busy for 2 weeks
  // but for one hour, the day after tomorrow at 10:00 local time).
  const free = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
    date.setHours(10, 0, 0, 0);
    return date.getTime();
  });
  const now = Date.now();
  google.setFreeBusy('priya@gmail.test', [
    { start: now - DAY, end: free },
    { start: free + 3_600_000, end: now + 30 * DAY },
  ]);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('palette');
  await palette.getByRole('combobox', { name: 'Search Commander' }).fill('find time');
  await palette.getByRole('option', { name: /Find time…/ }).click();
  const dialog = page.getByTestId('find-time');
  await dialog.getByLabel('Who').fill('priya@gmail.test, leo@acme.test');
  await dialog.getByRole('combobox', { name: 'How long' }).selectOption('30');
  await dialog.getByRole('combobox', { name: 'Within' }).selectOption('7');
  await dialog.getByRole('button', { name: 'Find time' }).click();

  // Only the hour Priya is free, in 30-minute slots: 10:00 and 10:30.
  const times = dialog.getByRole('list', { name: 'Free times' }).getByRole('button');
  await expect(times).toHaveText([/ 10:00$/, / 10:30$/], { timeout: 15_000 });
  await expect(dialog.getByTestId('guest-checked')).toHaveText([
    'priya@gmail.test: their calendar was checked too.',
    'leo@acme.test: Outside your organisations: only your calendars were checked.',
  ]);
  expect(google.calendarWrites.some((write) => write.method === 'POST' && write.path === '/freeBusy')).toBe(
    true,
  );

  // Picking a time opens the meeting card; Create makes it with both invited.
  await times.first().click();
  await expect(dialog.getByTestId('meeting-headline')).toHaveText(
    /^Meeting with priya@gmail\.test and leo@acme\.test · 30 min · /,
  );
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
  const made = () =>
    google.eventsOn(ALEX.sub, PRIMARY).find((event) => String(event.summary).startsWith('Meeting with'));
  await expect.poll(made, { timeout: 20_000 }).toBeTruthy();
  expect(made()?.attendees).toEqual([{ email: 'priya@gmail.test' }, { email: 'leo@acme.test' }]);
  const start = made()?.start as { dateTime?: string } | undefined;
  expect(Date.parse(String(start?.dateTime))).toBe(free);
});
