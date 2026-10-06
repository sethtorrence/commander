import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, settingsPage, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// The Linear Section end to end. Issues come from a fake Linear on this machine (never the real
// one) through Linear sync, which saves them with saveFromSource: switching views, filtering,
// opening an issue and filing it into a Project. Tokens are stored in the real keyring, so these
// need the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_section_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const OPS = { id: 'team-ops', key: 'OPS', name: 'Operations' };
const STARTED = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };
const DAY = 86_400_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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
    url: `http://127.0.0.1:${port}/uploads/loop.png`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Links leave for the system browser: here, a list of what was sent there.
async function catchTheBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

let linear: FakeLinear;
let image: Awaited<ReturnType<typeof imageHost>>;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  image = await imageHost();
  linear.addApiKey(API_KEY, ACME);
  const now = Date.now();
  const cycle = {
    id: 'cycle-41',
    number: 41,
    name: null,
    startsAt: new Date(now - 3 * DAY).toISOString(),
    endsAt: new Date(now + 4 * DAY).toISOString(),
  };
  linear.issues.add(ACME.id, {
    identifier: 'ENG-418',
    title: 'Fix the login loop',
    assignee: ME,
    creator: PRIYA,
    state: STARTED,
    priority: 2,
    cycle,
    estimate: 3,
    labels: { nodes: [{ id: 'label-bug', name: 'Bug', color: '#eb5757' }] },
    project: { id: 'lp-login', name: 'Login revamp' },
    description: `The login page **loops** after SSO.\n\n![the loop](${image.url})\n\nSee [the runbook](https://acme.test/runbook).`,
    comments: [
      {
        id: 'comment-1',
        body: 'Reproduced on staging.',
        createdAt: new Date(now - DAY).toISOString(),
        updatedAt: new Date(now - DAY).toISOString(),
        user: PRIYA,
      },
    ],
  });
  linear.issues.add(ACME.id, { identifier: 'ENG-420', title: 'Rotate the signing keys', assignee: ME });
  linear.issues.add(ACME.id, {
    identifier: 'ENG-422',
    title: 'Write the SSO runbook',
    assignee: PRIYA,
    cycle,
  });
  linear.issues.add(ACME.id, {
    identifier: 'OPS-7',
    title: 'Renew the certificate',
    team: OPS,
    assignee: PRIYA,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await image?.close();
});

async function connect(window: Page) {
  await openSettings(window, 'Accounts');
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/4 issues/);
}

const rows = (section: Locator) => section.getByTestId('linear-issue');

// Picks a choice from one of the Linear filters (retried: pop-ups close when focus is lost).
async function choose(section: Locator, filter: string, option: RegExp, shows: RegExp) {
  await pickOption(section.getByRole('combobox', { name: filter }), option, shows);
}

test('switch views, filter, open an issue and file it into a Project', async () => {
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_LINEAR: JSON.stringify({
        clientId: null,
        port: await freePort(),
        authorizeUrl: linear.authorizeUrl,
        tokenUrl: linear.tokenUrl,
        apiUrl: linear.apiUrl,
      }),
    },
  });
  const { app } = commander;
  const window = await commander.window();
  const openedExternally = await catchTheBrowser(app);
  await connect(window);
  await settingsPage(window, 'Projects');
  const newProject = window.getByRole('form', { name: 'New Project' });
  await newProject.getByLabel('Name').fill('Longtail');
  await newProject.getByLabel('Badge code').fill('LT');
  await newProject.getByRole('button', { name: 'Create Project' }).click();
  await expect(window.getByRole('list', { name: 'Projects' }).getByRole('listitem')).toHaveText([
    /LTLongtail/,
  ]);

  // The tab counts the open issues assigned to the User, before the Section is even opened.
  await expect(tab(window, 'Linear').locator('.tc')).toHaveText('02');

  // Opening the Section syncs every Linear Account at once, and says when it last synced.
  const requestsBefore = linear.graphqlRequests.length;
  await tab(window, 'Linear').click();
  const section = window.getByTestId('section-linear');
  await expect.poll(() => linear.graphqlRequests.length).toBeGreaterThan(requestsBefore);
  await expect(section.getByTestId('linear-sync-status')).toHaveText(/^Synced \d\d:\d\d$/);

  // It opens on Assigned to me, and All tickets is one click away.
  await expect(section.getByRole('tab', { name: /Assigned to me/ })).toHaveAttribute('aria-selected', 'true');
  await expect(rows(section)).toHaveText([/ENG-418.*Fix the login loop/, /ENG-420.*Rotate the signing keys/]);
  await section.getByRole('tab', { name: /All tickets/ }).click();
  await expect(rows(section)).toHaveCount(4);

  // Filters narrow the list together: a team, then the current cycle on top.
  await choose(section, 'Team', /^Engineering/, /Team Engineering/);
  await expect(rows(section)).toHaveCount(3);
  await section.getByRole('button', { name: 'Current cycle' }).click();
  await expect(rows(section)).toHaveText([/ENG-418/, /ENG-422/]);
  await expect(section.getByRole('tab', { name: /All tickets/ })).toContainText('02');
  await choose(section, 'Assignee', /^Priya Patel/, /Assignee Priya Patel/);
  await expect(rows(section)).toHaveText([/ENG-422/]);
  await section.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(section)).toHaveCount(4);

  // Open an issue: its fields, the description read-only (its image never fetched), and comments.
  await rows(section).filter({ hasText: 'Fix the login loop' }).click();
  const pane = section.getByRole('region', { name: 'Issue detail' });
  await expect(pane.getByRole('heading', { name: 'Fix the login loop' })).toBeVisible();
  await expect(pane.locator('[data-field="state"] dd')).toHaveText('In Progress');
  await expect(pane.locator('[data-field="assignee"] dd')).toHaveText('You (Sam Rivera)');
  await expect(pane.locator('[data-field="linearProject"] dd')).toHaveText('Login revamp');
  await expect(pane.locator('[data-field="cycle"] dd')).toHaveText('Cycle 41');
  const description = pane.getByRole('region', { name: 'Description' });
  await expect(description.locator('strong')).toHaveText('loops');
  await expect(description.getByRole('link', { name: /Image: the loop/ })).toBeVisible();
  await expect(pane.locator('img')).toHaveCount(0);
  await expect(pane.getByRole('region', { name: 'Comments' })).toContainText('Reproduced on staging.');
  expect(image.hits()).toBe(0);

  // Links leave for the system browser, and the window stays on Commander.
  await description.getByRole('link', { name: /Edit in Linear/ }).click();
  await description.getByRole('link', { name: 'the runbook' }).click();
  await expect
    .poll(openedExternally)
    .toEqual(['https://linear.app/fake/issue/ENG-418', 'https://acme.test/runbook']);
  await expect(section).toBeVisible();

  // File it with b: the activity log says so, and undo puts it back.
  await window.keyboard.press('b');
  const picker = window.getByRole('dialog', { name: 'Badge picker' });
  await picker.getByRole('combobox').fill('lt');
  await picker.getByRole('combobox').press('Enter');
  const row = rows(section).filter({ hasText: 'Fix the login loop' });
  await expect(row.getByRole('img', { name: 'Longtail' })).toBeVisible();
  const activity = pane.getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('listitem').first()).toContainText('Filed under LT by you');
  await window.keyboard.press('Control+z');
  await expect(row.getByRole('img', { name: 'Unfiled' })).toBeVisible();
  await expect(activity.getByRole('listitem').first()).toContainText('Filing undone by you');
  await window.keyboard.press('Escape');
  await expect(pane).toBeHidden();

  // A new issue assigned to the User arrives with the next sync, and the tab count follows.
  linear.issues.add(ACME.id, { identifier: 'ENG-430', title: 'Add audit events', assignee: ME });
  await tab(window, 'Todos').click();
  await tab(window, 'Linear').click();
  await expect(tab(window, 'Linear').locator('.tc')).toHaveText('03');
  await expect(rows(section)).toHaveCount(5);
  expect(image.hits()).toBe(0);
});
