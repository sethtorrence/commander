import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { attachmentScheme, type Diagnostics, ipc, parseCoreMessage } from '@commander/domain';
import { app, BrowserWindow, ipcMain, protocol, shell, utilityProcess } from 'electron';
import { setUpAccounts } from './accounts/set-up-accounts';
import { attachmentSchemePrivileges, serveAttachment } from './attachments-protocol';
import { createAutonomyChannels } from './autonomy-channel';
import { claimSingleInstance, runInBackground, startsHidden } from './background';
import { displayServerFromHyprland, inferDisplayServer } from './display-server';
import { keepLinksInBrowser } from './external-links';
import { createItemStoreChannel } from './item-store-channel';
import { launchSwitches } from './launch-switches';
import { setUpModels } from './models';
import { revealWhenPainted } from './reveal';
import { setUpSecretStorage } from './secret-storage';
import type { Secrets } from './secrets';
import { windowWebPreferences } from './window-config';

for (const [name, value] of launchSwitches(process.platform)) app.commandLine.appendSwitch(name, value);
// Pasted images reach the window through attachment://, which must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([attachmentSchemePrivileges]);
const primary = claimSingleInstance();

let window: BrowserWindow | null = null;

async function readDisplayServer(): Promise<Pick<Diagnostics, 'displayServer' | 'displaySource'>> {
  // The window may not be mapped yet when the renderer first asks, so give Hyprland a moment.
  for (let attempt = 0; process.env.HYPRLAND_INSTANCE_SIGNATURE && attempt < 10; attempt++) {
    try {
      const { stdout } = await promisify(execFile)('hyprctl', ['clients', '-j']);
      const server = displayServerFromHyprland(stdout, process.pid);
      if (server) return { displayServer: server, displaySource: 'compositor' };
    } catch {
      break; // hyprctl missing or failed: fall back to guessing.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const displayServer = inferDisplayServer({
    platform: process.platform,
    ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
    ozoneHint: app.commandLine.getSwitchValue('ozone-platform-hint'),
    waylandDisplay: process.env.WAYLAND_DISPLAY,
  });
  return { displayServer, displaySource: 'inferred' };
}

async function diagnostics(): Promise<Diagnostics> {
  return {
    ...(await readDisplayServer()),
    passwordStore: app.commandLine.getSwitchValue('password-store') || 'default',
    electron: process.versions.electron,
  };
}

// End-to-end tests set COMMANDER_TEST_HOOKS=1 to propose as Ares's jobs would. The hook is reachable
// only from the main process (Playwright's app.evaluate), never from the window.
const testHooks = process.env.COMMANDER_TEST_HOOKS === '1';

function startCore(secrets: Secrets) {
  // The Core keeps the database in userData (which --user-data-dir overrides, e.g. in e2e tests).
  const core = utilityProcess.fork(join(__dirname, 'core.js'), [
    `--data-dir=${app.getPath('userData')}`,
    ...(testHooks ? ['--test-hooks'] : []),
  ]);
  const itemStore = createItemStoreChannel((message) => core.postMessage(message));
  ipcMain.handle(ipc.itemStore, (_event, request: unknown) => itemStore.request(request));
  const accounts = setUpAccounts({ secrets, sendToCore: (message) => core.postMessage(message) });
  const models = setUpModels(secrets, core);
  const autonomy = createAutonomyChannels((message) => core.postMessage(message));
  ipcMain.handle(ipc.autonomy, (_event, request: unknown) => autonomy.window.request(request));
  if (testHooks) Object.assign(globalThis, { commanderTestHooks: { autonomy: autonomy.test.request } });
  core.on('message', (raw: unknown) => {
    if (itemStore.settle(raw) || autonomy.window.settle(raw) || autonomy.test.settle(raw)) return;
    // Before Accounts: it answers the Core's token requests for model API keys.
    if (models(raw)) return;
    if (accounts.fromCore(raw)) return;
    const parsed = parseCoreMessage(raw);
    if (!parsed.ok) {
      console.warn('Rejected malformed message from core:', parsed.error);
      return;
    }
    window?.webContents.send(ipc.coreMessage, parsed.message);
  });
  return core;
}

app.whenReady().then(() => {
  if (!primary) return;
  ipcMain.handle(ipc.diagnostics, () => diagnostics());
  const secrets = setUpSecretStorage();
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Commander',
    // Hidden until the first frame is painted in the User's theme (see reveal.ts); this colour
    // only shows while resizing.
    backgroundColor: '#141516',
    show: false,
    webPreferences: windowWebPreferences(join(__dirname, '../preload/index.cjs')),
  });
  const created = window;
  // Links in the window open in the system browser (read at call time, so the end-to-end tests can
  // stand in for it).
  keepLinksInBrowser(created.webContents, (url) => void shell.openExternal(url));
  // Pasted images, served from attachments/ next to the database (the Core writes them there).
  const attachmentsDir = join(app.getPath('userData'), 'attachments');
  protocol.handle(attachmentScheme, (request) => serveAttachment(request, attachmentsDir));
  revealWhenPainted({
    window: created,
    startsHidden: startsHidden(process.argv),
    onPainted: (listener) =>
      ipcMain.on(ipc.framePainted, (event) => {
        if (event.sender === created.webContents) listener();
      }),
  });
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else window.loadFile(join(__dirname, '../renderer/index.html'));
  runInBackground(window, startCore(secrets));
});
