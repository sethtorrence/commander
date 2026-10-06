import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import {
  type FakeMicrosoft,
  type FakeMicrosoftUser,
  SAM,
  startFakeMicrosoft,
} from '../src/main/microsoft/fake-microsoft-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Replying to Chats and syncing their read state end to end (#106), against a fake Microsoft Graph on
// this machine (never the real one): a reply sent with Ctrl+Enter shows at once as Sending… and
// reaches Teams once, even when Teams's answer is lost; a reply written offline survives a restart and
// goes on reconnect; a queued reply can be cancelled, a sent one can't; Couldn't sync with Retry; and
// opening, marking unread and undoing reach Teams, a newer read there winning with a note. Tokens are
// stored in the real keyring, so these need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

const PRIYA: FakeMicrosoftUser = {
  id: '6f1c2a40-0000-4000-8000-00000000a002',
  displayName: 'Priya Patel',
  userPrincipalName: 'priya@contoso.test',
};
const PRIYA_CHAT = '19:priya_sam@unq.gbl.spaces';
const HOUR = 60 * 60_000;
// The engine's first retry after a failed write.
const FIRST_RETRY_MS = 10_000;

let microsoft: FakeMicrosoft;
let commander: LaunchedCommander | undefined;
let asked: number;

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
  microsoft.postMessage(PRIYA_CHAT, PRIYA, '<p>Can you look at the rollout plan?</p>', now - 2 * HOUR);
  asked = now - 2 * HOUR;
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await microsoft?.close();
});

function environment(extra: Record<string, string> = {}) {
  const config = {
    clientId: microsoft.clientId,
    tenantId: microsoft.tenantId,
    loginUrl: microsoft.loginUrl,
    graphUrl: microsoft.graphUrl,
  };
  return { COMMANDER_TEST_MICROSOFT: JSON.stringify(config), ...extra };
}

// The system browser: sign-in follows Microsoft's consent page back to Commander.
async function standInForTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      if (url.includes('/oauth2/v2.0/authorize')) await fetch(url);
    };
  });
}

// Takes the machine offline or back online, as far as Commander can tell (a main-process test hook),
// and waits until the Core's sync engine knows.
async function setOnline(app: ElectronApplication, page: Page, online: boolean) {
  await app.evaluate((_electron, value) => {
    (
      globalThis as unknown as { commanderTestHooks: { setOnline(online: boolean): void } }
    ).commanderTestHooks.setOnline(value);
  }, online);
  if (!online) await expect.poll(() => syncActivity(page)).toBe('offline');
}

// What the window knows of the Account's syncing, through Settings → Accounts' channel.
function syncActivity(page: Page) {
  return page.evaluate(async () => {
    const { state } = await window.commander.accounts({ op: 'list' });
    return state.accounts[0]?.sync?.activity ?? null;
  });
}

async function connectTeams(window: Page) {
  await openSettings(window, 'Accounts');
  const teams = window.getByTestId('accounts-panel').getByTestId('source-teams');
  await teams.getByRole('button', { name: 'Connect Teams' }).click();
  await expect(teams.getByTestId('account-sync').getByTestId('account-synced')).toHaveText(/· 1 chat$/);
  await window.keyboard.press('Escape');
}

// Opens Priya's Chat in the Teams Section.
async function openChat(window: Page): Promise<Locator> {
  // Its number key, again until it shows (a window just launched may not take keys yet).
  const section = window.getByTestId('section-teams');
  await expect(async () => {
    await window.keyboard.press('8');
    await expect(section).toBeVisible({ timeout: 1000 });
  }).toPass();
  await section.getByTestId('teams-chat').filter({ hasText: 'Priya Patel' }).click();
  const view = section.getByRole('region', { name: 'Chat' });
  await expect(view.getByRole('heading', { name: 'Priya Patel' })).toBeVisible();
  return view;
}

async function reply(view: Locator, text: string) {
  const box = view.getByRole('textbox', { name: 'Reply' });
  await box.fill(text);
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
}

// Ctrl+Z from outside the reply box (where it undoes typing).
async function undo(window: Page, view: Locator) {
  await view.getByRole('heading', { level: 2 }).click();
  await window.keyboard.press('Control+z');
}

const chat = () => microsoft.chat(PRIYA_CHAT);
const fromSam = () => chat().messages.filter((message) => message.from.id === SAM.id);
const messagePosts = () => microsoft.graphPosts.filter((post) => post.path.endsWith('/messages'));
const readPosts = () => microsoft.graphPosts.filter((post) => post.path.endsWith('ForUser'));
// The replies on their way to Teams, as the outgoing queue holds them.
const queuedReplies = (page: Page) =>
  page.evaluate(async () =>
    (await window.commander.itemStore({ op: 'outgoing', query: {} }))
      .filter((change) => change.field.startsWith('message:'))
      .map(({ madeAt, status }) => ({ madeAt, status })),
  );
// Every change on its way to Teams, by field.
const outgoing = (page: Page) =>
  page.evaluate(async () =>
    (await window.commander.itemStore({ op: 'outgoing', query: {} })).map((change) => change.field),
  );
const activity = (view: Locator) => view.getByRole('region', { name: 'Activity' }).getByRole('listitem');

test('a reply sent with Ctrl+Enter shows as Sending…, reaches Teams once even when its answer is lost, and can’t be recalled', async () => {
  // The engine's first retry comes 10 seconds after the lost answer.
  test.setTimeout(60_000);
  commander = await launchCommander({ env: environment() });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  await connectTeams(window);
  const view = await openChat(window);

  // Teams takes the reply, but its answer never arrives: Sending… until the retry finds it there.
  microsoft.dropNextPostAnswer();
  await reply(view, 'On it <b>now</b>\nBack at 3');
  const sending = view.getByTestId('chat-reply');
  await expect(sending).toContainText('Sending…');
  await expect(sending).toContainText('On it <b>now</b>');
  await expect.poll(() => fromSam().length).toBe(1);

  await expect(sending).toBeHidden({ timeout: FIRST_RETRY_MS + 15_000 });
  const sent = view.getByTestId('chat-message').filter({ hasText: 'Back at 3' });
  await expect(sent).toHaveAttribute('data-message-id', fromSam()[0]?.id ?? 'missing');
  await expect(sent).toContainText('On it <b>now</b>');
  expect(messagePosts()).toHaveLength(1);
  expect(fromSam()).toHaveLength(1);
  // Plain text, escaped: nothing typed becomes markup in Teams.
  expect(fromSam()[0]?.html).toBe('On it &lt;b&gt;now&lt;/b&gt;<br>Back at 3');
  await expect(activity(view).filter({ hasText: 'Replied by you · sent to Teams' })).toBeVisible();

  // Once in Teams it can't be taken back, and Commander says so.
  await undo(window, view);
  await expect(
    window.getByText('Sent to Teams: a message that reached other people can’t be recalled.'),
  ).toBeVisible();
  await expect(sent).toBeVisible();
  expect(fromSam()).toHaveLength(1);
});

test('a reply written offline keeps its time, survives a restart and goes on reconnect; one cancelled while queued never does', async () => {
  const env = environment({ COMMANDER_TEST_HOOKS: '1' });
  const first = await launchCommander({ env });
  commander = first;
  let window = await first.app.firstWindow();
  await standInForTheBrowser(first.app);
  await connectTeams(window);
  let view = await openChat(window);

  await setOnline(first.app, window, false);
  await reply(view, 'Written on the train');
  await reply(view, 'Never mind that');
  await expect(view.getByTestId('chat-reply')).toHaveCount(2);
  await expect(view.getByTestId('chat-reply').first()).toContainText(
    'Offline · sends to Teams when back online',
  );

  // Undo cancels the reply still queued.
  await undo(window, view);
  await expect(view.getByTestId('chat-reply')).toHaveText([/Written on the train/]);
  await expect(activity(view).filter({ hasText: 'Reply cancelled by you' })).toBeVisible();
  const queued = () => queuedReplies(window);
  const before = await queued();
  expect(before).toHaveLength(1);
  await window.waitForTimeout(1500);
  expect(messagePosts()).toEqual([]);
  await first.app.close();

  // Back, still offline: still there, still waiting, with the time it was written.
  commander = await launchCommander({
    userDataDir: first.userDataDir,
    env: { ...env, COMMANDER_TEST_OFFLINE: '1' },
  });
  window = await commander.app.firstWindow();
  view = await openChat(window);
  await expect(view.getByTestId('chat-reply')).toHaveText([/Written on the train/]);
  expect((await queued()).map((change) => change.madeAt)).toEqual(before.map((change) => change.madeAt));
  expect(messagePosts()).toEqual([]);

  await setOnline(commander.app, window, true);
  await expect(view.getByTestId('chat-reply')).toBeHidden();
  await expect(view.getByTestId('chat-message').filter({ hasText: 'Written on the train' })).toBeVisible();
  expect(messagePosts()).toHaveLength(1);
  expect(fromSam().map((message) => message.html)).toEqual(['Written on the train']);
});

test('a reply Teams refuses shows Couldn’t sync, and Retry sends it again', async () => {
  commander = await launchCommander({ env: environment() });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  await connectTeams(window);
  const view = await openChat(window);

  microsoft.refusePosts(403);
  await reply(view, 'Shipping it');
  const alert = view.getByTestId('chat-reply').getByRole('alert');
  await expect(alert).toContainText('Couldn’t sync');
  await expect(alert).toContainText('Teams won’t let you post in this Chat.');
  await expect(activity(view).filter({ hasText: 'Replied by you · couldn’t sync' })).toBeVisible();
  expect(fromSam()).toEqual([]);

  microsoft.refusePosts(null);
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(view.getByTestId('chat-reply')).toBeHidden();
  await expect(view.getByTestId('chat-message').filter({ hasText: 'Shipping it' })).toBeVisible();
  expect(fromSam()).toHaveLength(1);
});

test('opening a Chat reads it in Teams, Mark as unread and undo reach Teams, and a newer read in Teams wins', async () => {
  commander = await launchCommander({ env: environment({ COMMANDER_TEST_HOOKS: '1' }) });
  const window = await commander.app.firstWindow();
  await standInForTheBrowser(commander.app);
  await connectTeams(window);
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('01');

  // Opening it reads it, for the User, in Teams.
  const view = await openChat(window);
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('00');
  await expect
    .poll(() => readPosts().map((post) => post.path))
    .toEqual([`/v1.0/chats/${PRIYA_CHAT}/markChatReadForUser`]);
  expect(readPosts()[0]?.body).toEqual({ user: { id: SAM.id, tenantId: microsoft.tenantId } });
  expect(chat().readBy[SAM.id]).toBeGreaterThan(asked);
  await expect(activity(view).filter({ hasText: 'Marked read by you' })).toBeVisible();

  // Mark as unread (Ctrl+U), from Priya's message; Undo reads it again.
  await view.getByRole('heading', { level: 2 }).click();
  await window.keyboard.press('Control+u');
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('01');
  await expect.poll(() => readPosts().at(-1)?.path).toBe(`/v1.0/chats/${PRIYA_CHAT}/markChatUnreadForUser`);
  expect(readPosts().at(-1)?.body).toMatchObject({
    lastMessageReadDateTime: new Date(asked - 1).toISOString(),
  });
  expect(chat().readBy[SAM.id]).toBe(asked - 1);

  const toast = window.getByText('Marked unread: Priya Patel').locator('xpath=ancestor::li[1]');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('00');
  await expect.poll(() => readPosts().length).toBe(3);
  expect(readPosts().at(-1)?.path).toBe(`/v1.0/chats/${PRIYA_CHAT}/markChatReadForUser`);

  // Marked unread here while offline, then read in Teams after that: Teams wins, with a note.
  await expect.poll(() => outgoing(window)).toEqual([]);
  await setOnline(commander.app, window, false);
  await window.keyboard.press('Control+u');
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('01');
  await expect.poll(() => outgoing(window)).toEqual(['read']);
  await window.waitForTimeout(500);
  microsoft.readChat(PRIYA_CHAT, SAM.id);
  await setOnline(commander.app, window, true);
  await expect(tab(window, 'Teams').locator('.tc')).toHaveText('00');
  await expect(activity(view).filter({ hasText: /^Changed in Teams at \d\d:\d\d/ })).toBeVisible();
  expect(readPosts()).toHaveLength(3);
});
