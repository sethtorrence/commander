import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchCommander } from './launch-commander';

test('the window saves and queries Items through the typed channel, and they persist', async () => {
  const { app, userDataDir } = await launchCommander();
  const page = await app.firstWindow();

  const created = await page.evaluate(() =>
    window.commander.itemStore({
      op: 'record',
      action: { type: 'create', item: { kind: 'todo', title: 'Ship the Item store' } },
    }),
  );
  expect(created).toMatchObject({ action: 'create', by: { kind: 'user' } });
  await app.close();

  const again = await launchCommander({ userDataDir });
  const reopened = await again.app.firstWindow();
  const todos = await reopened.evaluate(() =>
    window.commander.itemStore({ op: 'query', query: { kinds: ['todo'] } }),
  );
  expect(todos).toMatchObject([{ id: created.itemId, title: 'Ship the Item store', source: null }]);
  await again.app.close();

  // The database lives in userData, and the Core took today's snapshot of it at start-up.
  expect(readdirSync(userDataDir)).toContain('commander.db');
  expect(readdirSync(join(userDataDir, 'snapshots'))).toEqual([
    expect.stringMatching(/^commander-[\d-]+\.db$/),
  ]);
});

test('the window cannot ask the Item store for anything outside the contract', async () => {
  const { app } = await launchCommander();
  const page = await app.firstWindow();

  const refusal = await page.evaluate(() =>
    window.commander
      // Sources write through the Core, never through the window.
      .itemStore({ op: 'saveFromSource', batch: {} } as never)
      .then(
        () => 'accepted',
        (error: Error) => error.message,
      ),
  );

  expect(refusal).toMatch(/Rejected Item store request/);
  await app.close();
});

test('the sandboxed preload bundle carries no validation library', () => {
  const preload = readFileSync(join(import.meta.dirname, '../out/preload/index.cjs'), 'utf8');

  expect(preload).not.toMatch(/zod/i);
});
