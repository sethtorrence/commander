import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Rules and Ares file Teams Chats, end to end (#108): a fake Microsoft Graph (never the real one)
// and a fake OpenAI-compatible server standing in for Z.ai. A Rule written before Teams is connected
// ("Chat name contains TL eng → TL") files that Chat as it syncs; Ares files the one he is sure of
// and leaves his dashed Badge on the others, which the User confirms from the Chat view's header or
// changes. A suggested one-to-one Chat wears the dashed Badge on its Dashboard row too. The Rule
// editor offers the people in synced Chats, and Ares's activity page shows his record on Teams on
// its own. Tokens and the model's key go in the real keyring, so this needs the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const OMAR: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000b001',
  displayName: 'Omar Haddad',
  userPrincipalName: 'omar@titanlink.io',
};
const PRIYA: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000b002',
  displayName: 'Priya Patel',
  userPrincipalName: 'priya@contoso.test',
};
const HOUR = 60 * 60_000;

// The fake model: "File into Projects" is sure the Relay Chat is Titanlink's, and guesses (unsure)
// that the others are too. Any other job gets nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  const system = messages[0]?.content ?? '';
  const prompt = messages.at(-1)?.content ?? '';
  if (system.includes('You file the User')) {
    const [, ref] = /label="(I\d+) · Teams Chat"/.exec(prompt) ?? [];
    const [, name] = /┆ Chat name: (.*)/.exec(prompt) ?? [];
    const sure = name?.includes('Relay');
    const filings = ref
      ? [
          {
            itemId: ref,
            projectCode: 'TL',
            confidence: sure ? 0.95 : 0.55,
            reason: sure ? 'Omar works on Titanlink' : 'Looks like Titanlink work',
          },
        ]
      : [];
    return { json: chatCompletion(JSON.stringify({ filings, steering: [] })) };
  }
  if (system.includes("rank the User's Dashboard")) return { json: chatCompletion('{"ranking":[]}') };
  if (system.includes('their Update')) return { json: chatCompletion('{"lines":[]}') };
  return { json: chatCompletion('{"todos":[]}') };
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-teams-filing-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

async function createProject(window: Page, name: string, code: string) {
  const form = window.getByRole('form', { name: 'New Project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Badge code').fill(code);
  await form.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' })).toContainText(`${code}${name}`);
}

// The system browser: sign-in follows Microsoft's consent page back to Commander.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      if (url.includes('/oauth2/v2.0/authorize')) await fetch(url);
    };
  });
}

const row = (section: Locator, title: string) =>
  section.getByTestId('teams-chat').filter({ has: section.page().getByText(title, { exact: true }) });

let microsoft: FakeMicrosoft;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  microsoft = await startFakeMicrosoft();
  const now = Date.now();
  const chats: [string, string | null, FakeMicrosoftUser[], string][] = [
    ['19:tl-eng@thread.v2', 'TL eng', [SAM, OMAR, PRIYA], 'Deploy is green'],
    ['19:relay@thread.v2', 'Relay rollout', [SAM, OMAR], 'Relay p95 is up again'],
    ['19:pager@thread.v2', 'Pager talk', [SAM, PRIYA], 'Who has the pager this week?'],
    ['19:lunch@thread.v2', 'Lunch plans', [SAM, PRIYA], 'Tacos?'],
  ];
  chats.forEach(([id, topic, members, text], i) => {
    microsoft.addChat({ id, topic, members, updatedAt: now - 48 * HOUR });
    microsoft.postMessage(id, members[1] as FakeMicrosoftUser, `<p>${text}</p>`, now - (i + 1) * HOUR);
  });
  // A one-to-one Chat waiting on the User: it reaches the Dashboard (#107).
  microsoft.addChat({
    id: '19:priya_sam@unq.gbl.spaces',
    chatType: 'oneOnOne',
    members: [SAM, PRIYA],
    updatedAt: now - 48 * HOUR,
  });
  microsoft.postMessage('19:priya_sam@unq.gbl.spaces', PRIYA, '<p>Can you look at the plan?</p>', now - HOUR);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
  await server?.close();
});

test('a Rule files a Chat as it syncs; Ares files or suggests the rest; Confirm and Change; his Teams record', async () => {
  test.setTimeout(120_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_MICROSOFT: JSON.stringify({
        clientId: microsoft.clientId,
        tenantId: microsoft.tenantId,
        loginUrl: microsoft.loginUrl,
        graphUrl: microsoft.graphUrl,
      }),
    },
  });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  await openSettings(window);
  await connectFakeModel(window, server);
  await createProject(window, 'Titanlink', 'TL');
  await createProject(window, 'Tactics', 'TX');

  // A Rule on a Teams field, before any Chat has synced: Chat name contains "TL eng" → TL.
  await window.getByRole('button', { name: 'New Rule', exact: true }).click();
  const editor = window.getByRole('dialog', { name: 'New Rule' });
  await editor.getByRole('combobox', { name: 'Files into' }).selectOption({ label: 'TL · Titanlink' });
  await editor.getByRole('combobox', { name: 'Field 1' }).selectOption('teams.title');
  await editor.getByRole('textbox', { name: 'Value 1' }).fill('TL eng');
  await editor.getByRole('button', { name: 'Save Rule' }).click();
  await expect(window.getByRole('list', { name: 'Rules' }).getByRole('listitem')).toHaveText([
    /Chat name contains “TL eng”/,
  ]);

  // Connect Teams: five Chats sync, the Rule files one, and Ares files the others as they arrive.
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 5 chats$/);
  await window.keyboard.press('Escape');
  await tab(window, 'Teams').click();
  const section = window.getByTestId('section-teams');
  const view = section.getByRole('region', { name: 'Chat' });
  const activity = view.getByRole('region', { name: 'Activity' });

  // The Rule's Chat, with the Rule named in its activity log.
  await expect(row(section, 'TL eng').getByRole('img', { name: 'Titanlink', exact: true })).toBeVisible();
  await row(section, 'TL eng').click();
  await expect(activity).toContainText('Filed under TL by Rule: Chat name contains “TL eng”');

  // Sure: a solid Badge, "Filed under TL by Ares". Not sure: the dashed Badge on the others.
  await expect(
    row(section, 'Relay rollout').getByRole('img', { name: 'Titanlink', exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  for (const title of ['Pager talk', 'Lunch plans', 'Priya Patel']) {
    await expect(row(section, title).getByRole('img', { name: 'Ares suggests Titanlink' })).toBeVisible({
      timeout: 20_000,
    });
  }
  await row(section, 'Relay rollout').click();
  await expect(activity).toContainText('Filed under TL by Ares');

  // Confirm from the Chat view's header: filed by the User, the answer in its log.
  await row(section, 'Lunch plans').click();
  const suggested = view.getByTestId('suggested-filing');
  await expect(suggested.getByRole('img', { name: 'Ares suggests Titanlink' })).toBeVisible();
  await suggested.getByRole('button', { name: 'Confirm Titanlink' }).click();
  await expect(
    row(section, 'Lunch plans').getByRole('img', { name: 'Titanlink', exact: true }),
  ).toBeVisible();
  await expect(activity).toContainText('Confirmed Ares’s filing under TL');

  // Change: the picker opens with his suggestion on top; Tactics is a correction.
  await row(section, 'Pager talk').click();
  await view.getByTestId('suggested-filing').getByRole('button', { name: 'Change the Project' }).click();
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await expect(picker.getByTestId('badge-picker-suggestion')).toContainText('Ares suggests Titanlink');
  await picker.getByRole('combobox').fill('tx');
  await picker.getByRole('combobox').press('Enter');
  await expect(row(section, 'Pager talk').getByRole('img', { name: 'Tactics', exact: true })).toBeVisible();
  await expect(activity).toContainText('Corrected Ares: TL → TX');

  // The one-to-one Chat waiting on the User is on the Dashboard, wearing the dashed Badge.
  await window.keyboard.press('Escape');
  await tab(window, 'Dashboard').click();
  const today = window.getByTestId('section-dashboard').getByRole('region', { name: 'Today' });
  await expect(
    today
      .getByRole('listitem', { name: 'Priya Patel' })
      .getByRole('button', { name: 'Project of Priya Patel' })
      .getByRole('img', { name: 'Ares suggests Titanlink' }),
  ).toBeVisible();

  // The Rule editor offers the people in synced Chats (never the User).
  await openSettings(window);
  await window.getByRole('button', { name: 'New Rule', exact: true }).click();
  await editor.getByRole('combobox', { name: 'Field 1' }).selectOption('teams.person');
  const people = editor.getByRole('combobox', { name: 'Value 1' });
  await expect(people.getByRole('option', { name: 'Omar Haddad' })).toBeAttached();
  await expect(people.getByRole('option', { name: 'Priya Patel' })).toBeAttached();
  await expect(people.getByRole('option', { name: 'Sam Rivera' })).toHaveCount(0);
  await people.selectOption({ label: 'Omar Haddad' });
  await expect(editor.getByRole('region', { name: 'Matching Items' })).toContainText('Matches 2 Items');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await window.keyboard.press('Escape');

  // Ares's activity page: his record on Teams on its own.
  await tab(window, 'Ares').click();
  const bySource = window.getByRole('table', { name: 'Filing by Source' });
  await expect(bySource.getByRole('row', { name: /Teams/ }).getByRole('cell')).toHaveText([
    '1',
    '3',
    '1',
    '1',
    '50%',
  ]);
});
