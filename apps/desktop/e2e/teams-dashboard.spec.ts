import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Teams on the Dashboard end to end (#107). Chats come from a fake Microsoft Graph on this machine
// (never the real one) through Teams sync: an unanswered one-to-one Chat shows in Today; a mention
// arrives and opening the Dashboard checks Teams, so it shows too; Enter opens the Chat in the Teams
// Section at the mention; and once the User replies, the unanswered Chat leaves the Dashboard. Tokens
// are stored in the real keyring, so this needs the author's Linux Wayland session.
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
const SOCIAL_CHAT = '19:social@thread.v2';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  const now = Date.now();
  const earlier = now - 48 * HOUR;
  microsoft.addChat({ id: PRIYA_CHAT, chatType: 'oneOnOne', members: [SAM, PRIYA], updatedAt: earlier });
  microsoft.postMessage(PRIYA_CHAT, SAM, '<p>Did the rollout plan land?</p>', now - 2 * HOUR);
  microsoft.postMessage(PRIYA_CHAT, PRIYA, '<p>Yes! Can you look at it today?</p>', now - 40 * MINUTE);
  microsoft.addChat({
    id: LAUNCH_CHAT,
    topic: 'Launch crew',
    members: [SAM, PRIYA, LEE],
    updatedAt: earlier,
  });
  microsoft.postMessage(LAUNCH_CHAT, LEE, '<p>Launch moved to Thursday.</p>', now - 3 * HOUR);
  microsoft.addChat({ id: SOCIAL_CHAT, topic: 'Social', members: [SAM, PRIYA, LEE], updatedAt: earlier });
  for (let i = 0; i < 6; i++)
    microsoft.postMessage(
      SOCIAL_CHAT,
      i % 2 ? LEE : PRIYA,
      '<p>Cake in the kitchen</p>',
      now - (i + 1) * MINUTE,
    );
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

// The system browser: sign-in follows Microsoft's consent page back to Commander.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      if (url.includes('/oauth2/v2.0/authorize')) await fetch(url);
    };
  });
}

async function connectTeams(window: Page) {
  await openSettings(window, 'Accounts');
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 3 chats$/);
}

const CHECK = '/v1.0/me/chats?$expand=lastMessagePreview&$top=50';

test('a mention reaches the Dashboard, Enter opens the Chat at it, and a reply clears an unanswered Chat', async () => {
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  await connectTeams(window);
  await window.keyboard.press('Escape');

  // The unanswered one-to-one Chat is in Today, stamped TMS with its reason; the busy group Chat
  // and the one without a mention are not.
  const dashboard = window.getByTestId('section-dashboard');
  await expect(dashboard).toBeVisible();
  const today = dashboard.getByRole('region', { name: 'Today' });
  const rows = today.getByTestId('dashboard-row');
  await expect(rows).toHaveText([/Priya Patel/]);
  const priya = today.getByRole('listitem', { name: 'Priya Patel' });
  await expect(priya.getByTestId('source-stamp')).toHaveText('TMSOne-to-one chat');
  await expect(priya.getByTestId('row-reason')).toHaveText(/^Priya messaged you 4\d min ago$/);
  await expect(dashboard.getByRole('listitem', { name: 'Social' })).toHaveCount(0);

  // A mention arrives in the group Chat. Opening the Dashboard checks Teams at once, so it shows.
  const mentionedAt = Date.now();
  const mention = microsoft.postMessage(
    LAUNCH_CHAT,
    LEE,
    '<p><at id="0">Sam Rivera</at> can you sign off on the launch?</p>',
    mentionedAt,
    [SAM],
  );
  await window.keyboard.press('2');
  await expect(window.getByTestId('section-notes')).toBeVisible();
  const before = microsoft.graphRequests.length;
  await window.keyboard.press('1');
  await expect.poll(() => microsoft.graphRequests.slice(before)).toContain(CHECK);
  await expect(rows).toHaveText([/Launch crew/, /Priya Patel/]);
  const clock = new Date(mentionedAt);
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  await expect(today.getByRole('listitem', { name: 'Launch crew' }).getByTestId('row-reason')).toHaveText(
    `Lee mentioned you in Launch crew · ${hhmm}`,
  );
  await expect(tab(window, 'Dashboard').locator('.tc')).toHaveText('02');

  // Enter opens the Chat in the Teams Section, scrolled to the mention and marked.
  const launch = today.getByRole('listitem', { name: 'Launch crew' });
  // (Its title: the middle of a selected row is its action bar.)
  await launch.getByText('Launch crew', { exact: true }).click();
  await expect(launch).toHaveAttribute('aria-current', 'true');
  await window.keyboard.press('Enter');
  const teams = window.getByTestId('section-teams');
  await expect(teams).toBeVisible();
  const view = teams.getByRole('region', { name: 'Chat' });
  await expect(view.getByRole('heading', { name: 'Launch crew' })).toBeVisible();
  const focused = view.locator('[data-focused]');
  await expect(focused).toHaveAttribute('data-message-id', mention);
  await expect(focused).toContainText('can you sign off on the launch?');
  await expect(focused).toBeInViewport();

  // Opening the Chat read it (#106), so the mention is no longer unread. The User answers Priya from
  // the reply box: back on the Dashboard, which checks Teams again, both rows have gone.
  await teams.locator('[data-testid="teams-chat"][aria-label="Priya Patel"]').click();
  await expect(view.getByRole('heading', { name: 'Priya Patel' })).toBeVisible();
  const box = view.getByRole('textbox', { name: 'Reply' });
  await box.fill('Looking at it now');
  await box.press('Control+Enter');
  await expect
    .poll(() => microsoft.chat(PRIYA_CHAT).messages.filter((message) => message.from.id === SAM.id).length)
    .toBe(2);
  await expect(view.getByTestId('chat-reply')).toBeHidden();
  await view.getByRole('heading', { name: 'Priya Patel' }).click();
  await window.keyboard.press('Escape');
  const again = microsoft.graphRequests.length;
  await window.keyboard.press('1');
  await expect.poll(() => microsoft.graphRequests.slice(again)).toContain(CHECK);
  await expect(rows).toHaveCount(0);
});
