import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
  streamedCompletion,
} from '@commander/models/testing';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { ALEX, type FakeGoogle, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Draft and Schedule from a Conversation (#198), end to end, against a fake Google (sign-in, Gmail and
// the Calendar API) and a fake OpenAI-compatible server standing in for Z.ai, never the real ones.
// From the Ares button on Dana's email, "Reply to this saying Thursday works": Ares drafts the reply in
// the pop-up, and Open in composer puts it in the Email Section's composer as an ordinary draft, with
// nothing sent. In the Ares Section, "Find an hour with Leo next week": the event waits as a card
// (Act for you), one key (Enter) confirms it, and it is in Google Calendar with Leo invited. Tokens and
// the model's key go in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const DAY = 86_400_000;
const PRIMARY = ALEX.email;
const LEO = { email: 'leo.park@acme.test', displayName: 'Leo Park' };
const DANA = 'Dana Whitfield <dana@northwind.test>';
const DRAFT = 'Hi Dana,\n\nThursday works for me.\n\nCheers,\nAlex';

type Message = { role: string; content: string };

// The fake model. In a Conversation: from what the User asked and what Commander's note says his Skills
// did so far, the next Skill step or the answer. The drafting call answers with the draft; every other
// job of Ares's gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  if (!system.startsWith('You are Ares. You work inside Commander')) {
    if (system.includes('You draft the User'))
      return { json: chatCompletion(JSON.stringify({ body: DRAFT, confidence: 0.9, steering: [] })) };
    if (system.includes('You learn how the User writes email'))
      return { json: chatCompletion('{"style":null,"steering":[]}') };
    if (system.includes('You sort the User'))
      return { json: chatCompletion('{"bucket":"unsorted","confidence":0.2,"steering":[]}') };
    if (system.includes('look for a Bucket they are missing'))
      return { json: chatCompletion('{"bucket":null}') };
    if (system.includes('You file the User')) return { json: chatCompletion('{"filings":[]}') };
    if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
    if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
    if (system.includes('propose each as a calendar event')) return { json: chatCompletion('{"events":[]}') };
    return { json: chatCompletion('{"todos":[]}') };
  }
  const material = messages.at(-1)?.content.startsWith('<data-') ? (messages.at(-1)?.content ?? '') : '';
  const asked =
    [...messages]
      .reverse()
      .find((message) => message.role === 'user' && !message.content.startsWith('<data-'))?.content ?? '';
  const stream = (text: string): FakeReply => ({
    sse: streamedCompletion(text.match(/[\s\S]{1,12}/g) ?? [], { prompt: 400, completion: 40 }),
    sseEveryMs: 20,
  });
  if (asked.startsWith('Reply to this')) {
    if (!material.includes('Draft: ')) return stream('[skill]\n{"skill":"draft","input":{"item":"I1"}}');
    return stream('[their-data]\nHere’s a reply for you to send [I1].');
  }
  if (asked.startsWith('Find an hour with Leo')) {
    if (!material.includes('Schedule: '))
      return stream(
        '[skill]\n{"skill":"schedule","input":{"action":"meeting","title":"Call with Leo","with":["Leo"],"minutes":60,"when":"next-week"}}',
      );
    return stream('[their-data]\nIt’s ready for you to confirm.');
  }
  return stream('[chat]\nHello.');
}

let google: FakeGoogle;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  google = await startFakeGoogle();
  google.gmail.deliver(ALEX.email, {
    from: DANA,
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Q4 offsite dates',
    text: 'Which dates work for you for the Q4 offsite?',
    date: Date.now() - 60 * 60_000,
    labels: ['INBOX', 'UNREAD'],
    messageId: '<offsite-1@mail.northwind.test>',
  });
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

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(page: Page) {
  await settingsPage(page, 'Ares');
  const ares = page.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await page.getByTestId('model-settings-save').click();
  await expect(page.getByTestId('model-settings-saved')).toBeVisible();
  await page.getByTestId('model-key-input').fill('zai-e2e-draft-schedule-key');
  await page.getByTestId('model-key-save').click();
  await expect(page.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function say(thread: Locator, text: string) {
  const input = thread.getByRole('textbox', { name: 'Message Ares' });
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const draftingCalls = () =>
  server.requests.filter((each) => JSON.stringify(each.body).includes('You draft the User'));

test('a reply drafted from the Ares button opens in the composer unsent, and an event Ares prepares is confirmed with one key', async () => {
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
      COMMANDER_TEST_MODEL_IN_CLOUD: '1',
    },
  });
  const page = await commander.window();
  await commander.app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
  // Ares's own jobs stay out of the way: only what the User asks for happens here.
  for (const job of ['suggest-todos', 'file-into-projects', 'sort-into-buckets', 'draft-email-replies']) {
    await page.evaluate(
      (job) => window.commander.autonomy({ op: 'set-job-enabled', job, enabled: false }),
      job,
    );
  }

  await openSettings(page, 'Accounts');
  await connectFakeModel(page);
  await settingsPage(page, 'Accounts');
  const googleSource = page.getByTestId('accounts-panel').getByTestId('source-google');
  await googleSource.getByRole('button', { name: 'Connect Google' }).click();
  await expect(googleSource.getByTestId('account-synced').first()).toBeVisible({ timeout: 20_000 });
  // Leo's address arrives with the calendar sync.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.commander.itemStore({ op: 'query', query: { kinds: ['event'] } })))
          .length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await page.keyboard.press('Escape');

  // Draft: from the Ares button on Dana's thread, once Alex lets Ares read his mail.
  await tab(page, 'Email').click();
  const email = page.getByTestId('section-email');
  await email
    .getByRole('region', { name: `Ares and ${ALEX.email}` })
    .getByRole('button', { name: 'Allow', exact: true })
    .click();
  await email.getByTestId('email-thread').filter({ hasText: 'Q4 offsite dates' }).click();
  const reader = email.getByRole('region', { name: 'Thread' });
  await reader.getByRole('button', { name: 'Ask Ares about Q4 offsite dates' }).click();
  const popup = page.getByTestId('ares-popup');
  await expect(popup).toBeVisible();
  await say(popup, 'Reply to this saying Thursday works');
  const answer = popup.getByTestId('conversation-turn').nth(1);
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  const draft = answer.getByRole('region', { name: 'Draft reply: Q4 offsite dates' });
  await expect(draft.getByTestId('conversation-draft-body')).toContainText('Thursday works for me.');
  await expect(draft).toContainText('Sent only when you press Send');
  // The User's own words went to the drafting call as what the reply should say.
  expect(draftingCalls()).toHaveLength(1);
  expect(JSON.stringify(draftingCalls()[0]?.body)).toContain('Reply to this saying Thursday works');
  // Nothing has reached Gmail.
  expect(google.gmail.drafts(ALEX.email)).toEqual([]);
  expect(google.gmail.sent).toEqual([]);

  // Open in composer: the pop-up goes, and the draft is in the composer below the thread.
  await draft.getByRole('button', { name: 'Open in composer' }).click();
  await expect(popup).toHaveCount(0);
  const composer = email.getByRole('region', { name: 'Reply' });
  await expect(composer).toBeVisible();
  await expect(composer).toContainText('Thursday works for me.');
  // An ordinary draft, saved to Gmail's Drafts; still nothing sent.
  await expect.poll(() => google.gmail.drafts(ALEX.email).length, { timeout: 20_000 }).toBe(1);
  expect(google.gmail.sent).toEqual([]);

  // Schedule: in the Ares Section, the event waits as a card, and one key confirms it.
  await tab(page, 'Ares').click();
  const section = page.getByTestId('section-ares');
  const conversations = section.getByTestId('conversations');
  await conversations.scrollIntoViewIfNeeded();
  const thread = conversations.getByTestId('conversation-thread');
  await say(thread, 'Find an hour with Leo next week');
  const scheduled = thread.getByTestId('conversation-turn').nth(1);
  await expect(scheduled).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  const card = scheduled.getByTestId('conversation-action');
  await expect(card).toHaveAttribute('data-status', 'waiting');
  await expect(card).toContainText(
    /Put “Call with Leo” in your calendar, .+, and invite leo\.park@acme\.test/,
  );
  await expect(card).toContainText('Asks first: other people will see it.');
  // Nothing is in Google Calendar until the User confirms.
  expect(google.eventsOn(ALEX.sub, PRIMARY).map((event) => event.id)).toEqual(['renewal']);
  await expect(card.getByRole('button', { name: /Confirm/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-status', 'confirmed');
  const made = () => google.eventsOn(ALEX.sub, PRIMARY).find((event) => event.summary === 'Call with Leo');
  await expect.poll(made, { timeout: 20_000 }).toBeTruthy();
  expect(made()).toMatchObject({ attendees: [LEO] });
  // Next week, inside working hours, an hour long.
  const event = made() as unknown as { start: { dateTime: string }; end: { dateTime: string } };
  const [start, end] = [event.start, event.end].map((time) => new Date(time.dateTime).getTime()) as [
    number,
    number,
  ];
  expect(end - start).toBe(3_600_000);
  expect(start).toBeGreaterThan(Date.now());

  // In Ares's activity, with the Conversation as its cause.
  const activity = section.getByRole('list', { name: 'Ares’s activity' });
  await activity.scrollIntoViewIfNeeded();
  await expect(
    activity.getByRole('listitem', { name: /^Schedule: / }).getByTestId('activity-conversation'),
  ).toHaveText('Asked for in your Conversation Find an hour with Leo next…');
  // Still nothing sent.
  expect(google.gmail.sent).toEqual([]);
});
