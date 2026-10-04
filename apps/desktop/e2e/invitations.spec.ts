import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import {
  type FakeMicrosoft,
  type FakeOutlookEvent,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Answering invitations end to end (#129), against a fake Google, a fake Microsoft and a fake
// OpenAI-compatible server standing in for Z.ai, on this machine and never the real ones:
//
// - A clashing invitation arrives: Dana's Pricing review on the Google Account overlaps Board prep,
//   which the User accepted on their Outlook Account. It waits in the Dashboard's Today band; after the
//   calendar syncs Ares's "Suggest invitation replies" job sends the clash to the model, and his
//   suggestion shows on the invitation; Send answers it, the reply reaches the fake Google (patching
//   only the User's answer, telling the organiser), and it leaves the Today band.
// - Answering from the Calendar Section's row in Outlook: Accept, then Decline, then Ctrl+Z sends
//   the previous answer, each reaching the fake Graph with sendResponse.
//
// Tokens and keys go in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const DEFAULT = 'AAMkAGI2-cal-default=';
const LEO = { name: 'Leo Park', address: 'leo@contoso.test' };
const DANA = { email: 'dana@acme.test', displayName: 'Dana Reyes' };
const REASON = 'You’re already in Board prep with Leo then';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const graphTime = (time: number) => ({
  dateTime: `${new Date(time).toISOString().slice(0, 23)}0000`,
  timeZone: 'UTC',
});

function outlookEvent(
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
    isOrganizer: false,
    showAs: 'busy',
    sensitivity: 'normal',
    type: 'singleInstance',
    webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}`,
    organizer: { emailAddress: LEO },
    attendees: [
      { type: 'required', status: { response: 'accepted' }, emailAddress: LEO },
      {
        type: 'required',
        status: { response: 'none' },
        emailAddress: { name: SAM.displayName, address: SAM.userPrincipalName },
      },
    ],
    responseStatus: { response: 'notResponded', time: '0001-01-01T00:00:00Z' },
    body: { contentType: 'text', content: '' },
    ...extra,
  };
}

// The fake model: the invitation job declines the clashing invitation (by the reference its prompt
// gave it); every other job gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const material = messages.at(-1)?.content ?? '';
  if (system.includes("You look after the User's calendar")) {
    const replies = [...material.matchAll(/label="(I\d+) · Invitation"/g)].map(([, ref]) => ({
      ref,
      reply: 'decline',
      reason: REASON,
      confidence: 0.9,
    }));
    return { json: chatCompletion(JSON.stringify({ replies }), { prompt: 1_400, completion: 60 }) };
  }
  if (system.includes("rank the User's Dashboard"))
    return { json: chatCompletion(JSON.stringify({ ranking: [] })) };
  return { json: chatCompletion(JSON.stringify({ todos: [], filings: [] })) };
}

async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-invitations-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

// The system browser: follows the sign-in pages (which the fakes approve at once) back to Commander.
async function standInForTheBrowser(app: ElectronApplication, signIns: string[]) {
  await app.evaluate(({ shell }, followed) => {
    shell.openExternal = async (url: string) => {
      if (followed.some((prefix) => url.startsWith(prefix))) await fetch(url);
    };
  }, signIns);
}

const rows = (section: Locator) => section.getByTestId('calendar-event');

let google: FakeGoogle | undefined;
let microsoft: FakeMicrosoft;
let server: FakeOpenAIServer | undefined;
let commander: LaunchedCommander | undefined;
// Tomorrow, on a whole hour, so nothing straddles the minute the test runs in.
let tomorrow: number;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  tomorrow = Math.ceil(Date.now() / HOUR) * HOUR + DAY;
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
  await google?.close();
  google = undefined;
  await server?.close();
  server = undefined;
});

const microsoftEnv = () => ({
  COMMANDER_TEST_MICROSOFT: JSON.stringify({
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  }),
});

test('a clashing invitation arrives → Ares suggests declining it → Send → the reply reaches Google', async () => {
  test.setTimeout(120_000);
  server = await startFakeOpenAIServer();
  server.respondWith(model);
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
          id: 'pricingreview',
          summary: 'Pricing review',
          htmlLink: 'https://www.google.com/calendar/event?eid=pricingreview',
          start: { dateTime: new Date(tomorrow).toISOString() },
          end: { dateTime: new Date(tomorrow + HOUR).toISOString() },
          organizer: DANA,
          attendees: [
            { ...DANA, organizer: true, responseStatus: 'accepted' },
            { email: ALEX.email, self: true, responseStatus: 'needsAction' },
          ],
        },
      ],
    },
  ]);
  microsoft.setCalendars(SAM.id, [
    {
      calendar: { id: DEFAULT, name: 'Calendar', isDefaultCalendar: true, canEdit: true },
      events: [
        outlookEvent('AAMkAGI2-evt-boardprep=', 'Board prep', tomorrow + 30 * 60_000, 60, {
          responseStatus: { response: 'accepted', time: '2026-10-01T09:00:00Z' },
        }),
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
  const window = await commander.window();
  await standInForTheBrowser(app, [microsoft.loginUrl, google.authorizeUrl]);

  await openSettings(window);
  await connectFakeModel(window, server);
  const panel = window.getByTestId('accounts-panel');
  await panel.getByTestId('source-google').getByRole('button', { name: 'Connect Google' }).click();
  await expect(
    panel.getByTestId('source-google').getByTestId('calendar-switches').getByRole('switch'),
  ).toHaveCount(1);
  await panel.getByTestId('source-outlook').getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(
    panel.getByTestId('source-outlook').getByTestId('calendar-switches').getByRole('switch'),
  ).toHaveCount(1);
  await window.keyboard.press('Escape');

  // The invitation waits in the Dashboard's Today band.
  await tab(window, 'Dashboard').click();
  const dashboard = window.getByTestId('section-dashboard');
  const today = dashboard.getByRole('region', { name: 'Today', exact: true });
  const invitationRow = today.getByTestId('dashboard-row').filter({ hasText: 'Pricing review' });
  await expect(invitationRow.getByTestId('row-reason')).toContainText('Dana invited you to Pricing review');

  // Once both calendars have synced, Ares's job sends only the clash to the model: one Quick call at
  // low thinking, each event in an outside data block of its own.
  const invitationCalls = () =>
    server?.requests.filter((each) =>
      JSON.stringify(each.body).includes("You look after the User's calendar"),
    ) ?? [];
  await expect.poll(() => invitationCalls().length, { timeout: 30_000 }).toBe(1);
  const call = invitationCalls()[0]?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('low');
  expect(call.messages.at(-1)?.content).toMatch(/label="I1 · Invitation" source="outside">/);
  expect(call.messages.at(-1)?.content).toMatch(/label="E1 · Event" source="outside">/);
  expect(call.messages.at(-1)?.content).toContain('┆ Title: Board prep');

  // His suggestion shows on the invitation, in the Calendar Section, and nothing is answered yet.
  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  const pricing = rows(section).filter({ hasText: 'Pricing review' });
  const suggestion = pricing.getByTestId('suggested-reply');
  await expect(suggestion).toContainText(`Ares suggests: Decline · ${REASON}`);
  expect(google.rsvps).toEqual([]);

  // Send: the answer shows at once, and reaches Google, telling Dana.
  await suggestion.getByRole('button', { name: 'Send' }).click();
  await expect(pricing.getByRole('button', { name: 'Decline' })).toHaveAttribute('aria-pressed', 'true');
  await expect(pricing.getByTestId('suggested-reply')).toHaveCount(0);
  await expect
    .poll(() => google?.rsvps)
    .toEqual([
      {
        sub: ALEX.sub,
        calendarId: ALEX.email,
        eventId: 'pricingreview',
        responseStatus: 'declined',
        sendUpdates: 'all',
      },
    ]);

  // Answered, it leaves the Today band.
  await tab(window, 'Dashboard').click();
  await expect(invitationRow).toHaveCount(0);
});

test('answering from the Calendar row in Outlook: Accept, Decline, then Ctrl+Z sends the previous answer', async () => {
  test.setTimeout(90_000);
  microsoft.setCalendars(SAM.id, [
    {
      calendar: { id: DEFAULT, name: 'Calendar', isDefaultCalendar: true, canEdit: true },
      events: [outlookEvent('AAMkAGI2-evt-offsite=', 'Offsite planning', tomorrow, 120)],
    },
  ]);
  commander = await launchCommander({ env: microsoftEnv() });
  const { app } = commander;
  const window = await commander.window();
  await standInForTheBrowser(app, [microsoft.loginUrl]);
  await openSettings(window);
  const outlook = window.getByTestId('accounts-panel').getByTestId('source-outlook');
  await outlook.getByRole('button', { name: 'Connect Outlook' }).click();
  await expect(outlook.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  await window.keyboard.press('Escape');

  await tab(window, 'Calendar').click();
  const section = window.getByTestId('section-calendar');
  const offsite = rows(section).filter({ hasText: 'Offsite planning' });
  const answers = offsite.getByRole('group', { name: 'Answer Offsite planning' });
  await expect(answers.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'false');

  await answers.getByRole('button', { name: 'Accept' }).click();
  await expect(answers.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => microsoft.rsvps)
    .toEqual([{ userId: SAM.id, eventId: 'AAMkAGI2-evt-offsite=', action: 'accept', sendResponse: true }]);

  await answers.getByRole('button', { name: 'Decline' }).click();
  await expect.poll(() => microsoft.rsvps.map((each) => each.action)).toEqual(['accept', 'decline']);

  // Undo sends the answer it replaced.
  await window.keyboard.press('Control+z');
  await expect(answers.getByRole('button', { name: 'Accept' })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => microsoft.rsvps.map((each) => each.action))
    .toEqual(['accept', 'decline', 'accept']);
});
