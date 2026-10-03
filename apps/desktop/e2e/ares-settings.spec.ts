import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatCompletion, type FakeOpenAIServer, startFakeOpenAIServer } from '@commander/models/testing';
import { expect, type Page, test } from '@playwright/test';
import { openSettings } from './frame';
import { type LaunchedCommander, launchCommander } from './launch-commander';

// Settings → Ares against a fake OpenAI-compatible server: tests never call Z.ai.

// Saving a key needs the Secret Service keyring that Commander uses on Linux/Wayland.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

let server: FakeOpenAIServer;

test.beforeEach(async () => {
  server = await startFakeOpenAIServer();
});

test.afterEach(async () => {
  await server.close();
});

const ares = (window: Page) => window.getByTestId('ares-settings');
const usage = (window: Page) => window.getByTestId('usage-panel');
const thinking = (window: Page, tier: 'Quick' | 'Deep', level: 'Low' | 'High' | 'Max') =>
  ares(window)
    .getByRole('radiogroup', { name: `${tier} thinking` })
    .getByRole('radio', { name: level });

async function pointTiersAtFakeServer(window: Page) {
  for (const tier of ['Quick', 'Deep']) {
    await ares(window)
      .getByRole('textbox', { name: `${tier} base URL` })
      .fill(server.baseUrl);
  }
}

async function saveSettings(window: Page) {
  await window.getByTestId('model-settings-save').click();
  await expect(window.getByTestId('model-settings-saved')).toBeVisible();
}

// Everything Commander wrote to its data folder, as text, for leak checks.
function everythingWritten(userDataDir: string): string {
  const files = readdirSync(userDataDir, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  );
  return files.map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString('latin1')).join('\n');
}

test('the Quick and Deep tiers default to low and high thinking, and changes persist', async () => {
  const first = await launchCommander();
  const window = await first.app.firstWindow();
  await openSettings(window);

  await expect(thinking(window, 'Quick', 'Low')).toHaveAttribute('aria-checked', 'true');
  await expect(thinking(window, 'Deep', 'High')).toHaveAttribute('aria-checked', 'true');
  await expect(ares(window).getByRole('textbox', { name: 'Quick model' })).toHaveValue('glm-5.3-flash');
  await expect(ares(window).getByRole('textbox', { name: 'Quick base URL' })).toHaveValue(
    'https://api.z.ai/api/paas/v4',
  );

  await thinking(window, 'Deep', 'Max').click();
  await ares(window).getByRole('textbox', { name: 'Job', exact: true }).fill('draft-reply');
  await ares(window)
    .getByRole('radiogroup', { name: 'Job thinking' })
    .getByRole('radio', { name: 'Low' })
    .click();
  await ares(window).getByRole('button', { name: 'Add' }).click();
  await window.getByTestId('monthly-cap').fill('5');
  await saveSettings(window);
  await first.app.close();

  const again = await launchCommander({ userDataDir: first.userDataDir });
  const reopened = await again.app.firstWindow();
  await openSettings(reopened);
  await expect(thinking(reopened, 'Deep', 'Max')).toHaveAttribute('aria-checked', 'true');
  await expect(thinking(reopened, 'Quick', 'Low')).toHaveAttribute('aria-checked', 'true');
  await expect(reopened.getByTestId('job-overrides')).toContainText('draft-reply');
  await expect(reopened.getByTestId('monthly-cap')).toHaveValue('5');
  await expect(usage(reopened).getByTestId('usage-cap')).toHaveText('$0.00 of $5.00 (0%)');
  await again.close();
});

test('Test without a saved key says how to add one', async () => {
  const commander = await launchCommander();
  const window = await commander.app.firstWindow();
  await openSettings(window);
  await pointTiersAtFakeServer(window);
  await saveSettings(window);

  await window.getByTestId('model-test').click();

  await expect(window.getByTestId('model-test-problem')).toContainText('API key');
  expect(server.requests).toHaveLength(0);
  await commander.close();
});

test('a key saved in Settings → Ares reaches the model through the Core, never the window, logs or disk', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  const key = `zai-e2e-${randomBytes(12).toString('hex')}`;
  let commander: LaunchedCommander | null = await launchCommander();
  const output: string[] = [];
  const capture = (app: LaunchedCommander['app']) => {
    app.process().stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    app.process().stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  };
  capture(commander.app);
  const window = await commander.app.firstWindow();
  window.on('console', (message) => output.push(message.text()));
  await openSettings(window);
  await pointTiersAtFakeServer(window);
  await saveSettings(window);

  await window.getByTestId('model-key-input').fill(key);
  await window.getByTestId('model-key-save').click();
  await expect(window.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await expect(window.getByTestId('model-key-input')).toHaveValue('');

  server.reply({ json: chatCompletion('Loud and clear, Seth.', { prompt: 2_000, completion: 400 }) });
  await window.getByTestId('model-test').click();

  await expect(window.getByTestId('model-test-reply')).toHaveText('Loud and clear, Seth.');
  await expect(window.getByTestId('model-test-latency')).toHaveText(/^\d+(\.\d)? m?s$/);
  // 2,000 input tokens at $0.15 and 400 output at $0.50 per 1M.
  await expect(window.getByTestId('model-test-cost')).toHaveText('$0.0005');
  expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${key}`);
  expect(server.requests[0]?.body).toMatchObject({ model: 'glm-5.3-flash', reasoning_effort: 'low' });
  expect(JSON.stringify(server.requests[0]?.body)).not.toContain(key);

  // The Usage page counts the call, and its totals match the log.
  await expect(usage(window).getByTestId('usage-today')).toHaveText('$0.0005 · 1 call');
  await expect(usage(window).getByTestId('usage-month')).toHaveText('$0.0005 · 1 call');
  await expect(usage(window).getByTestId('usage-by-job')).toContainText('settings-test');
  await expect(usage(window).getByTestId('usage-by-provider')).toContainText('Z.ai');

  // The key is nowhere in the window.
  const inWindow = await window.evaluate(() => {
    const values = [...document.querySelectorAll('input')].map((input) => input.value);
    return [document.documentElement.outerHTML, ...values, JSON.stringify(localStorage)].join('\n');
  });
  expect(inWindow).not.toContain(key);

  // It survives a restart (in the keyring), and so does the usage log.
  await commander.app.close();
  const userDataDir = commander.userDataDir;
  commander = await launchCommander({ userDataDir });
  capture(commander.app);
  const reopened = await commander.app.firstWindow();
  await openSettings(reopened);
  await expect(reopened.getByTestId('model-key-status')).toHaveText('A key is saved in the keyring.');
  await expect(usage(reopened).getByTestId('usage-month')).toHaveText('$0.0005 · 1 call');
  await reopened.getByTestId('model-test').click();
  await expect(reopened.getByTestId('model-test-reply')).toBeVisible();
  expect(server.requests[1]?.headers.authorization).toBe(`Bearer ${key}`);
  await commander.app.close();

  // Not in the database, the secrets file, snapshots or anything else on disk, nor in any log.
  expect(everythingWritten(userDataDir)).not.toContain(key);
  expect(output.join('\n')).not.toContain(key);
  await commander.close();
});
