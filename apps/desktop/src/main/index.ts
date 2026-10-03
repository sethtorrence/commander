import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Diagnostics, ipc, parseCoreMessage } from '@commander/domain';
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { displayServerFromHyprland, inferDisplayServer } from './display-server';
import { launchSwitches } from './launch-switches';
import { windowWebPreferences } from './window-config';

for (const [name, value] of launchSwitches(process.platform)) app.commandLine.appendSwitch(name, value);

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

function startCore() {
  const core = utilityProcess.fork(join(__dirname, 'core.js'));
  core.on('message', (raw: unknown) => {
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
  ipcMain.handle(ipc.diagnostics, () => diagnostics());
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Commander',
    backgroundColor: '#141516',
    webPreferences: windowWebPreferences(join(__dirname, '../preload/index.cjs')),
  });
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else window.loadFile(join(__dirname, '../renderer/index.html'));
  startCore();
});

app.on('window-all-closed', () => app.quit());
