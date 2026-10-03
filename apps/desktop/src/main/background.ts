import { homedir } from 'node:os';
import { ipc } from '@commander/domain';
import { app, type BrowserWindow, ipcMain, type Tray, type UtilityProcess } from 'electron';
import { autostartPath, isAutostartEnabled, launchAtLoginCommand, setAutostart } from './autostart';
import { keepInTray, stopCoreOnQuit } from './lifecycle';
import { ownPidRecord, pidFilePath, removePidFile, writePidFile } from './pid-file';
import { askWindowToSave } from './save-before-quit';
import { DESKTOP_ENTRY, focusThroughHyprland, installSummon, summonWindow } from './summon';
import { createTray } from './tray';

// Wires Commander's always-there behaviour into Electron: one instance, the window class
// Hyprland binds and focuses by, close to tray, the tray itself, summoning (commander-show and
// second launches), quitting that stops the Core, and the "Start at login" setting.

// Call before the app is ready. Returns false in a second instance, which quits at once and
// leaves the running one to show itself (the 'second-instance' event, in installSummon).
export function claimSingleInstance(): boolean {
  // The window's class (Wayland app_id) becomes "commander", without renaming userData.
  app.setDesktopName(DESKTOP_ENTRY);
  if (app.requestSingleInstanceLock()) return true;
  app.exit(0);
  return false;
}

// Started at login, Commander waits in the tray.
export const startsHidden = (argv: string[]) => argv.includes('--hidden');

let tray: Tray | null = null; // Held so the tray icon isn't garbage-collected.

export function runInBackground(window: BrowserWindow, core: UtilityProcess): void {
  keepInTray(window, app);
  const saving = askWindowToSave({
    send: (channel, id) => window.webContents.send(channel, id),
    isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
  });
  ipcMain.on(ipc.savedBeforeQuit, (event, id: unknown) => {
    if (event.sender === window.webContents) saving.settle(id);
  });
  stopCoreOnQuit(app, core, { beforeStop: saving.request });

  const open = () => {
    summonWindow(window);
    focusThroughHyprland();
  };
  tray = createTray({ onOpen: open, onQuit: () => app.quit() });
  app.on('will-quit', () => tray?.destroy());
  installSummon({
    app,
    signals: process,
    getWindow: () => window,
    focusThroughCompositor: focusThroughHyprland,
  });

  const record = ownPidRecord();
  if (record) {
    const path = pidFilePath({
      env: process.env,
      uid: process.getuid?.() ?? 0,
      customUserDataDir: app.commandLine.hasSwitch('user-data-dir') ? app.getPath('userData') : undefined,
    });
    writePidFile(path, record);
    app.on('will-quit', () => removePidFile(path, record));
  }

  registerStartAtLogin();
}

function registerStartAtLogin(): void {
  const path = autostartPath(process.env, homedir());
  const command = launchAtLoginCommand({
    execPath: process.execPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  });
  const linux = process.platform === 'linux';
  ipcMain.handle(ipc.startAtLogin, () =>
    linux ? isAutostartEnabled(path) : app.getLoginItemSettings().openAtLogin,
  );
  ipcMain.handle(ipc.setStartAtLogin, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Start at login must be on or off');
    if (linux) setAutostart(path, enabled, command);
    else app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return enabled;
  });
}
