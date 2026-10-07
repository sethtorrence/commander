import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Email meets Calendar and Todos, end to end (#144), against a fake Google (Gmail and Google Calendar)
// and a fake OpenAI-compatible server standing in for Z.ai, on this machine and never the real ones:
//
// - Dana's invitation email shows its Invitation card above the message, its event found in the
//   Account's calendar; Accept answers the event exactly as from Calendar, reaching the fake Google.
// - Her "Can you send me the Q3 numbers by Friday?" is sorted into Needs reply, and Ares suggests a
//   Todo for it on the thread; Add makes it, with a made-from Link to the email.
// - Her "How about Thursday at 3?" gets a proposed event on the thread, a chained suggestion showing
//   its cause; Dana is outside the User's organisations, so Reply with your booking link opens a reply
//   holding it; Create makes the event in Google Calendar with Dana invited.
//
// Tokens and the model's key go in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const DANA = 'Dana Reyes <dana@acme.test>';
const UID = 'pricing-e2e-5k2m8q1v7c@google.com';
const BOOKING_LINK = 'https://calendar.app.google/e2eBookMe';

// The fake model: Dana's two questions are Needs reply; the request asks for a Todo (below the
// confidence bar, so it waits as a suggestion); "Thursday at 3" is a call on the first Thursday after
// today (by the days the prompt lists). Every other job finds nothing.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  const reply = (value: unknown) => ({
    json: chatCompletion(JSON.stringify({ ...(value as object), steering: [] })),
  });
  if (system.includes('You sort the User')) {
    const asks = prompt.includes('Q3 numbers') || prompt.includes('Thursday at 3');
    return reply(
      asks
        ? { bucket: 'Needs reply', confidence: 0.95, reason: 'Dana asks' }
        : { bucket: 'unsorted', confidence: 0.2 },
    );
  }
  if (system.includes('find what it asks the User to do')) {
    const todos = prompt.includes('Q3 numbers')
      ? [{ title: 'Send Dana the Q3 numbers', dueOn: null, confidence: 0.6 }]
      : [];
    return reply({ todos });
  }
  if (system.includes('spot a meeting, call or time together')) {
    const today = /\((\d{4}-\d{2}-\d{2})\)/.exec(prompt)?.[1];
    const thursday = [...prompt.matchAll(/Thu \d+ \w+ = (\d{4}-\d{2}-\d{2})/g)]
      .map((match) => match[1])
      .find((day) => day !== today);
    const events =
      prompt.includes('Thursday at 3') && thursday
        ? [
            {
              title: 'Call with Dana',
              attendees: ['Dana'],
              durationMinutes: 30,
              when: { at: `${thursday}T15:00` },
              confidence: 0.9,
            },
          ]
        : [];
    return reply({ events });
  }
  if (system.includes('You learn how the User writes email')) return reply({ style: 'Short and friendly.' });
  if (system.includes('You draft the User'))
    return reply({ body: 'Hi Dana,\n\nThanks!\n\nAlex', confidence: 0.5 });
  if (system.includes('look for a Bucket they are missing')) return reply({ bucket: null });
  if (system.includes('You file the User')) return reply({ filings: [] });
  if (system.includes("rank the User's Dashboard")) return reply({ ranking: [] });
  if (system.includes('their Update')) return reply({ lines: [] });
  return reply({ todos: [] });
}

async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  await settingsPage(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-email-calendar-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function standInForTheBrowser(app: ElectronApplication, ...followed: string[]) {
  await app.evaluate(({ shell }, prefixes) => {
    shell.openExternal = async (url: string) => {
      if (prefixes.some((prefix) => url.startsWith(prefix))) await fetch(url);
    };
  }, followed);
}

// "20261007T150000Z", as an iCalendar UTC time.
const icsTime = (at: number) => `${new Date(at).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

const reader = (section: Locator) => section.getByRole('region', { name: 'Thread' });

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;
// Tomorrow, on a whole hour, so nothing straddles the minute the test runs in.
let tomorrow: number;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  google = await startFakeGoogle();
  tomorrow = Math.ceil(Date.now() / HOUR) * HOUR + DAY;
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
          id: 'pricingreview',
          iCalUID: UID,
          summary: 'Pricing review',
          htmlLink: 'https://www.google.com/calendar/event?eid=pricingreview',
          start: { dateTime: new Date(tomorrow).toISOString() },
          end: { dateTime: new Date(tomorrow + HOUR).toISOString() },
          organizer: { email: 'dana@acme.test', displayName: 'Dana Reyes' },
          attendees: [
            {
              email: 'dana@acme.test',
              displayName: 'Dana Reyes',
              organizer: true,
              responseStatus: 'accepted',
            },
            { email: ALEX.email, self: true, responseStatus: 'needsAction' },
          ],
        },
      ],
    },
  ]);
  const now = Date.now();
  google.gmail.deliver(ALEX.email, {
    from: DANA,
    to: ALEX.email,
    subject: 'Invitation: Pricing review',
    text: 'You have been invited to the following event: Pricing review.',
    calendar: [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${UID}`,
      'SUMMARY:Pricing review',
      `DTSTART:${icsTime(tomorrow)}`,
      `DTEND:${icsTime(tomorrow + HOUR)}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
    date: now - 3 * HOUR,
  });
  google.gmail.deliver(ALEX.email, {
    from: DANA,
    to: ALEX.email,
    subject: 'Q3 numbers',
    text: 'Hi Alex,\n\nCan you send me the Q3 numbers by Friday?\n\nThanks,\nDana',
    date: now - 2 * HOUR,
  });
  google.gmail.deliver(ALEX.email, {
    from: DANA,
    to: ALEX.email,
    subject: 'Pricing call',
    text: 'Hi Alex,\n\nHow about Thursday at 3 for a quick call about pricing?\n\nDana',
    date: now - HOUR,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await server?.close();
});

test('an invitation answered from the email → a Todo suggested from a request → an event proposed from “Thursday at 3” → Create', async () => {
  test.setTimeout(180_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_GOOGLE: JSON.stringify({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        authorizeUrl: google.authorizeUrl,
        tokenUrl: google.tokenUrl,
        userinfoUrl: google.userinfoUrl,
        gmailUrl: google.gmailUrl,
        calendarUrl: google.calendarUrl,
      }),
    },
  });
  const page = await commander.window();
  await standInForTheBrowser(commander.app, google.authorizeUrl);

  await openSettings(page, 'Accounts');
  await connectFakeModel(page, server);
  await settingsPage(page, 'Accounts');
  const googleSource = page.getByTestId('accounts-panel').getByTestId('source-google');
  await googleSource.getByRole('button', { name: 'Connect Google' }).click();
  await expect(googleSource.getByTestId('account-synced')).toHaveText(/· 3 emails$/, { timeout: 30_000 });
  await expect(googleSource.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  await settingsPage(page, 'Calendar');
  const scheduling = page.getByTestId('scheduling-settings');
  await scheduling.getByRole('textbox', { name: 'Google booking link' }).fill(BOOKING_LINK);
  await scheduling.getByRole('button', { name: 'Save' }).click();
  await expect(scheduling.getByRole('button', { name: 'Remove' })).toBeVisible();
  await page.keyboard.press('Escape');

  await tab(page, 'Email').click();
  const section = page.getByTestId('section-email');
  // Ares reads none of the Account's mail until the User allows it.
  await section
    .getByRole('region', { name: `Ares and ${ALEX.email}` })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();

  // 1. The invitation: its card above the message, its event found; Accept answers it as from Calendar.
  await section.getByTestId('email-thread').filter({ hasText: 'Invitation: Pricing review' }).click();
  const card = reader(section).getByRole('region', { name: 'Invitation' });
  await expect(card).toHaveAttribute('data-state', 'event', { timeout: 30_000 });
  await expect(card.getByTestId('invitation-title')).toHaveText('Pricing review');
  const answers = card.getByRole('group', { name: 'Answer this invitation' });
  await expect(answers.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'false');
  await answers.getByRole('button', { name: 'Accept' }).click();
  await expect(answers.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => google.rsvps, { timeout: 20_000 })
    .toEqual([
      {
        sub: ALEX.sub,
        calendarId: ALEX.email,
        eventId: 'pricingreview',
        responseStatus: 'accepted',
        sendUpdates: 'all',
      },
    ]);
  // The email and its event are linked, from both ends.
  const linked = await page.evaluate(async () => {
    const [event] = await window.commander.itemStore({ op: 'query', query: { kinds: ['event'] } });
    const view = event ? await window.commander.itemStore({ op: 'get', itemId: event.id }) : null;
    return view?.backlinks.map((link) => `${link.type}:${link.from.title}`) ?? [];
  });
  expect(linked).toEqual(['refers-to:Invitation: Pricing review']);

  // 2. Dana's request, sorted into Needs reply: Ares suggests a Todo on the thread, and Add makes it.
  const q3 = section.getByTestId('email-thread').filter({ hasText: 'Q3 numbers' });
  await expect(q3.locator('[data-slot="bucket"]')).toHaveText('Needs reply', { timeout: 30_000 });
  await q3.click();
  const todo = reader(section).getByTestId('email-todo-suggestion');
  await expect(todo).toContainText('Send Dana the Q3 numbers', { timeout: 30_000 });
  await todo.getByRole('button', { name: 'Add' }).click();
  await expect(todo).toHaveCount(0);
  const made = await page.evaluate(async () => {
    const [found] = await window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } });
    const view = found ? await window.commander.itemStore({ op: 'get', itemId: found.id }) : null;
    return {
      title: found?.title,
      origin: found?.detail?.kind === 'todo' ? found.detail.origin : null,
      links: view?.links.map((link) => `${link.type}:${link.to.title}`),
    };
  });
  expect(made).toEqual({
    title: 'Send Dana the Q3 numbers',
    origin: 'ares',
    links: ['made-from:Q3 numbers'],
  });

  // 3. "How about Thursday at 3?": a proposed event on the thread, a chained suggestion with its cause.
  await section.getByTestId('email-thread').filter({ hasText: 'Pricing call' }).click();
  const proposal = reader(section).getByTestId('email-event-proposal');
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(proposal.getByTestId('email-event-cause')).toHaveText(/^Suggested because of Dana’s email, /);
  await expect(proposal.getByTestId('meeting-headline')).toHaveText(
    /^Call with Dana · 30 min · Thu \d+ \w+ 15:00$/,
  );
  await expect(proposal.getByRole('list', { name: 'Guests' })).toHaveText(/dana@acme\.test/);
  for (const name of ['Create', 'Other times', 'Dismiss'])
    await expect(proposal.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(proposal.getByRole('button', { name: /Edit in Google Calendar/ })).toBeVisible();
  // Nothing is in Google Calendar until the User says Create.
  expect(google.eventsOn(ALEX.sub, ALEX.email).map((event) => event.id)).toEqual(['pricingreview']);

  // Dana is outside the User's organisations: Reply with your booking link opens a reply holding it.
  await proposal.getByRole('button', { name: 'Reply with your booking link' }).click();
  const composer = section.getByRole('region', { name: 'Reply' });
  await expect(composer.getByTestId('compose-body')).toContainText(`Book a time here: ${BOOKING_LINK}`);
  expect(google.gmail.sent).toEqual([]);

  // Create: the event goes in Google Calendar with Dana invited.
  await proposal.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(proposal).toHaveCount(0);
  const call = () =>
    google.eventsOn(ALEX.sub, ALEX.email).find((event) => event.summary === 'Call with Dana');
  await expect.poll(call, { timeout: 20_000 }).toBeTruthy();
  expect(call()?.attendees).toEqual([{ email: 'dana@acme.test', displayName: 'Dana Reyes' }]);
});
