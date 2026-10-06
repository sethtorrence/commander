import { homedir } from 'node:os';
import { ipc } from '@commander/domain';
import { app, type BrowserWindow, ipcMain } from 'electron';
import { autostartPath, isAutostartEnabled, launchAtLoginCommand, setAutostart } from './autostart';
import { inTurn, keepInTray, type StoppableCore, stopCoreOnQuit } from './lifecycle';
import { ownPidRecord, pidFilePath, removePidFile, writePidFile } from './pid-file';
import { askWindowToSave } from './save-before-quit';
import { DESKTOP_ENTRY, focusThroughHyprland, installSummon, summonWindow } from './summon';
import { type CommanderTray, createTray } from './tray';

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

let tray: CommanderTray | null = null; // Held so the tray icon isn't garbage-collected.

// How long quitting waits for the window to save what it holds, then for messages held for Undo to go.
const SAVE_BEFORE_QUIT_MS = 2_000;
const SEND_HELD_BEFORE_QUIT_MS = 15_000;

// Returns the tray, for Ares's quiet count of what he has queued. `sendHeld`: asks the Core to send the
// messages held for Undo (#138) before it stops.
export function runInBackground(
  window: BrowserWindow,
  core: StoppableCore,
  { sendHeld }: { sendHeld?: () => Promise<void> } = {},
): CommanderTray {
  keepInTray(window, app);
  const saving = askWindowToSave({
    send: (channel, id) => window.webContents.send(channel, id),
    isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
  });
  ipcMain.on(ipc.savedBeforeQuit, (event, id: unknown) => {
    if (event.sender === window.webContents) saving.settle(id);
  });
  // The window saves first (a draft it was holding is among what it saves), then held messages go.
  const beforeStop = inTurn([
    { run: saving.request, timeoutMs: SAVE_BEFORE_QUIT_MS },
    ...(sendHeld ? [{ run: sendHeld, timeoutMs: SEND_HELD_BEFORE_QUIT_MS }] : []),
  ]);
  stopCoreOnQuit(app, core, {
    beforeStop,
    beforeStopTimeoutMs: SAVE_BEFORE_QUIT_MS + (sendHeld ? SEND_HELD_BEFORE_QUIT_MS : 0) + 500,
  });

  const open = () => {
    summonWindow(window);
    focusThroughHyprland();
  };
  tray = createTray({
    onOpen: open,
    // The window opens and runs the Update Skill, as `U` would.
    onAskForUpdate: () => {
      open();
      window.webContents.send(ipc.askForUpdate);
    },
    onQuit: () => app.quit(),
  });
  const shown = tray;
  app.on('will-quit', () => shown.tray.destroy());
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
  return shown;
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
