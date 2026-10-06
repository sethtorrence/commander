import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares turns Chats into work and words end to end (#110): a fake Microsoft Graph and a fake
// OpenAI-compatible server standing in for Z.ai, both on this machine (never the real ones). Omar asks
// the User for the TL budget in a one-to-one Chat; after the sync Ares suggests a Todo beside the
// message (he isn't sure, so it waits), Add makes it, and the Todos Section shows it from Teams. The
// same Chat is waiting on the User, so a suggested reply waits above the reply box; Send puts it in
// Teams as the User's. Then Draft fills the reply box, and the User sends that too. Every call is on
// the Usage page. Tokens and the model key go in the real keyring, so this needs the author's Linux
// Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const OMAR: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a004',
  displayName: 'Omar Haddad',
  userPrincipalName: 'omar@contoso.test',
};
const OMAR_CHAT = '19:omar_sam@unq.gbl.spaces';
const HOUR = 60 * 60_000;
const REASON = 'Omar asked you for the TL budget by Friday';
const SUGGESTED = 'Hi Omar, yes: I’ll send you the TL budget by Friday.';
const DRAFTED = 'One more thing: I’ll add the headcount numbers too.';

type Message = { role: string; content: string };

// The fake model, answering each job by its instructions: the Todos job suggests one for the message
// asking for the TL budget (not sure enough to add it by itself), the waiting job flags the Chat, a
// suggested reply and Draft each get their draft, and every other job gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  const material = messages.at(-1)?.content ?? '';
  if (system.includes('find the things the User needs to do')) {
    const asked = /┆ (M\d+) · NEW · [^\n]*TL budget/.exec(material)?.[1];
    const todos = asked
      ? [{ itemId: 'C1', messageId: asked, title: 'Send Omar the TL budget', dueOn: null, confidence: 0.6 }]
      : [];
    return { json: chatCompletion(JSON.stringify({ todos }), { prompt: 700, completion: 50 }) };
  }
  if (system.includes('spot when someone is waiting on the User')) {
    const blocks = material.split(/\n(?=<data-)/);
    const chats = blocks.flatMap((block) => {
      const ref = /label="(W\d+) · /.exec(block)?.[1];
      if (!ref) return [];
      const asked = /┆ (M\d+) · [^\n]*TL budget/.exec(block)?.[1];
      return [
        asked
          ? { itemId: ref, waiting: true, messageId: asked, reason: REASON }
          : { itemId: ref, waiting: false },
      ];
    });
    return { json: chatCompletion(JSON.stringify({ chats }), { prompt: 900, completion: 60 }) };
  }
  if (system.includes('draft a reply')) {
    const draft = system.includes('Someone is waiting on the User') ? SUGGESTED : DRAFTED;
    return { json: chatCompletion(JSON.stringify({ draft }), { prompt: 1800, completion: 40 }) };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

let microsoft: FakeMicrosoft;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  microsoft = await startFakeMicrosoft();
  microsoft.addChat({
    id: OMAR_CHAT,
    chatType: 'oneOnOne',
    members: [SAM, OMAR],
    updatedAt: Date.now() - 48 * HOUR,
  });
  microsoft.postMessage(OMAR_CHAT, OMAR, '<p>Morning! Good game last night.</p>', Date.now() - 3 * HOUR);
  microsoft.postMessage(
    OMAR_CHAT,
    OMAR,
    '<p>Can you send me the TL budget by Friday?</p>',
    Date.now() - 20 * 60_000,
  );
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
  await server?.close();
});

function pointAtFakeMicrosoft() {
  const config = {
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  };
  return { COMMANDER_TEST_MICROSOFT: JSON.stringify(config) };
}

// The system browser: sign-in follows Microsoft's consent page back to Commander.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      if (url.includes('/oauth2/v2.0/authorize')) await fetch(url);
    };
  });
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function setUpAres(window: Page) {
  await openSettings(window, 'Ares');
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-ares-teams-work-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function connectTeams(window: Page) {
  await settingsPage(window, 'Accounts');
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 1 chat$/);
}

const fromSam = () => microsoft.chat(OMAR_CHAT).messages.filter((message) => message.from.id === SAM.id);
const callsFor = (words: string) =>
  server.requests.filter((each) => ((each.body.messages as Message[])[0]?.content ?? '').includes(words));

test('a request arrives → suggested Todo → Add → in Todos; a waiting Chat → suggested reply → Send → in Teams; Draft → Send', async () => {
  test.setTimeout(150_000);
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  await setUpAres(window);
  await connectTeams(window);
  await window.keyboard.press('Escape');

  // The Chat in the Teams Section: Ares's suggested Todo beside Omar's message.
  const section = window.getByTestId('section-teams');
  await expect(async () => {
    await window.keyboard.press('8');
    await expect(section).toBeVisible({ timeout: 1000 });
  }).toPass();
  await section.getByTestId('teams-chat').filter({ hasText: 'Omar Haddad' }).click();
  const view = section.getByRole('region', { name: 'Chat' });
  await expect(view.getByRole('heading', { name: 'Omar Haddad' })).toBeVisible();
  const asked = view.getByTestId('chat-message').filter({ hasText: 'TL budget' });
  const card = asked.getByRole('group', { name: 'Suggested Todo: Send Omar the TL budget' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(
    view.getByTestId('chat-message').filter({ hasText: 'Good game' }).getByTestId('chat-todo-suggestion'),
  ).toHaveCount(0);
  // Each Chat in a call of its own, as outside material, at low thinking.
  const looked = callsFor('find the things the User needs to do');
  expect(looked).toHaveLength(1);
  expect(looked[0]?.body.reasoning_effort).toBe('low');
  const material = (looked[0]?.body.messages as Message[] | undefined)?.at(-1)?.content;
  expect(material).toMatch(/label="C1 · Teams one-to-one chat: Omar Haddad" source="outside">/);

  // Add: the Todo, from Teams, in the Todos Section.
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card).toHaveCount(0);

  // The Chat is waiting on the User: the suggested reply waits above the reply box, nothing sent.
  const suggested = view.getByRole('region', { name: 'Suggested reply' });
  await expect(suggested.getByTestId('chat-reply-draft')).toHaveText(SUGGESTED, { timeout: 30_000 });
  await expect(suggested.getByTestId('chat-reply-reason')).toHaveText(REASON);
  expect(fromSam()).toEqual([]);

  // Send: in Teams, as the User's, once.
  await suggested.getByRole('button', { name: 'Send' }).click();
  await expect(suggested).toHaveCount(0);
  await expect.poll(() => fromSam().map((message) => message.html)).toEqual([SUGGESTED]);

  // Draft: Ares's draft fills the reply box; Ctrl+Enter sends it as any reply.
  await view.getByRole('button', { name: 'Draft' }).click();
  const box = view.getByRole('textbox', { name: 'Reply' });
  await expect(box).toHaveValue(DRAFTED, { timeout: 30_000 });
  expect(fromSam()).toHaveLength(1);
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect.poll(() => fromSam().length).toBe(2);
  expect(fromSam()[1]?.html).toContain('One more thing');

  // The Todo in Todos: Ares · from Teams, Omar Haddad.
  await tab(window, 'Todos').click();
  const todos = window.getByTestId('section-todos');
  const open = todos.getByRole('region', { name: 'Open' });
  await expect(open.getByRole('listitem')).toHaveText([
    /Send Omar the TL budget.*Ares · from Teams, Omar Haddad/,
  ]);

  // Every call is on the Usage page, under its job's name.
  await openSettings(window, 'Ares');
  const usage = window.getByTestId('usage-panel');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  for (const name of ['Suggest Todos from Teams', 'Suggest Teams replies', 'Draft a reply'])
    await expect(usage.getByTestId('usage-by-job')).toContainText(name);

  // The Settings grid never allows Reply in Teams above Ask. (Pop-ups close when another window takes
  // focus mid-test, so open it again until the check holds.)
  await settingsPage(window, 'Autonomy');
  const grid = window.getByRole('table', { name: 'Autonomy settings' });
  const replyInTeams = grid.getByRole('combobox', { name: 'Reply in Teams', exact: true });
  await expect(replyInTeams).toHaveText('Same');
  const auto = window.getByRole('option', { name: 'Auto', exact: true });
  await expect(async () => {
    if (!(await auto.isVisible())) await replyInTeams.click({ timeout: 2000 });
    await expect(auto).toHaveAttribute('aria-disabled', 'true', { timeout: 1000 });
    await expect(window.getByRole('option', { name: 'Auto when sure' })).toHaveAttribute(
      'aria-disabled',
      'true',
      { timeout: 1000 },
    );
  }).toPass({ timeout: 15_000 });
  await window.keyboard.press('Escape');
});
