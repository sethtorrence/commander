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
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares on Teams end to end (#109): a fake Microsoft Graph and a fake OpenAI-compatible server
// standing in for Z.ai, both on this machine (never the real ones). Omar asks the User to sign off
// in a group Chat; after the sync, "Spot what's waiting on you" flags it and the Dashboard shows it
// in Today with Ares's reason; the User replies and the row goes. Then a busy Chat: `U` checks Teams
// first, and the Update has its summary under For your information. Tokens and the model key go in
// the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const OMAR: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a004',
  displayName: 'Omar Haddad',
  userPrincipalName: 'omar@contoso.test',
};
const LEE: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a003',
  displayName: 'Lee Chen',
  userPrincipalName: 'lee@contoso.test',
};
const TITANLINK = '19:titanlink@thread.v2';
const SOCIAL = '19:social@thread.v2';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REASON = 'Omar asked whether you can sign off the TL release today';
const SUMMARY = 'They settled on Friday for the offsite, and Lee wants your vote on the venue.';
const CHECK = '/v1.0/me/chats?$expand=lastMessagePreview&$top=50';

type Message = { role: string; content: string };

// The fake model: the waiting job flags the Chat holding Omar's question (by the references its
// prompt gave it); the busy Chat gets its summary; every other job gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as Message[];
  const system = messages[0]?.content ?? '';
  const material = messages.at(-1)?.content ?? '';
  if (system.includes('spot when someone is waiting on the User')) {
    const blocks = material.split(/\n(?=<data-)/);
    const chats = blocks.flatMap((block) => {
      const ref = /label="(W\d+) · /.exec(block)?.[1];
      if (!ref) return [];
      const asked = /┆ (M\d+) · [^\n]*sign off the TL release/.exec(block)?.[1];
      return [
        asked
          ? { itemId: ref, waiting: true, messageId: asked, reason: REASON }
          : { itemId: ref, waiting: false },
      ];
    });
    return { json: chatCompletion(JSON.stringify({ chats }), { prompt: 900, completion: 60 }) };
  }
  if (system.includes('this Teams chat has been busy'))
    return { json: chatCompletion(JSON.stringify({ summary: SUMMARY }), { prompt: 2400, completion: 80 }) };
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('The User has asked for their Update')) return { json: chatCompletion('{"lines":[]}') };
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
  const earlier = Date.now() - 48 * HOUR;
  microsoft.addChat({ id: TITANLINK, topic: 'Titanlink eng', members: [SAM, OMAR, LEE], updatedAt: earlier });
  microsoft.postMessage(TITANLINK, LEE, '<p>Build 412 is green on staging.</p>', Date.now() - 2 * HOUR);
  microsoft.addChat({ id: SOCIAL, topic: 'Social', members: [SAM, OMAR, LEE], updatedAt: earlier });
  microsoft.postMessage(SOCIAL, LEE, '<p>Offsite ideas, anyone?</p>', Date.now() - 3 * HOUR);
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

// Points Ares's model at the fake server, saves a made-up key in the keyring, and makes five
// messages from others a busy Chat.
async function setUpAres(window: Page) {
  await openSettings(window);
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await ares.getByTestId('busy-chat-messages').fill('5');
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-ares-teams-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function connectTeams(window: Page) {
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 2 chats$/);
}

// Opening the Dashboard checks Teams: away to Notes and back.
async function checkTeamsFromTheDashboard(window: Page) {
  await window.keyboard.press('2');
  await expect(window.getByTestId('section-notes')).toBeVisible();
  const before = microsoft.graphRequests.length;
  await window.keyboard.press('1');
  await expect.poll(() => microsoft.graphRequests.slice(before)).toContain(CHECK);
}

const callsFor = (words: string) =>
  server.requests.filter((each) => JSON.stringify(each.body.messages).includes(words));

test('a question arrives → a Dashboard row with Ares’s reason → reply → row gone; a busy Chat → U → its summary', async () => {
  test.setTimeout(150_000);
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  await setUpAres(window);
  await connectTeams(window);
  await window.keyboard.press('Escape');

  // Omar asks the User to sign off. The Dashboard checks Teams, Ares reads the Chat, and the row
  // shows in Today with his reason.
  microsoft.postMessage(TITANLINK, OMAR, '<p>Sam, can you sign off the TL release today?</p>');
  await checkTeamsFromTheDashboard(window);
  const dashboard = window.getByTestId('section-dashboard');
  const today = dashboard.getByRole('region', { name: 'Today' });
  const titanlink = today.getByRole('listitem', { name: 'Titanlink eng' });
  await expect(titanlink.getByTestId('row-reason')).toHaveText(REASON, { timeout: 30_000 });
  await expect(titanlink.getByTestId('source-stamp')).toHaveText('TMSGroup chat');
  // One Quick call at low thinking for it, the Chat in an outside data block.
  const spotted = callsFor('spot when someone is waiting on the User');
  expect(spotted.length).toBeGreaterThan(0);
  const call = spotted.at(-1)?.body as { reasoning_effort: string; messages: Message[] };
  expect(call.reasoning_effort).toBe('low');
  expect(call.messages.at(-1)?.content).toMatch(
    /label="W1 · Teams group chat: Titanlink eng" source="outside">/,
  );

  // The Teams Section marks it, and Waiting on you lists it alone.
  await window.keyboard.press('8');
  const teams = window.getByTestId('section-teams');
  await expect(teams).toBeVisible();
  await expect(
    teams.getByRole('listitem', { name: 'Titanlink eng' }).getByLabel('Ares: someone here is waiting on you'),
  ).toBeVisible();
  await teams.getByRole('switch', { name: /Waiting on you/ }).click();
  await expect(teams.getByTestId('teams-chat')).toHaveText([/Titanlink eng/]);
  await teams.getByRole('switch', { name: /Waiting on you/ }).click();

  // The User replies (in Teams): back on the Dashboard, which checks Teams again, the row has gone.
  microsoft.postMessage(TITANLINK, SAM, '<p>Signing it off now.</p>');
  await window.keyboard.press('1');
  await checkTeamsFromTheDashboard(window);
  await expect(today.getByRole('listitem', { name: 'Titanlink eng' })).toHaveCount(0);

  // The Social Chat gets busy: six messages from others.
  const start = Date.now() - 30 * MINUTE;
  for (let i = 0; i < 6; i++)
    microsoft.postMessage(SOCIAL, i % 2 ? LEE : OMAR, `<p>Venue idea ${i + 1}</p>`, start + i * MINUTE);
  const before = microsoft.graphRequests.length;
  await window.keyboard.press('u');
  // Asking for the Update checked Teams first.
  await expect.poll(() => microsoft.graphRequests.slice(before)).toContain(CHECK);
  const panel = window.getByTestId('update-panel');
  const fyi = panel.getByRole('region', { name: 'For your information' });
  await expect(fyi.getByTestId('update-line').filter({ hasText: 'Social' })).toHaveText(
    new RegExp(`Social: 7 messages\\. ${SUMMARY.replace(/[.]/g, '\\.')}`),
    { timeout: 30_000 },
  );
  // Made then, by one Deep call at high thinking under Summarise Chat.
  const summarised = callsFor('this Teams chat has been busy');
  expect(summarised).toHaveLength(1);
  expect(summarised[0]?.body).toMatchObject({ reasoning_effort: 'high' });

  // Open goes to the Chat.
  await fyi
    .getByTestId('update-line')
    .filter({ hasText: 'Social' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(
    teams.getByRole('region', { name: 'Chat' }).getByRole('heading', { name: 'Social' }),
  ).toBeVisible();
});
