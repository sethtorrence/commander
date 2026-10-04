import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// The Teams Section end to end. Chats come from a fake Microsoft Graph on this machine (never the real
// one) through Teams sync, which saves them with saveFromSource: filtering the Chat list, opening a
// Chat (its image never fetched), filing it into a Project, muting another and excluding a third,
// which the next sync skips until Settings → Teams includes it again. Tokens are stored in the real
// keyring, so these need the author's Linux Wayland session.
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
const STANDUP_CHAT = '19:meeting_standup@thread.v2';
const HOUR = 60 * 60_000;

// Somewhere for a remote image to live, counting every request for it.
async function imageHost(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { 'content-type': 'image/png' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hosted/screenshot.png`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let microsoft: FakeMicrosoft;
let image: Awaited<ReturnType<typeof imageHost>>;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  microsoft = await startFakeMicrosoft();
  image = await imageHost();
  const now = Date.now();
  const earlier = now - 48 * HOUR;
  microsoft.addChat({ id: PRIYA_CHAT, chatType: 'oneOnOne', members: [SAM, PRIYA], updatedAt: earlier });
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
    updatedAt: earlier,
  });
  microsoft.postMessage(
    LAUNCH_CHAT,
    LEE,
    `<p>Launch moved to <b>Thursday</b>. Screenshot: <img src="${image.url}" onerror="alert(1)"></p><script>fetch("${image.url}")</script>`,
    now - 4 * HOUR,
  );
  microsoft.postMessage(
    LAUNCH_CHAT,
    PRIYA,
    '<p><at id="0">Sam Rivera</at> can you sign off? Notes: <a href="https://contoso.test/launch">launch notes</a></p>',
    now - 3 * HOUR,
    [SAM],
  );
  microsoft.addChat({ id: SOCIAL_CHAT, topic: 'Social', members: [SAM, PRIYA, LEE], updatedAt: earlier });
  microsoft.postMessage(SOCIAL_CHAT, LEE, '<p>Lunch?</p>', now - HOUR);
  microsoft.addChat({
    id: STANDUP_CHAT,
    topic: 'Daily standup',
    chatType: 'meeting',
    members: [SAM, PRIYA, LEE],
    updatedAt: earlier,
  });
  microsoft.postMessage(STANDUP_CHAT, PRIYA, '<p>Notes from today’s standup</p>', now - 5 * HOUR);
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
  await image?.close();
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

// The system browser: sign-in follows Microsoft's consent page back to Commander; any other link is
// kept in a list of what was sent there.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      if (url.includes('/oauth2/v2.0/authorize')) await fetch(url);
      else opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

async function connectTeams(window: Page) {
  await openSettings(window);
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-status')).toHaveText('Connected');
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 4 chats$/);
}

// Checks every Account now (Sync now), without leaving the open Section.
const syncNow = (page: Page) =>
  page.evaluate(async () => {
    const { state } = await window.commander.accounts({ op: 'list' });
    for (const account of state.accounts)
      await window.commander.accounts({ op: 'sync-now', accountId: account.id });
  });

const rows = (section: Locator) => section.getByTestId('teams-chat');
const chatRequests = (from: number, chatId: string) =>
  microsoft.graphRequests.slice(from).filter((path) => path.startsWith(`/v1.0/chats/${chatId}/`));

test('filter the Chats, open one, file it, mute another and exclude a third', async () => {
  commander = await launchCommander({ env: pointAtFakeMicrosoft() });
  const window = await commander.window();
  const openedExternally = await standInForTheBrowser(commander.app);
  await connectTeams(window);
  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Titanlink');
  await newProject.getByLabel('Badge code').fill('TL');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /TLTitanlink/,
  ]);

  // The tab counts the unread Chats, before the Section is even opened.
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('04');

  // Opening the Section (its number key) checks Teams at once, and says when.
  const before = microsoft.graphRequests.length;
  await window.keyboard.press('Escape');
  await window.keyboard.press('8');
  const section = window.getByTestId('section-teams');
  await expect(section).toBeVisible();
  await expect
    .poll(() => microsoft.graphRequests.slice(before))
    .toContain('/v1.0/me/chats?$expand=lastMessagePreview&$top=50');
  await expect(section.getByTestId('teams-check-status')).toHaveText(/^Checked \d\d:\d\d$/);

  // Mentions of the User first, then the rest by their latest message.
  await expect(rows(section)).toHaveText([/Launch crew/, /Social/, /Priya Patel/, /Daily standup/]);
  await expect(
    rows(section).first().getByRole('img', { name: 'An unread message mentions you' }),
  ).toBeVisible();

  // The Chat-type and Unread only filters, with live counts.
  await section.getByRole('tab', { name: /^Group/ }).click();
  await expect(rows(section)).toHaveText([/Launch crew/, /Social/]);
  await expect(section.getByRole('switch', { name: /Unread only/ })).toContainText('02');
  await section.getByRole('tab', { name: /^Meeting/ }).click();
  await expect(rows(section)).toHaveText([/Daily standup/]);
  await section.getByRole('tab', { name: /^All chats/ }).click();
  await expect(rows(section)).toHaveCount(4);

  // Open the first Chat (j, k and Enter from the keyboard once the filter tab has let go of focus):
  // its messages as text, its image never fetched, its links leaving for the browser.
  await rows(section).nth(1).click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('k');
  await window.keyboard.press('Enter');
  const view = section.getByRole('region', { name: 'Chat' });
  await expect(view.getByRole('heading', { name: 'Launch crew' })).toBeVisible();
  await expect(view.getByTestId('chat-people')).toHaveText('Priya Patel, Lee Chen and you');
  await expect(view.getByTestId('chat-message')).toHaveCount(2);
  await expect(view.getByTestId('chat-message').first()).toContainText(
    'Launch moved to Thursday. Screenshot: [image]',
  );
  await expect(view.locator('mark')).toHaveText('@Sam Rivera');
  await expect(view.locator('img, script, iframe')).toHaveCount(0);
  await view.getByRole('link', { name: 'https://contoso.test/launch' }).click();
  await view
    .getByRole('link', { name: /^Open in Teams/ })
    .first()
    .click();
  await expect
    .poll(openedExternally)
    .toEqual([
      'https://contoso.test/launch',
      expect.stringMatching(/^https:\/\/teams\.microsoft\.com\/l\/chat\//),
    ]);
  expect(image.hits()).toBe(0);

  // File it with b: the activity log says so, and the Project filter finds it.
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('tl');
  await picker.getByRole('combobox').press('Enter');
  await expect(rows(section).first().getByRole('img', { name: 'Titanlink' })).toBeVisible();
  const activity = view.getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('listitem').first()).toContainText('Filed under TL by you');
  await window.keyboard.press('Escape');
  await expect(view).toBeHidden();
  await section.getByRole('group', { name: 'Project filter' }).getByTitle('Only Titanlink').click();
  await expect(rows(section)).toHaveText([/Launch crew/]);
  await section
    .getByRole('group', { name: 'Project filter' })
    .getByRole('button', { name: /^Everything/ })
    .click();
  await expect(rows(section)).toHaveCount(4);

  // Mute Social: it leaves the unread Chats and the tab count.
  await rows(section).filter({ hasText: 'Social' }).click();
  await view.getByRole('button', { name: 'Mute' }).click();
  await expect(rows(section)).toHaveText([/Launch crew/, /Priya Patel/, /Daily standup/, /Social/]);
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('03');
  await section.getByRole('switch', { name: /Unread only/ }).click();
  await expect(rows(section)).toHaveText([/Launch crew/, /Priya Patel/, /Daily standup/]);
  await section.getByRole('switch', { name: /Unread only/ }).click();

  // Exclude the standup, after a confirmation: it goes, and the next sync skips it.
  await rows(section).filter({ hasText: 'Daily standup' }).click();
  await view.getByRole('button', { name: 'Exclude…' }).click();
  const confirm = window.getByRole('dialog', { name: /Exclude this Chat/ });
  await confirm.getByRole('button', { name: 'Exclude', exact: true }).click();
  await expect(rows(section)).toHaveText([/Launch crew/, /Priya Patel/, /Social/]);
  microsoft.postMessage(STANDUP_CHAT, PRIYA, '<p>One more thing</p>');
  const beforeSync = microsoft.graphRequests.length;
  await syncNow(window);
  await expect.poll(() => microsoft.graphRequests.length).toBeGreaterThan(beforeSync);
  await window.waitForTimeout(500);
  expect(chatRequests(beforeSync, STANDUP_CHAT)).toEqual([]);
  await expect(rows(section)).toHaveCount(3);

  // Settings → Teams lists it; Include again brings it back with the next check.
  await openSettings(window);
  const excluded = window.getByRole('region', { name: 'Excluded chats', exact: true });
  await expect(excluded).toContainText('Daily standup');
  await expect(window.getByRole('region', { name: 'Muted chats', exact: true })).toContainText('Social');
  const beforeInclude = microsoft.graphRequests.length;
  await excluded.getByRole('button', { name: 'Include Daily standup again' }).click();
  await expect.poll(() => chatRequests(beforeInclude, STANDUP_CHAT).length).toBeGreaterThan(0);
  await expect(excluded).toBeHidden();
  await window.keyboard.press('Escape');
  await tab(window, 'Teams').click();
  await expect(rows(section)).toHaveText([/Launch crew/, /Daily standup/, /Priya Patel/, /Social/]);
  expect(image.hits()).toBe(0);
});
