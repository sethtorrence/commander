import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Channel posts end to end (#111), against a fake Microsoft identity platform and Graph on this
// machine (never the real ones). Until Microsoft grants ChannelMessage.Read.All, nothing about
// channels shows but Settings → Teams → Channel posts, which explains what's needed and offers the
// admin consent link; the tenant first needs an administrator; once approved, Request access signs in
// again for it, the switch turns Channel posts on, the teams and channels list with exclude, a post
// mentioning the User reaches the Dashboard, Enter opens it in the Teams Section at the mention, and a
// reply goes to the post's replies in Teams. Tokens are stored in the real keyring, so this needs the
// author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIYA: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a002',
  displayName: 'Priya Patel',
  userPrincipalName: 'priya@contoso.test',
};
const TL = 'team-titanlink';
const GENERAL = '19:general-tl@thread.tacv2';
const RELEASES = '19:releases-tl@thread.tacv2';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;
let mention: string;
let mentionedAt: number;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  const now = Date.now();
  microsoft.addChat({
    id: '19:priya_sam@unq.gbl.spaces',
    chatType: 'oneOnOne',
    members: [SAM, PRIYA],
    updatedAt: now - 48 * HOUR,
  });
  microsoft.postMessage('19:priya_sam@unq.gbl.spaces', PRIYA, '<p>Morning</p>', now - 3 * HOUR);
  microsoft.channels.addTeam({
    id: TL,
    name: 'Titanlink',
    channels: [
      { id: GENERAL, name: 'General' },
      { id: RELEASES, name: 'releases' },
    ],
  });
  const post = microsoft.channels.post(TL, RELEASES, PRIYA, '<p>Release 4.2 is out</p>', {
    at: now - 2 * HOUR,
    subject: 'Release 4.2',
  });
  mentionedAt = now - 2 * MINUTE;
  mention = microsoft.channels.reply(
    TL,
    RELEASES,
    post,
    PRIYA,
    '<p><at id="0">Sam Rivera</at> can you check the notes?</p>',
    { at: mentionedAt, mentions: [SAM] },
  );
  microsoft.channels.post(TL, GENERAL, PRIYA, '<p>Welcome, everyone</p>', { at: now - HOUR });
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
  await openSettings(window);
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 1 chat$/);
}

test('consent, Sync Channel posts on, a post mentioning the User on the Dashboard, and a reply', async () => {
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.window();
  await standInForTheBrowser(commander.app);
  await connectTeams(window);

  // Off: what Channel posts need, the permissions, the steps and the admin consent link.
  const settings = window.getByTestId('channel-posts-settings');
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toContainText('Channel posts need the delegated permission ChannelMessage.Read.All');
  await expect(settings.getByTestId('channel-posts-steps')).toContainText('Grant admin consent');
  await expect(settings.getByLabel('Admin consent link')).toHaveValue(
    `${microsoft.loginUrl}/${microsoft.tenantId}/adminconsent?client_id=${microsoft.clientId}`,
  );
  await expect(settings.getByRole('switch')).toHaveCount(0);
  // Nothing about channels anywhere else: no channel was read, and the Teams Section has no Channels.
  expect(microsoft.graphRequests.filter((path) => path.includes('/teams/'))).toEqual([]);
  await window.keyboard.press('Escape');
  await window.keyboard.press('8');
  const teamsSection = window.getByTestId('section-teams');
  await expect(teamsSection).toBeVisible();
  await expect(teamsSection.getByRole('region', { name: 'Channels' })).toHaveCount(0);

  // The tenant needs an administrator first: Request access says so, with the link to send.
  await openSettings(window);
  microsoft.requireAdminConsent('AADSTS65001');
  await settings.getByRole('button', { name: 'Request access' }).click();
  await expect(settings.getByRole('alert')).toContainText('needs an administrator');
  await expect(settings.getByTestId('admin-consent-permissions')).toContainText('ChannelMessage.Read.All');

  // The administrator approved it: Request access asks for the Channel post permissions too, and the
  // switch is there, off.
  microsoft.requireAdminConsent(null);
  await settings.getByRole('button', { name: 'Request access' }).click();
  const sync = settings.getByRole('switch', { name: 'Sync Channel posts' });
  await expect(sync).toHaveAttribute('aria-checked', 'false');
  expect(microsoft.authorizeRequests.at(-1)?.scope).toContain('ChannelMessage.Read.All ChannelMessage.Send');

  // On: the teams and channels list, every channel synced, each with Exclude.
  await sync.click();
  await expect(sync).toHaveAttribute('aria-checked', 'true');
  const choices = settings.getByRole('list', { name: 'Teams and channels' });
  await expect(choices.getByRole('button', { name: 'Exclude Titanlink / releases' })).toBeVisible();
  await expect(choices.getByRole('button', { name: 'Exclude Titanlink / General' })).toBeVisible();
  await window.keyboard.press('Escape');

  // The post mentioning the User is in Today, saying who and where.
  await window.keyboard.press('1');
  const dashboard = window.getByTestId('section-dashboard');
  const today = dashboard.getByRole('region', { name: 'Today' });
  const row = today.getByRole('listitem', { name: 'Release 4.2' });
  const clock = new Date(mentionedAt);
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`;
  await expect(row.getByTestId('row-reason')).toHaveText(
    `Priya mentioned you in Titanlink / releases · ${hhmm}`,
  );
  await expect(row.getByTestId('source-stamp')).toHaveText('TMSTitanlink / releases');

  // Enter opens it in the Teams Section, at the mention.
  await row.getByText('Release 4.2', { exact: true }).click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await window.keyboard.press('Enter');
  await expect(teamsSection).toBeVisible();
  const view = teamsSection.getByRole('region', { name: 'Channel post' });
  await expect(view.getByRole('heading', { name: 'Release 4.2' })).toBeVisible();
  const focused = view.locator('[data-focused]');
  await expect(focused).toHaveAttribute('data-message-id', mention);
  await expect(focused).toContainText('can you check the notes?');
  const channels = teamsSection.getByRole('region', { name: 'Channels' });
  await expect(channels.getByRole('region', { name: 'Titanlink / releases' })).toBeVisible();

  // A reply goes to the post's replies in Teams, once.
  const box = view.getByRole('textbox', { name: 'Reply' });
  await box.fill('Checked, all good');
  await box.press('Control+Enter');
  await expect.poll(() => microsoft.channels.replyPosts.length).toBe(1);
  expect(microsoft.channels.replyPosts[0]?.path).toContain(`/teams/${TL}/channels/${RELEASES}/messages/`);
  await expect(view.getByRole('region', { name: 'Replies' })).toContainText('Checked, all good');
  const replies = microsoft.channels.channel(TL, RELEASES).posts[0]?.replies ?? [];
  expect(replies.filter((reply) => reply.from.id === SAM.id)).toHaveLength(1);

  // Seen in Commander: back on the Dashboard, the post has left Today.
  await view.getByRole('heading', { name: 'Release 4.2' }).click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('1');
  await expect(today.getByRole('listitem', { name: 'Release 4.2' })).toHaveCount(0);
});
