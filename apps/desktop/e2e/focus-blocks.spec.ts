import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { type FakeMicrosoft, SAM, startFakeMicrosoft } from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Focus blocks and blocking time across Accounts end to end (#131), against a fake Google (sign-in and
// the Calendar API), a fake Microsoft (sign-in and Graph) and a fake OpenAI-compatible server standing
// in for Z.ai, never the real ones:
// - Plan focus time → Ares's suggestions in the Calendar Section's Focus time panel (and dashed in the
//   Agenda) → Dismiss one → Accept all → the blocks go in a calendar named Commander, made in the Google
//   Account, busy and private → undo one, and it goes from Google Calendar.
// - A pair "personal Google → work Outlook" switched on: a personal event puts a private Busy on the
//   work calendar, which moves and goes with it, and is never copied back.
// Tokens and the model's key live in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIMARY = ALEX.email;
const TODOS = ['Write the Q3 report', 'Fix the login bug', 'Plan the offsite'];

let google: FakeGoogle;
let server: FakeOpenAIServer;
let microsoft: FakeMicrosoft | undefined;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  server = await startFakeOpenAIServer();
  google.setCalendars(ALEX.sub, [
    {
      calendar: {
        id: PRIMARY,
        summary: PRIMARY,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
        primary: true,
      },
      events: [],
    },
  ]);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await server?.close();
  await microsoft?.close();
  microsoft = undefined;
});

// The system browser: follows Google's consent page (which the fake approves at once) back to
// Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication, ...signIns: string[]) {
  await app.evaluate(({ shell }, followed) => {
    shell.openExternal = async (url: string) => {
      if (followed.some((prefix) => url.startsWith(prefix))) await fetch(url);
    };
  }, signIns);
}

const googleEnv = () => ({
  COMMANDER_TEST_GOOGLE: JSON.stringify({
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    authorizeUrl: google.authorizeUrl,
    tokenUrl: google.tokenUrl,
    userinfoUrl: google.userinfoUrl,
    calendarUrl: google.calendarUrl,
  }),
});

const minutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const clock = (total: number) =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

// The fake model's answer to "Block time for Todos": an hour for each Todo it was given, one after
// another in the free time the prompt lists (dates and times as the prompt gives them). Other jobs get
// an empty answer.
function blockTimeForTodos(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  if (!messages[0]?.content.includes('You find time in the User')) return { json: chatCompletion('{}') };
  const content = messages.at(-1)?.content ?? '';
  const refs = [...content.matchAll(/\[(T\d+)\] /g)].map((match) => match[1] as string);
  const slots = [...content.matchAll(/\((\d{4}-\d{2}-\d{2})\): ([^\n]+)/g)].flatMap(([, day, list]) =>
    list === 'none'
      ? []
      : (list ?? '').split(', ').map((each) => {
          const [from, to] = each.split('–');
          return { day: day as string, from: minutes(from ?? ''), to: minutes(to ?? '') };
        }),
  );
  const blocks: unknown[] = [];
  for (const slot of slots) {
    for (let start = slot.from; start + 60 <= slot.to && blocks.length < refs.length; start += 60) {
      blocks.push({
        todoId: refs[blocks.length],
        start: `${slot.day}T${clock(start)}`,
        end: `${slot.day}T${clock(start + 60)}`,
        reason: 'Needs about an hour; you’re free then.',
        confidence: 0.7,
      });
    }
  }
  return { json: chatCompletion(JSON.stringify({ blocks }), { prompt: 2_400, completion: 300 }) };
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(page: Page) {
  const ares = page.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await page.getByTestId('model-settings-save').click();
  await expect(page.getByTestId('model-settings-saved')).toBeVisible();
  await page.getByTestId('model-key-input').fill('zai-e2e-focus-blocks-key');
  await page.getByTestId('model-key-save').click();
  await expect(page.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

test('Plan focus time → suggestions → Accept all → blocks in the Commander calendar → undo one', async () => {
  test.setTimeout(90_000);
  server.respondWith(blockTimeForTodos);
  commander = await launchCommander({ env: googleEnv() });
  const page = await commander.window();
  await standInForTheBrowser(commander.app, google.authorizeUrl);

  // Connect Google and the model, and choose where focus blocks go.
  await openSettings(page);
  const accounts = page.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  await connectFakeModel(page);
  const focusSettings = page.getByTestId('focus-time-settings');
  const where = focusSettings.getByRole('combobox', { name: 'Focus blocks go in' });
  await expect(where.locator('option')).toHaveCount(2);
  const googleAccount = await where.locator('option').nth(1).getAttribute('value');
  await where.selectOption(googleAccount ?? '');
  await expect(where).toHaveValue(googleAccount ?? '');
  // Working hours start as 09:00–18:00, Monday to Friday.
  await expect(focusSettings.getByLabel('Working hours start')).toHaveValue('09:00');
  await expect(focusSettings.getByLabel('Working hours end')).toHaveValue('18:00');
  await expect(focusSettings.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
  await expect(focusSettings.getByRole('button', { name: 'Sunday' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // The User's Todos.
  for (const title of TODOS) {
    await page.evaluate(
      (todo) =>
        window.commander.itemStore({
          op: 'record',
          action: {
            type: 'create',
            item: {
              kind: 'todo',
              title: todo,
              detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
            },
          },
        }),
      title,
    );
  }

  // Plan focus time from the Todos Section: Ares plans, and the Calendar Section shows his suggestions.
  await tab(page, 'Todos').click();
  await page.getByTestId('section-todos').getByRole('button', { name: 'Plan focus time' }).click();
  const section = page.getByTestId('section-calendar');
  await expect(section).toBeVisible();
  // The Focus time panel, in the Section's side column.
  const panel = page.getByRole('region', { name: 'Focus time' });
  const suggestions = panel.getByTestId('focus-suggestion');
  await expect(suggestions).toHaveCount(3, { timeout: 20_000 });
  for (const title of TODOS)
    await expect(panel.getByRole('listitem', { name: `Focus block: Focus: ${title}` })).toBeVisible();
  await expect(suggestions.first()).toContainText('Needs about an hour; you’re free then.');
  // One Deep call, at high thinking.
  const call = server.requests.find((request) =>
    (request.body.messages as { content: string }[])[0]?.content.includes('You find time in the User'),
  )?.body as { reasoning_effort: string };
  expect(call.reasoning_effort).toBe('high');
  // Dashed in the Agenda, on their days.
  await expect(section.getByTestId('focus-suggestion-row')).toHaveCount(3);
  // Nothing is in Google Calendar until the User accepts.
  expect(google.calendarWrites.filter((write) => write.method !== 'GET')).toEqual([]);

  // Dismiss one, then Accept all.
  await panel
    .getByRole('listitem', { name: 'Focus block: Focus: Plan the offsite' })
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await expect(suggestions).toHaveCount(2);
  await panel.getByRole('button', { name: 'Accept all' }).click();
  await expect(suggestions).toHaveCount(0);
  const planned = panel.getByRole('list', { name: 'Planned focus blocks' }).getByRole('listitem');
  await expect(planned).toHaveCount(2);

  // They go in a calendar named Commander, made once in the Google Account: busy, private, marked.
  const commanderCalendar = () =>
    google.calendarsOf(ALEX.sub).find((calendar) => calendar.summary === 'Commander');
  await expect
    .poll(() => google.eventsOn(ALEX.sub, commanderCalendar()?.id ?? '-').length, { timeout: 20_000 })
    .toBe(2);
  expect(
    google.calendarWrites.filter((write) => write.method === 'POST' && write.path.endsWith('/calendars')),
  ).toHaveLength(1);
  const made = google.eventsOn(ALEX.sub, commanderCalendar()?.id ?? '-');
  expect(made.map((event) => event.summary).sort()).toEqual([
    'Focus: Fix the login bug',
    'Focus: Write the Q3 report',
  ]);
  for (const event of made) {
    expect(event).toMatchObject({
      visibility: 'private',
      transparency: 'opaque',
      extendedProperties: { private: { commander: 'focus-block' } },
    });
  }
  // They show in the Agenda, on the Commander calendar once synced.
  await expect(
    section.getByTestId('calendar-event').filter({ hasText: 'Focus: Fix the login bug' }),
  ).toHaveCount(1);
  await expect(page.getByRole('switch', { name: 'Show Commander' })).toBeVisible({ timeout: 20_000 });

  // Undo one: it goes from Google Calendar, and from the Agenda.
  await planned
    .filter({ hasText: 'Focus: Write the Q3 report' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(planned).toHaveCount(1);
  await expect
    .poll(() => google.eventsOn(ALEX.sub, commanderCalendar()?.id ?? '-').map((event) => event.summary))
    .toEqual(['Focus: Fix the login bug']);
  await expect(
    section.getByTestId('calendar-event').filter({ hasText: 'Focus: Write the Q3 report' }),
  ).toHaveCount(0);

  // The block shows on its Todo, Linked: made from it.
  await tab(page, 'Todos').click();
  const todos = page.getByTestId('section-todos');
  await todos
    .getByRole('region', { name: 'Open' })
    .getByRole('listitem')
    .filter({ hasText: 'Fix the login bug' })
    .click();
  const links = todos.getByRole('region', { name: 'Todo detail' }).getByRole('region', { name: 'Links' });
  await expect(links).toContainText('Made into');
  await expect(links).toContainText('Focus: Fix the login bug');
});

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WORK_CALENDAR = 'AAMkAGI2-cal-default=';
// When an event Graph holds starts: calendarView writes times in UTC.
const startOf = (event: { start?: unknown } | undefined) =>
  Date.parse(`${(event?.start as { dateTime?: string } | undefined)?.dateTime}Z`);

test('a pair switched on: a personal event puts a private Busy on the work calendar, which follows it', async () => {
  test.setTimeout(90_000);
  const work = await startFakeMicrosoft();
  microsoft = work;
  // Whole hours, tomorrow, so nothing straddles the minute the test runs in.
  const dentist = Math.ceil(Date.now() / HOUR) * HOUR + DAY;
  const at = (time: number) => ({ dateTime: new Date(time).toISOString() });
  google.putEvent(ALEX.sub, PRIMARY, {
    id: 'dentist',
    summary: 'Dentist',
    location: 'High Street',
    description: 'Bring the forms',
    start: at(dentist),
    end: at(dentist + HOUR),
    organizer: { email: PRIMARY, self: true },
  });
  work.setCalendars(SAM.id, [
    { calendar: { id: WORK_CALENDAR, name: 'Calendar', isDefaultCalendar: true, canEdit: true }, events: [] },
  ]);
  commander = await launchCommander({
    env: {
      ...googleEnv(),
      COMMANDER_TEST_MICROSOFT: JSON.stringify({
        clientId: work.clientId,
        tenantId: work.tenantId,
        loginUrl: work.loginUrl,
        graphUrl: work.graphUrl,
      }),
    },
  });
  const page = await commander.window();
  await standInForTheBrowser(commander.app, google.authorizeUrl, work.loginUrl);

  // Connect both Accounts.
  await openSettings(page);
  const accounts = page.getByTestId('accounts-panel');
  await accounts.getByTestId('source-google').getByRole('button', { name: 'Connect Google' }).click();
  await expect(
    accounts.getByTestId('source-google').getByTestId('calendar-switches').getByRole('switch'),
  ).toHaveCount(1);
  await accounts.getByTestId('source-outlook').getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(
    accounts.getByTestId('source-outlook').getByTestId('calendar-switches').getByRole('switch'),
  ).toHaveCount(1);

  // Off by default; add "personal Google → work Outlook", and the other way round too.
  const focusSettings = page.getByTestId('focus-time-settings');
  const addPair = async (from: string, to: string) => {
    await focusSettings.getByRole('combobox', { name: 'Busy events in' }).selectOption({ label: from });
    await focusSettings.getByRole('combobox', { name: 'Block time in' }).selectOption({ label: to });
    await focusSettings.getByRole('button', { name: 'Add pair' }).click();
  };
  await expect(focusSettings.getByRole('list', { name: 'Pairs' })).toHaveCount(0);
  await addPair(`${PRIMARY} · Google`, `${SAM.userPrincipalName} · Outlook`);
  const personalToWork = focusSettings.getByRole('switch', {
    name: `Block time: ${PRIMARY} → ${SAM.userPrincipalName}`,
  });
  await expect(personalToWork).toHaveAttribute('aria-checked', 'true');
  await addPair(`${SAM.userPrincipalName} · Outlook`, `${PRIMARY} · Google`);
  // Switching a pair on set its action to Auto in the Autonomy grid.
  const autonomy = await page.evaluate(() => window.commander.autonomy({ op: 'settings' }));
  expect(autonomy.settings.actions['block-time-across-accounts']).toBe('auto');

  // The dentist is copied to the work calendar as a private Busy, with nothing else of it.
  const copies = () => work.eventsOn(SAM.id, WORK_CALENDAR);
  await expect.poll(() => copies().length, { timeout: 20_000 }).toBe(1);
  const [copy] = copies();
  expect(copy).toMatchObject({
    subject: 'Busy',
    sensitivity: 'private',
    showAs: 'busy',
    isReminderOn: false,
  });
  expect(JSON.stringify(copy)).not.toMatch(/Dentist|High Street|Bring the forms/);
  expect(startOf(copy)).toBe(dentist);

  // Commander syncs both again whenever the Calendar Section is opened.
  const syncAgain = async () => {
    await tab(page, 'Todos').click();
    await tab(page, 'Calendar').click();
  };
  // The copy comes back with the work calendar's sync, and is never copied back to Google.
  await syncAgain();
  await expect(
    page.getByTestId('section-calendar').getByTestId('calendar-event').filter({ hasText: 'Busy' }),
  ).toHaveCount(1);
  await syncAgain();
  expect(google.eventsOn(ALEX.sub, PRIMARY).map((event) => event.summary)).toEqual(['Dentist']);

  // The dentist moves: so does the copy.
  google.putEvent(ALEX.sub, PRIMARY, {
    id: 'dentist',
    summary: 'Dentist',
    start: at(dentist + 2 * HOUR),
    end: at(dentist + 3 * HOUR),
    organizer: { email: PRIMARY, self: true },
  });
  await syncAgain();
  await expect.poll(() => startOf(copies()[0]), { timeout: 20_000 }).toBe(dentist + 2 * HOUR);

  // The dentist is cancelled: the copy goes.
  google.cancelEvent(ALEX.sub, PRIMARY, 'dentist');
  await syncAgain();
  await expect.poll(() => copies().length, { timeout: 20_000 }).toBe(0);
  expect(google.eventsOn(ALEX.sub, PRIMARY)).toEqual([]);
});
