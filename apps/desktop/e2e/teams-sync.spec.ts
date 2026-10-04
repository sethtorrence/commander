import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Teams Chats sync end to end, against a fake Microsoft identity platform and Graph on this machine
// (never the real ones): connecting Teams brings the User's Chats in, Settings → Accounts shows the
// last check, the next full sync and the switch, Sync now runs the light check, and Ctrl+K finds a
// Chat by what was said in it. Tokens are stored in the real keyring, so these need the author's
// Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIYA: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a002',
  displayName: 'Priya Patel',
  userPrincipalName: 'priya@contoso.test',
};
const LEE: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a003',
  displayName: 'Lee Chen',
  userPrincipalName: 'lee@contoso.test',
};
const PRIYA_CHAT = '19:priya_sam@unq.gbl.spaces';
const LAUNCH_CHAT = '19:launch@thread.v2';
const HOUR = 60 * 60_000;

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  const now = Date.now();
  microsoft.addChat({
    id: PRIYA_CHAT,
    chatType: 'oneOnOne',
    members: [SAM, PRIYA],
    updatedAt: now - 48 * HOUR,
  });
  microsoft.postMessage(
    PRIYA_CHAT,
    PRIYA,
    '<p>Morning! Can you look at the rollout plan?</p>',
    now - 2 * HOUR,
  );
  microsoft.addChat({
    id: LAUNCH_CHAT,
    topic: 'Launch crew',
    members: [SAM, PRIYA, LEE],
    updatedAt: now - 48 * HOUR,
  });
  microsoft.postMessage(LAUNCH_CHAT, LEE, '<p>Launch moved to <b>Thursday</b>.</p>', now - HOUR);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
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

// The system browser, as far as sign-in is concerned: follows Microsoft's consent page (which the
// fake approves at once) back to Commander's loopback listener.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });
}

async function connectTeams(window: Page) {
  await openSettings(window);
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  return teams;
}

const chatRequests = () => microsoft.graphRequests.filter((path) => !path.startsWith('/v1.0/me?'));

test('connecting Teams brings the Chats in; Settings shows the checks, Sync now checks lightly, and Ctrl+K finds a Chat by what was said', async () => {
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  const teams = await connectTeams(window);

  // The first, full sync: every Chat, who is in it, and its recent messages.
  const sync = teams.getByTestId('account-sync');
  await expect(sync.getByTestId('account-synced')).toHaveText(/^Checked \d\d:\d\d · 2 chats$/);
  await expect(sync.getByTestId('account-next-sync')).toHaveText(/^Next full sync /);
  await expect(sync.getByText('Full sync once a day')).toBeVisible();
  const toggle = sync.getByRole('switch', { name: 'Also check whenever another Source syncs' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(
    sync.getByText(
      'Microsoft asks apps to check Teams about once a day. Checking more often risks slower or paused Teams access for Commander.',
    ),
  ).toBeVisible();
  expect(chatRequests().map((path) => path.split('?')[0])).toEqual([
    '/v1.0/me/chats',
    `/v1.0/chats/${PRIYA_CHAT}/members`,
    `/v1.0/chats/${LAUNCH_CHAT}/members`,
    `/v1.0/chats/${PRIYA_CHAT}/messages`,
    `/v1.0/chats/${LAUNCH_CHAT}/messages`,
  ]);

  // A new message in one Chat; Sync now makes the one list request and reads only that Chat.
  microsoft.postMessage(PRIYA_CHAT, PRIYA, '<p>The staging certificate expires on Friday</p>');
  const before = microsoft.graphRequests.length;
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await expect
    .poll(() => microsoft.graphRequests.slice(before).map((path) => path.split('?')[0]))
    .toEqual(['/v1.0/me/chats', `/v1.0/chats/${PRIYA_CHAT}/messages`]);
  await expect(sync.getByTestId('account-synced')).toHaveText(/· 2 chats$/);

  // The switch, off.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // Ctrl+K finds the Chat by a phrase from its newest message.
  await window.keyboard.press('Escape');
  await window.keyboard.press('Control+k');
  const palette = window.getByTestId('palette');
  await palette.getByRole('combobox', { name: 'Search Commander' }).fill('staging certificate');
  await expect(palette.getByRole('option', { name: /Priya Patel/ })).toBeVisible();
  await expect(palette.getByText('Teams', { exact: true }).first()).toBeVisible();
});

test('Teams asking Commander to slow down is shown, and Sync now waits it out', async () => {
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  const teams = await connectTeams(window);
  const sync = teams.getByTestId('account-sync');
  await expect(sync.getByTestId('account-synced')).toHaveText(/· 2 chats$/);

  microsoft.throttleGraph({ status: 429, retryAfter: 3600 });
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await expect(sync.getByTestId('account-sync-problem')).toHaveText(
    'Microsoft asked Commander to check Teams less often.',
  );
  await expect(sync.getByTestId('account-next-sync')).toHaveText(/^Trying again at /);

  const before = microsoft.graphRequests.length;
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await window.waitForTimeout(500);
  expect(microsoft.graphRequests.length).toBe(before);
});
