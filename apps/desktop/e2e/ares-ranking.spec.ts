import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AutonomyTestRequest } from '@commander/domain';
import {
  chatCompletion,
  type FakeOpenAIServer,
  type FakeReply,
  type FakeRequest,
  startFakeOpenAIServer,
} from '@commander/models/testing';
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test';
import { ACME, type FakeLinear, startFakeLinear, viewerOf } from '../src/main/linear/fake-linear-server';
import { openSettings, tab } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Ares ranks the Dashboard, end to end: a fake Linear (never the real one) and a fake
// OpenAI-compatible server standing in for Z.ai. A sync brings issues; Ares ranks them, with a
// suggested Todo of his and a Todo the rules would leave off, into his bands with his reasons; the
// suggested Todo is added from the Dashboard; a row is cleared; and at Off the rules rank it again,
// saying so. The model's key and the Linear key go in the real keyring, so this needs the author's
// Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;
const API_KEY = 'lin_api_e2e_ares_ranking_key';
const ME = viewerOf(ACME);
const PRIYA = { id: 'user-priya', name: 'Priya Patel', displayName: 'priya', email: 'priya@acme.test' };
const STARTED = { id: 'state-progress', name: 'In Progress', type: 'started', color: '#f2c94c' };

// What the fake model says about each Item it is shown, by title: band, rank and reason.
const RANKING: Record<string, [string, number, string]> = {
  'Write the runbook': ['now', 1, 'Priya needs it before the 3pm review'],
  'Fix the outage': ['today', 2, 'Mitigated overnight, the fix can wait till noon'],
  'Book flights for the offsite': ['today', 1, 'Fares jump after today'],
  'Renew passport': ['today', 3, 'Your trip is in three weeks'],
  'Audit log export': ['fyi', 1, 'Priya picked it up this morning'],
};

// The fake model: Rank the Dashboard gets RANKING for the Items it was given (by the reference its
// prompt gave each), any other job nothing to do.
function model(request: FakeRequest): FakeReply {
  const messages = request.body.messages as { role: string; content: string }[];
  if (!messages[0]?.content.includes("rank the User's Dashboard"))
    return { json: chatCompletion(JSON.stringify({ todos: [] })) };
  const ranking = [
    ...(messages.at(-1)?.content ?? '').matchAll(/label="(I\d+) · [^"]*"[^>]*>\n(?:┆ )?Title: (.*)/g),
  ].flatMap(([, ref, title]) => {
    const known = RANKING[title?.trim() ?? ''];
    return known ? [{ ref, band: known[0], rank: known[1], reason: known[2] }] : [];
  });
  return {
    json: chatCompletion(JSON.stringify({ ranking }), { prompt: 2_400, completion: 300 }),
    delayMs: 300,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function hook(app: ElectronApplication, request: AutonomyTestRequest) {
  return app.evaluate(async (_electron, request) => {
    const hooks = (globalThis as { commanderTestHooks?: { autonomy: (r: unknown) => Promise<unknown> } })
      .commanderTestHooks;
    if (!hooks) throw new Error('Test hooks are off');
    const response = (await hooks.autonomy(request)) as { ok: boolean; result?: unknown; error?: string };
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }, request);
}

// A Block the User wrote in today's Daily Note, and Ares's suggestion of a Todo for it, waiting.
async function suggestTodo(app: ElectronApplication, page: Page, text: string, title: string) {
  const block = await page.evaluate(async (text) => {
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const note = await window.commander.itemStore({ op: 'daily-note', day });
    const entry = await window.commander.itemStore({
      op: 'record',
      action: {
        type: 'create',
        item: {
          kind: 'block',
          title: text,
          detail: {
            kind: 'block',
            dailyNoteId: note.id,
            parentId: null,
            position: 'a0',
            text,
            folded: false,
          },
        },
      },
    });
    return entry.itemId;
  }, text);
  await hook(app, {
    op: 'propose',
    proposal: {
      actionKind: 'organise',
      action: 'suggest-todos',
      section: 'notes',
      itemId: block,
      itemActions: [
        {
          type: 'create',
          item: {
            kind: 'todo',
            title,
            detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null },
          },
        },
        { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
      ],
      confidence: 0.5,
      reason: `You wrote “${text}” in your Daily Note.`,
    },
  });
}

// Points Ares's model at the fake server and saves a made-up key in the keyring.
async function connectFakeModel(window: Page, server: FakeOpenAIServer) {
  await openSettings(window);
  const ares = window.getByTestId('ares-settings');
  for (const tier of ['Quick', 'Deep']) {
    await ares.getByRole('textbox', { name: `${tier} base URL` }).fill(server.baseUrl);
  }
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
  await window.getByTestId('model-key-input').fill('zai-e2e-ares-ranking-key');
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
}

let linear: FakeLinear;
let server: FakeOpenAIServer;
let commander: LaunchedCommander | undefined;

test.beforeEach(async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  server = await startFakeOpenAIServer();
  server.respondWith(model);
  linear = await startFakeLinear();
  linear.addApiKey(API_KEY, ACME);
  linear.issues.add(ACME.id, {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the outage',
    assignee: ME,
    priority: 1,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-2',
    identifier: 'ENG-2',
    title: 'Write the runbook',
    assignee: ME,
    state: STARTED,
  });
  linear.issues.add(ACME.id, {
    id: 'issue-4',
    identifier: 'ENG-4',
    title: 'Audit log export',
    creator: ME,
    assignee: PRIYA,
  });
});

test.afterEach(async () => {
  await commander?.close();
  commander = undefined;
  await linear?.close();
  await server?.close();
});

const band = (dashboard: Locator, name: string) => dashboard.getByRole('region', { name, exact: true });
const rows = (scope: Locator) => scope.getByTestId('dashboard-row');

test('sync, Ares’s bands and reasons, Add a suggested Todo, clear a row; at Off the rules rank it', async () => {
  test.setTimeout(90_000);
  commander = await launchCommander({
    env: {
      COMMANDER_TEST_HOOKS: '1',
      COMMANDER_TEST_LINEAR: JSON.stringify({
        clientId: null,
        port: await freePort(),
        authorizeUrl: linear.authorizeUrl,
        tokenUrl: linear.tokenUrl,
        apiUrl: linear.apiUrl,
      }),
    },
  });
  const page = await commander.app.firstWindow();
  await connectFakeModel(page, server);
  // A Todo with no due date (the rules leave it off) and a suggestion of Ares's, waiting.
  await page.evaluate(() =>
    window.commander.itemStore({
      op: 'record',
      action: {
        type: 'create',
        item: {
          kind: 'todo',
          title: 'Renew passport',
          detail: { kind: 'todo', origin: 'manual', dueOn: null, backedBy: null },
        },
      },
    }),
  );
  await suggestTodo(
    commander.app,
    page,
    'maybe book flights for the offsite',
    'Book flights for the offsite',
  );

  // Connect Linear: the sync brings the issues, and Ares ranks after it.
  const panel = page.getByTestId('accounts-panel');
  await panel.getByLabel('Linear personal API key').fill(API_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByTestId('account-synced')).toHaveText(/3 issues/);
  await page.keyboard.press('Escape');

  const dashboard = page.getByTestId('section-dashboard');
  await expect(dashboard.getByTestId('ranked-at')).toHaveText(/^Ranked by Ares · \d\d:\d\d$/, {
    timeout: 20_000,
  });
  await expect(rows(band(dashboard, 'Now'))).toHaveText(
    [/ENG-2Write the runbook.*Priya needs it before the 3pm review/],
    {
      timeout: 20_000,
    },
  );
  await expect(rows(band(dashboard, 'Today'))).toHaveText([
    /Book flights for the offsite.*ARESSuggested Todo.*Fares jump after today/,
    /ENG-1Fix the outage.*Mitigated overnight/,
    /Renew passport.*Your trip is in three weeks/,
  ]);
  await expect(rows(band(dashboard, 'FYI'))).toHaveText([
    /ENG-4Audit log export.*Priya picked it up this morning/,
  ]);
  // Each Item in its own data block; one Quick call at low thinking per run.
  const call = server.requests.at(-1)?.body as { reasoning_effort: string; messages: { content: string }[] };
  expect(call.reasoning_effort).toBe('low');
  expect(call.messages.at(-1)?.content).toMatch(/label="I\d+ · Linear issue ENG-1" source="outside">/);

  // Add the suggested Todo from the Dashboard: it is a Todo now, of Ares's origin.
  const flights = rows(dashboard).filter({ hasText: 'Book flights for the offsite' });
  await flights.getByRole('button', { name: 'Add' }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (
          await window.commander.itemStore({
            op: 'query',
            query: { kinds: ['todo'], titleContains: 'flights' },
          })
        ).map((todo) => (todo.detail?.kind === 'todo' ? todo.detail.origin : null)),
      ),
    )
    .toEqual(['ares']);

  // Clear a row with e: it leaves the Dashboard, and stays in its Section.
  await rows(dashboard).getByText('Audit log export').click();
  await page.keyboard.press('e');
  await expect(band(dashboard, 'FYI').getByTestId('dashboard-row')).toHaveCount(0);
  await expect(dashboard).toContainText('1 cleared');

  // Every ranking run is on the Usage page, under its name.
  await openSettings(page);
  const usage = page.getByTestId('usage-panel');
  await usage.getByRole('button', { name: 'Refresh' }).click();
  await expect(usage.getByTestId('usage-by-job')).toContainText('Rank the Dashboard');

  // At Off, the rules rank the Dashboard, and it says so.
  await page.evaluate(() =>
    window.commander.autonomy({
      op: 'set-level',
      target: { scope: 'action', action: 'rank-dashboard' },
      level: 'off',
    }),
  );
  await tab(page, 'Dashboard').click();
  await expect(dashboard.getByTestId('ranked-at')).toHaveText(/^Ranked by rules · /);
  await expect(dashboard.getByTestId('ranked-at')).toHaveAttribute(
    'title',
    'Ares is Off for ranking the Dashboard',
  );
  await expect(rows(band(dashboard, 'Now'))).toHaveText([/ENG-1Fix the outage.*Urgent · ENG/]);
  await expect(dashboard).not.toContainText('Renew passport');
});
