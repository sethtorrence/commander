import { join } from 'node:path';
import { parseCoreMessage } from '@commander/domain';
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { launchSwitches } from './launch-switches';
import { windowWebPreferences } from './window-config';

for (const [name, value] of launchSwitches(process.platform)) app.commandLine.appendSwitch(name, value);

let window: BrowserWindow | null = null;

function diagnostics() {
  const hint = app.commandLine.getSwitchValue('ozone-platform-hint');
  const platform = app.commandLine.getSwitchValue('ozone-platform');
  const wayland =
    platform === 'wayland' ||
    (platform === '' && ['auto', 'wayland'].includes(hint) && !!process.env.WAYLAND_DISPLAY);
  return {
    displayServer: process.platform === 'linux' ? (wayland ? 'wayland' : 'x11') : process.platform,
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
    window?.webContents.send('core-message', parsed.message);
  });
  return core;
}

app.whenReady().then(() => {
  ipcMain.handle('diagnostics', () => diagnostics());
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
