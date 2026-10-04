import type { AutonomyTestRequest, Proposal } from '@commander/domain';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { launchCommander } from './launch-commander';
import { pickOption } from './pick-option';

// Ares's jobs arrive later, so these tests stand in for them: with COMMANDER_TEST_HOOKS=1 the main
// process exposes a hook (never reachable from the window) that registers actions and hands
// proposals to the gate, as a job would.
const testHooks = { env: { COMMANDER_TEST_HOOKS: '1' } };

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

const registerSuggestTodos = (app: ElectronApplication) =>
  hook(app, {
    op: 'register-action',
    action: { action: 'suggest-todos', actionKind: 'organise', name: 'Suggest Todos' },
  });

let blocksWritten = 0;

// A Block the User wrote, made through the window's Item store channel as the User.
async function writeBlock(page: Page, title: string): Promise<string> {
  const entry = await page.evaluate(
    async ({ title, position }) => {
      const note = await window.commander.itemStore({ op: 'daily-note', day: '2026-10-01' });
      return window.commander.itemStore({
        op: 'record',
        action: {
          type: 'create',
          item: {
            kind: 'block',
            title,
            detail: {
              kind: 'block',
              dailyNoteId: note.id,
              parentId: null,
              position,
              text: title,
              folded: false,
            },
          },
        },
      });
    },
    { title, position: `a${blocksWritten++}` },
  );
  return entry.itemId;
}

const suggestTodo = (
  block: string,
  title: string,
  confidence: number,
  extra: Partial<Proposal> = {},
): Proposal => ({
  actionKind: 'organise',
  action: 'suggest-todos',
  section: 'notes',
  itemId: block,
  itemActions: [
    {
      type: 'create',
      item: { kind: 'todo', title, detail: { kind: 'todo', origin: 'ares', dueOn: null, backedBy: null } },
    },
    { type: 'link', from: { step: 0 }, linkType: 'made-from', to: block },
  ],
  confidence,
  reason: `You wrote that you need to ${title.toLowerCase()}`,
  causedBy: { itemId: block },
  ...extra,
});

const todoTitles = (page: Page) =>
  page.evaluate(async () =>
    (await window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } })).map((todo) => todo.title),
  );

async function choose(window: Page, cell: string, level: string) {
  await pickOption(window.getByRole('combobox', { name: cell, exact: true }), level);
}

test('the Autonomy grid greys out levels above the hard limits, lists registered actions and keeps its choices', async () => {
  const first = await launchCommander(testHooks);
  let window = await first.app.firstWindow();
  await registerSuggestTodos(first.app);
  await openSettings(window);
  const grid = window.getByRole('table', { name: 'Autonomy settings' });
  await expect(grid).toBeVisible();

  // The defaults, and Act for you can't go above Ask.
  await expect(grid.getByRole('combobox', { name: 'Organise · Everywhere' })).toHaveText('Auto when sure');
  await expect(grid.getByRole('combobox', { name: 'Delete · Everywhere' })).toHaveText('Off');
  await grid.getByRole('combobox', { name: 'Act for you · Everywhere' }).click();
  await expect(window.getByRole('option', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(window.getByRole('option', { name: 'Auto when sure' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await window.getByRole('option', { name: 'Ask', exact: true }).click();

  // The registered action, with a level of its own.
  await expect(grid.getByTestId('registered-action')).toHaveText(/Suggest Todos/);
  await choose(window, 'Suggest Todos', 'Ask');
  await choose(window, 'Delete · Everywhere', 'Ask');
  await choose(window, 'Tidy your Sources · Email', 'Auto');
  await first.app.close();

  // Restart on the same data: the choices are still there.
  const second = await launchCommander({ ...testHooks, userDataDir: first.userDataDir });
  window = await second.app.firstWindow();
  await registerSuggestTodos(second.app);
  await openSettings(window);
  await expect(window.getByRole('combobox', { name: 'Suggest Todos' })).toHaveText('Ask');
  await expect(window.getByRole('combobox', { name: 'Delete · Everywhere' })).toHaveText('Ask');
  await expect(window.getByRole('combobox', { name: 'Tidy your Sources · Email' })).toHaveText('Auto');
  await expect(window.getByRole('combobox', { name: 'Tidy your Sources · Linear' })).toHaveText('Same');
  await second.close();
});

test('fixture proposals: Auto is undone from Ares’s activity page, Ask is accepted there, and a chained one shows its cause', async () => {
  const commander = await launchCommander(testHooks);
  const { app } = commander;
  const window = await app.firstWindow();
  await registerSuggestTodos(app);
  const dana = await writeBlock(window, 'need to send Dana the Q3 numbers');
  const flights = await writeBlock(window, 'maybe book flights for the offsite');

  // Sure: Ares adds the Todo himself. Unsure: he asks.
  expect(
    await hook(app, { op: 'propose', proposal: suggestTodo(dana, 'Send Dana the Q3 numbers', 0.95) }),
  ).toMatchObject({ decision: 'auto' });
  expect(
    await hook(app, { op: 'propose', proposal: suggestTodo(flights, 'Book flights for the offsite', 0.5) }),
  ).toMatchObject({ decision: 'ask' });
  expect(await todoTitles(window)).toEqual(['Send Dana the Q3 numbers']);

  // The header's Ares status module opens his activity page.
  await window.getByRole('button', { name: 'Ares’s activity' }).click();
  const activity = window.getByRole('list', { name: 'Ares’s activity' });
  const done = activity.getByRole('listitem', { name: 'Suggest Todos: need to send Dana the Q3 numbers' });
  const asked = activity.getByRole('listitem', { name: 'Suggest Todos: maybe book flights for the offsite' });
  await expect(done.getByTestId('activity-status')).toHaveText('Done by Ares');
  await expect(done).toContainText('You wrote that you need to send dana the q3 numbers');
  await expect(asked.getByTestId('activity-status')).toHaveText('Waiting for you');
  await expect(asked).toContainText('Add the Todo “Book flights for the offsite”');

  // Undo reverses what Ares did.
  await done.getByRole('button', { name: 'Undo' }).click();
  await expect(done.getByTestId('activity-status')).toHaveText('Done by Ares · undone');
  await expect(done.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  expect(await todoTitles(window)).toEqual([]);

  // Accepting carries the suggestion out.
  await asked.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(asked.getByTestId('activity-status')).toHaveText('Accepted by you');
  expect(await todoTitles(window)).toEqual(['Book flights for the offsite']);

  // A chained suggestion asks even when Ares is sure, says what caused it, and does nothing more
  // once accepted.
  await hook(app, {
    op: 'propose',
    proposal: suggestTodo(flights, 'Tell Dana the offsite dates', 1, {
      chained: true,
      causedBy: { itemId: dana },
      reason: 'Dana will need the offsite dates for the Q3 numbers',
    }),
  });
  const chained = activity.getByRole('listitem').first();
  await expect(chained.getByTestId('activity-status')).toHaveText('Waiting for you');
  await expect(chained.getByTestId('activity-cause')).toHaveText(
    'Suggested because of need to send Dana the Q3 numbers',
  );
  await chained.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(chained.getByTestId('activity-status')).toHaveText('Accepted by you');
  await expect(activity.getByRole('listitem')).toHaveCount(3);

  await commander.close();
});
