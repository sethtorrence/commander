import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { FAKE_LABELS, FAKE_STATES } from '../src/main/linear/fake-linear-issues';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// Linear-backed Todos end to end, against a fake Linear on this machine (never the real one): an
// issue assigned to the User becomes a Todo labelled with its identifier, ticking it completes the
// issue in Linear, a reassignment that only the re-check of open Linear Todos sees removes another
// Todo (saying who has it now), Set Linear state… moves an issue, and `x` on the Dashboard ticks a
// Linear row's Todo. Tokens are stored in the real keyring, so these need the author's Linux Wayland
// session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_linear_todos_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const state = (name: string) =>
  FAKE_STATES.find((each) => each.name === name) as (typeof FAKE_STATES)[number];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Syncs every Account now, as the 15-minute sync would, without leaving the open Section.
const syncNow = (page: Page) =>
  page.evaluate(async () => {
    const { state } = await window.commander.accounts({ op: 'list' });
    for (const account of state.accounts)
      await window.commander.accounts({ op: 'sync-now', accountId: account.id });
  });

// The Todos (deleted ones too) and their activity, from the Item store.
const todoTitled = (page: Page, text: string) =>
  page.evaluate(
    async (text) =>
      (
        await window.commander.itemStore({
          op: 'query',
          query: { kinds: ['todo'], titleContains: text, includeDeleted: true },
        })
      )[0] ?? null,
    text,
  );
const activityOf = (page: Page, itemId: string) =>
  page.evaluate((itemId) => window.commander.itemStore({ op: 'activity', query: { itemId } }), itemId);

let linear: FakeLinear;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.setCatalog(ACME.id, [
    { team: ENG, states: FAKE_STATES, members: [ME, PRIYA], labels: FAKE_LABELS, cycles: [], projects: [] },
  ]);
  linear.issues.add(ACME.id, {
    id: 'issue-418',
    identifier: 'ENG-418',
    title: 'Fix the login loop',
    assignee: ME,
    state: state('In Progress'),
  });
  linear.issues.add(ACME.id, {
    id: 'issue-420',
    identifier: 'ENG-420',
    title: 'Rotate the keys',
    assignee: ME,
    state: state('Todo'),
  });
  linear.issues.add(ACME.id, {
    id: 'issue-421',
    identifier: 'ENG-421',
    title: 'Write the runbook',
    assignee: PRIYA,
    state: state('Todo'),
  });
  linear.issues.add(ACME.id, {
    id: 'issue-422',
    identifier: 'ENG-422',
    title: 'Someday cleanup',
    assignee: ME,
    state: state('Backlog'),
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
});

async function connect(window: Page) {
  await openSettings(window);
  const panel = window.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/4 issues/);
  await window.keyboard.press('Escape');
}

test('assigned issues become Linear Todos; ticking completes the issue; a reassignment removes one', async () => {
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
  const window = await commander.app.firstWindow();
  await connect(window);

  // The issues assigned to the User in a Todo state are Todos, labelled with their identifiers.
  await tab(window, 'Todos').click();
  const section = window.getByTestId('section-todos');
  const open = section.getByRole('region', { name: 'Open', exact: true });
  const row = (title: string) => open.getByRole('listitem').filter({ hasText: title });
  await expect(open.getByRole('listitem')).toHaveCount(2);
  await expect(row('Fix the login loop')).toContainText('Linear · ENG-418');
  await expect(row('Rotate the keys')).toContainText('Linear · ENG-420');

  // ENG-421 is assigned to the User in Linear: after the next sync (Todos still open) it is a Todo.
  linear.issues.update('issue-421', { assignee: ME }, PRIYA);
  await syncNow(window);
  await expect(open.getByRole('listitem')).toHaveCount(3);
  await expect(row('Write the runbook')).toContainText('Linear · ENG-421');

  // x ticks ENG-418: the issue moves to the team's default completed state in Linear.
  await row('Fix the login loop').click();
  await expect(row('Fix the login loop')).toHaveAttribute('aria-current', 'true');
  await window.keyboard.press('x');
  await expect(open.getByRole('listitem')).toHaveCount(2);
  await expect.poll(() => linear.issues.get('issue-418').state.name).toBe('Done');
  const updates = linear.graphqlRequests.filter(
    (request) => request.operationName === 'CommanderIssueUpdate',
  );
  expect(updates.at(-1)?.variables).toEqual({ id: 'issue-418', input: { stateId: 'state-done' } });

  // Set Linear state… moves ENG-421 to In Review, in Linear too.
  await row('Write the runbook').click();
  const pane = section.getByRole('region', { name: 'Todo detail' });
  await pickOption(pane.getByRole('combobox', { name: 'Set Linear state…' }), /^In Review$/, /In Review/);
  await expect.poll(() => linear.issues.get('issue-421').state.name).toBe('In Review');

  // ENG-420 is reassigned to Priya in a way Linear's "changed since" doesn't report: only the
  // re-check of open Linear Todos sees it, and its Todo goes, saying who has it now.
  linear.issues.update('issue-420', { assignee: PRIYA }, PRIYA, { quietly: true });
  await syncNow(window);
  await expect(open.getByRole('listitem')).toHaveText([/Write the runbook/]);
  const rotated = await todoTitled(window, 'Rotate the keys');
  expect(rotated?.deletedAt).not.toBeNull();
  const [last] = await activityOf(window, rotated?.id as string);
  expect(last).toMatchObject({
    action: 'delete',
    by: { kind: 'source', source: 'linear' },
    why: 'ENG-420 was reassigned to Priya Patel',
  });

  // The detail pane opens the issue in the Linear Section.
  await pane.getByRole('button', { name: 'Open ENG-421 in the Linear Section' }).click();
  const issuePane = window.getByTestId('section-linear').getByRole('region', { name: 'Issue detail' });
  await expect(issuePane.getByRole('heading', { name: 'Write the runbook' })).toBeVisible();

  // On the Dashboard, x on a Linear row ticks its Todo, completing the issue.
  await tab(window, 'Dashboard').click();
  const dashboard = window.getByTestId('section-dashboard');
  const runbook = dashboard.getByTestId('dashboard-row').filter({ hasText: 'Write the runbook' });
  await expect(runbook).toHaveCount(1);
  await runbook.getByText('Write the runbook').click();
  await expect(runbook).toHaveAttribute('aria-current', 'true');
  await window.keyboard.press('x');
  await expect.poll(async () => (await todoTitled(window, 'Write the runbook'))?.status).toBe('done');
  await expect.poll(() => linear.issues.get('issue-421').state.name).toBe('Done');
});
