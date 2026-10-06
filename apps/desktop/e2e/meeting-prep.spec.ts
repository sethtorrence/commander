import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { expect, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Meeting prep end to end (#130), against a fake Google and a fake OpenAI-compatible server standing in
// for Z.ai: a meeting 30 minutes away syncs → Ares prepares it, and the prep shows folded under its
// chip in today's Daily Note (and in the event's pane) → the invitation's request becomes a Todo made
// from the event → `U` says the prep is ready → Prepare now refreshes it → the meeting's Dashboard row
// shows it once the meeting is near. The keys go in the real keyring, so this needs the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIMARY = ALEX.email;
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (time: number) => `${pad(new Date(time).getHours())}:${pad(new Date(time).getMinutes())}`;
const dayOf = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// What the fake model says: the prep names the invitation (its first block) as its source; the
// invitation asks for the deck to be read; every other job has nothing to say.
let about = 'Reviewing the launch checklist';
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const refs = [...(messages.at(-1)?.content ?? '').matchAll(/label="(S\d+) · ([^"]*)"/g)];
  const meeting = refs.find(([, , what]) => what?.startsWith('Meeting'))?.[1] ?? 'S1';
  if (system.includes('prepare the User for a meeting'))
    return {
      json: chatCompletion(
        JSON.stringify({
          about: { text: about, sources: [meeting] },
          raise: [{ text: 'Ask Priya about the vendor contract', sources: [meeting] }],
          open: [{ text: 'Something with nothing behind it', sources: ['S99'] }],
        }),
        { prompt: 3_000, completion: 400 },
      ),
      delayMs: 300,
    };
  if (system.includes('asks the User to do'))
    return {
      json: chatCompletion(
        JSON.stringify({ todos: [{ title: 'Read the deck', sources: [meeting], confidence: 0.95 }] }),
      ),
    };
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('asked for their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  google = await startFakeGoogle();
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  about = 'Reviewing the launch checklist';
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await google?.close();
  await server?.close();
});

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page) {
  await openSettings(window);
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-meeting-prep-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

const prepCalls = () =>
  server.requests.filter((request) =>
    ((request.body.messages as { content: string }[])[0]?.content ?? '').includes(
      'prepare the User for a meeting',
    ),
  );

test('a meeting 30 minutes away → prep under its chip → U says it is ready → Prepare now refreshes it', async () => {
  test.setTimeout(120_000);
  // 29 minutes from now, so its time to be prepared has come; it must still be today.
  const start = Date.now() + 29 * 60_000;
  test.skip(dayOf(start) !== dayOf(Date.now()), 'too close to midnight for a meeting later today');
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
          id: 'sync',
          summary: 'Weekly sync with Priya',
          htmlLink: 'https://www.google.com/calendar/event?eid=sync',
          description: 'Please read the deck before we meet.',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + 30 * 60_000).toISOString() },
          organizer: { email: PRIMARY, self: true },
          attendees: [
            { email: PRIMARY, self: true, organizer: true, responseStatus: 'accepted' },
            { email: 'priya@titanlink.test', displayName: 'Priya Patel', responseStatus: 'accepted' },
          ],
        },
      ],
    },
  ]);

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
  const page = await commander.window();
  await connectFakeModel(page);
  // Connect Google (the fake approves its consent page at once): the sync brings the meeting, and Ares
  // prepares it at once, as its half hour has begun.
  await app.evaluate(({ shell }, authorize) => {
    shell.openExternal = async (url: string) => {
      if (url.startsWith(authorize)) await fetch(url);
    };
  }, google.authorizeUrl);
  const accounts = page.getByTestId('accounts-panel').getByTestId('source-google');
  await accounts.getByRole('button', { name: 'Connect Google' }).click();
  await expect(accounts.getByTestId('calendar-switches').getByRole('switch')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Under the meeting's chip in today's Daily Note: its Prep, ready and folded.
  await tab(page, 'Notes').click();
  const sheet = page.locator(`#day-${dayOf(Date.now())}`);
  const prep = sheet.getByTestId('meeting-prep');
  await expect(prep).toHaveCount(1);
  await expect(prep.getByTestId('meeting-prep-state')).toHaveText(/^Ready · \d\d:\d\d$/, { timeout: 30_000 });
  await expect(prep.getByTestId('prep-body')).toHaveCount(0);
  await prep.getByRole('button', { name: 'Prep', exact: true }).click();
  const lines = prep.getByTestId('prep-line');
  // The line with no real source was dropped; each kept line names its source.
  await expect(lines).toHaveText([
    /Reviewing the launch checklist.*Invite/,
    /Ask Priya about the vendor contract.*Invite/,
  ]);
  // Not Blocks: the chip has nothing written under it.
  await expect(sheet.locator('[data-block-text]', { hasText: 'Reviewing the launch checklist' })).toHaveCount(
    0,
  );
  // One Deep call at high thinking, through the prompt builder: the invitation is an outside block.
  const call = prepCalls()[0]?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('high');
  expect(call.messages.at(-1)?.content).toMatch(
    /label="S1 · Meeting · Weekly sync with Priya" source="outside">/,
  );

  // The invitation asked for something: a Todo of Ares's, made from the event.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const [todo] = await window.commander.itemStore({
          op: 'query',
          query: { kinds: ['todo'], titleContains: 'deck' },
        });
        if (!todo) return null;
        const view = await window.commander.itemStore({ op: 'get', itemId: todo.id });
        return {
          title: todo.title,
          origin: todo.detail?.kind === 'todo' ? todo.detail.origin : null,
          madeFrom: view?.links.filter((link) => link.type === 'made-from').map((link) => link.to.kind),
        };
      }),
    )
    .toEqual({ title: 'Read the deck', origin: 'ares', madeFrom: ['event'] });

  // U: the Update says the prep is ready, as Needs you now.
  await tab(page, 'Dashboard').click();
  await page.keyboard.press('u');
  const panel = page.getByTestId('update-panel');
  await expect(panel.getByTestId('update-line').filter({ hasText: 'Prep for' })).toContainText(
    new RegExp(`Prep for “Weekly sync with Priya” at ${clock(start)} (today|tomorrow) is ready`),
  );
  await expect(panel).toContainText('Needs you now');
  await page.keyboard.press('Escape');

  // Prepare now: Ares prepares it again, and the prep under the chip follows.
  about = 'The vendor contract comes first';
  await tab(page, 'Notes').click();
  await prep.getByRole('button', { name: 'Prepare now' }).click();
  await expect(lines.first()).toContainText('The vendor contract comes first', { timeout: 30_000 });
  expect(prepCalls()).toHaveLength(2);

  // In the event's detail pane too (clicking the chip opens it in the Calendar Section).
  await sheet.locator('[data-chip="event"]').first().click();
  const pane = page.getByTestId('section-calendar').getByRole('region', { name: 'Event detail' });
  await expect(pane.getByTestId('event-prep').getByTestId('prep-line').first()).toContainText(
    'The vendor contract comes first',
  );

  // Every run is on the Usage page, under its name.
  await openSettings(page);
  const usage = page.getByTestId('usage-panel');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  await expect(usage.getByTestId('usage-by-job')).toContainText('Prepare for meetings');
  await page.keyboard.press('Escape');

  // Ten minutes before the meeting (the window's clock moved on), its row is in Now, with its prep.
  await page.clock.install({ time: start - 10 * 60_000 });
  await page.reload();
  await tab(page, 'Dashboard').click();
  const row = page
    .getByTestId('section-dashboard')
    .getByTestId('dashboard-row')
    .filter({ hasText: 'Weekly sync with Priya' });
  await expect(row).toHaveAttribute('data-band', 'now');
  await expect(row.getByTestId('row-prep')).toContainText('The vendor contract comes first');
});
