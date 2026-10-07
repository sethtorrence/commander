import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import { ALEX, startFakeGoogle } from '../src/main/google/fake-google-server';
import { openSettings, settingsPage } from './frame';
import { launchCommander } from './launch-commander';

// Logs and Diagnostics (#207): main and the Core write their logs in the data folder, Settings →
// Diagnostics says in plain words how Commander is doing, and Export diagnostics writes the logs,
// versions and settings that aren't secret to a file from the system save picker (stood in for
// here), never a token, email text or what an Item says.

// Written in pieces so the source never holds a whole token-shaped string.
const PLANTED_TOKEN = 'gh' + 'p_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const ITEM_TEXT = 'Planted note about the Tactics acquisition';

// Stands in for the system save picker: the export goes to `path`.
const standInForSavePicker = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as never;
  }, path);

// A Block in today's Daily Note, through the Item store (the template left empty).
const writeBlock = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const store = window.commander.itemStore;
    await store({ op: 'save-daily-template', template: { blocks: [] } });
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const note = await store({
      op: 'daily-note',
      day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    });
    await store({
      op: 'record-all',
      actions: [
        {
          type: 'create',
          item: {
            id: crypto.randomUUID(),
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
      ],
    });
  }, text);

const corePid = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { commanderTestHooks: { corePid: () => number | null } }
    ).commanderTestHooks.corePid(),
  );

async function exportDiagnostics(page: Page, app: ElectronApplication, folder: string): Promise<string> {
  const path = join(folder, 'diagnostics.md');
  await standInForSavePicker(app, path);
  const exporting = page.getByTestId('diagnostics-export');
  await exporting.getByRole('button', { name: 'Export diagnostics…' }).click();
  await expect(exporting.getByTestId('diagnostics-exported')).toContainText(path);
  return readFileSync(path, 'utf8');
}

test('Diagnostics says how Commander is doing, and the export has the log and versions but no secret or content', async () => {
  test.setTimeout(90_000);
  const commander = await launchCommander({
    env: { COMMANDER_TEST_HOOKS: '1', COMMANDER_TEST_CORE_RESTART_DELAYS_MS: '300,300,300' },
  });
  const folder = mkdtempSync(join(tmpdir(), 'commander-e2e-diagnostics-'));
  try {
    const { app } = commander;
    const page = await commander.window();
    await writeBlock(page, ITEM_TEXT);
    // A careless warning in main carrying a token, as a failed sign-in's error might.
    await app.evaluate(
      (_electron, token) => console.warn(`Refresh failed: Authorization: token ${token}`),
      PLANTED_TOKEN,
    );

    // The Core stops once, as a crash would, and a new one starts.
    const first = await corePid(app);
    if (first === null) throw new Error('no Core');
    process.kill(first, 'SIGKILL');
    await expect
      .poll(async () => {
        const pid = await corePid(app);
        return pid !== null && pid !== first;
      })
      .toBe(true);

    await openSettings(page, 'Diagnostics');
    await expect(page.getByTestId('core-health')).toHaveText('Healthy', { timeout: 15_000 });
    await expect(page.getByTestId('core-restarts')).toContainText(/^1 · last exited/);
    await expect(page.getByTestId('diagnostics-database')).toHaveText('Healthy');
    await expect(page.getByTestId('diagnostics-migration')).toHaveText(/^00\d\d_\w+$/);
    await expect(page.getByTestId('diagnostics-snapshot')).not.toHaveText('…');
    await expect(page.getByTestId('diagnostics-no-accounts')).toBeVisible();
    await expect(page.getByTestId('diagnostics-no-runs')).toBeVisible();
    await expect(page.getByTestId('diagnostics-version')).toHaveText(/^\d+(\.\d+)+/);

    // Both processes write their logs in the data folder's logs folder.
    expect(readdirSync(join(commander.userDataDir, 'logs')).sort()).toEqual(['core.log', 'main.log']);

    const written = await exportDiagnostics(page, app, folder);
    expect(written).toContain('# Commander diagnostics');
    expect(written).toMatch(/- Commander \d+(\.\d+)+/);
    expect(written).toMatch(/- Electron \d+/);
    expect(written).toContain('- Restarts since Commander started: 1');
    expect(written).toContain('- Database: ok');
    expect(written).toContain('"autonomy"');
    // The log: main's and the Core's lines, the restart among them.
    expect(written).toMatch(/INFO {2}main app {6}Commander \S+ started/);
    expect(written).toMatch(
      /WARN {2}main core {5}The Core exited \(code \S+\); starting a new one in 0\.3 s/,
    );
    expect(written).toMatch(/INFO {2}main core {5}Started a new Core \(restart 1\)/);
    expect(written).toMatch(/INFO {2}core core {5}The Core started \(pid \d+\)/);
    expect(written).toMatch(/INFO {2}core database {1}Opened the database: it passed its quick check/);
    expect(written).toMatch(/INFO {2}core backups {2}Took today’s snapshot/);
    expect(written).toContain('Refresh failed: Authorization: [removed]');
    // Never the token, nor what the Block says.
    expect(written).not.toContain(PLANTED_TOKEN);
    expect(written).not.toContain(ITEM_TEXT);
    expect(written).not.toContain('Tactics acquisition');
  } finally {
    await commander.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

// Tokens are stored in the real keyring, so this needs the author's Linux Wayland session.
const onLinuxWayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY;

test('each Account’s last and next sync and its runs, and the export never holds its tokens or its mail', async () => {
  test.skip(!onLinuxWayland, 'needs a Linux Wayland session with a Secret Service keyring');
  test.setTimeout(90_000);
  const google = await startFakeGoogle();
  google.gmail.deliver(ALEX.email, {
    from: 'Dana Whitfield <dana@northwind.test>',
    to: `Alex Kim <${ALEX.email}>`,
    subject: 'Boathouse blueprints',
    text: 'Meet me at the boathouse at noon and bring the blueprints.',
    date: Date.now() - 3_600_000,
  });
  const commander = await launchCommander({
    env: {
      COMMANDER_TEST_GOOGLE: JSON.stringify({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        authorizeUrl: google.authorizeUrl,
        tokenUrl: google.tokenUrl,
        userinfoUrl: google.userinfoUrl,
        gmailUrl: google.gmailUrl,
      }),
    },
  });
  const folder = mkdtempSync(join(tmpdir(), 'commander-e2e-diagnostics-'));
  try {
    const { app } = commander;
    const page = await commander.window();
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        await fetch(url);
      };
    });
    await openSettings(page, 'Accounts');
    const section = page.getByTestId('accounts-panel').getByTestId('source-google');
    await section.getByRole('button', { name: 'Connect Google' }).click();
    await expect(section.getByTestId('account-status')).toHaveText('Connected');
    await expect(section.getByTestId('account-synced')).toHaveText(/^Synced \d\d:\d\d · 1 email$/);

    await settingsPage(page, 'Diagnostics');
    const gmail = page.getByTestId('diagnostics-account').and(page.locator('[data-source="gmail"]'));
    await expect(gmail).toContainText(`Google · ${ALEX.email} · Gmail`);
    await expect(gmail.getByTestId('diagnostics-account-synced')).toHaveText(/^Synced \d\d:\d\d · 1 email$/);
    await expect(gmail.getByTestId('diagnostics-account-next')).toHaveText(/^Next sync \d\d:\d\d$/);
    const run = page.getByTestId('diagnostics-run').filter({ hasText: 'Gmail' }).first();
    await expect(run).toHaveAttribute('data-outcome', 'synced');
    await expect(run).toContainText('Synced');

    const written = await exportDiagnostics(page, app, folder);
    expect(written).toMatch(/\| google:\d+ \| gmail \| \w+ \| 15 min \|/);
    expect(written).toMatch(/gmail sync of google:\d+ \(\w+\): synced in/);
    expect(google.issuedTokens().length).toBeGreaterThan(0);
    for (const token of google.issuedTokens()) expect(written).not.toContain(token);
    for (const content of ['Boathouse blueprints', 'boathouse at noon', 'blueprints', 'Dana Whitfield'])
      expect(written).not.toContain(content);
  } finally {
    await commander.close();
    await google.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
