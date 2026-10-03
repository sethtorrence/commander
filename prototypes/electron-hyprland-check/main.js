// PROTOTYPE, throwaway. Answers "Check Electron on Hyprland: tray, shortcuts, email sandbox, token storage"
// (https://github.com/sethtorrence/commander/issues/26). Writes report.json next to this file on quit.
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, safeStorage, utilityProcess, ipcMain, session, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const state = {
  env: { session: process.env.XDG_SESSION_TYPE, desktop: process.env.XDG_CURRENT_DESKTOP, electron: process.versions.electron, chrome: process.versions.chrome },
  ozonePlatform: null, tray: {}, worker: { beats: 0, aliveWhileHidden: null }, shortcut: {}, safeStorage: {}, emailSandbox: {}, display: {}, manual: {},
};
let win, tray, worker, hiddenAt = null, beatsWhenHidden = 0, quitting = false;
const push = () => win && !win.isDestroyed() && win.webContents.send('state', state);
const save = () => fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(state, null, 2));

function trayIcon() {
  // 22x22 international-orange square, drawn in code (no asset files).
  const size = 22, buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) { const x = i % size, y = Math.floor(i / size); const edge = x < 2 || y < 2 || x > 19 || y > 19;
    buf.set(edge ? [20, 20, 20, 255] : [0, 95, 255, 255], i * 4); } // BGRA: orange FF5F00
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, title: 'PROTOTYPE · Commander on Hyprland check', backgroundColor: '#1B1C1E',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile('index.html');
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide(); hiddenAt = Date.now(); beatsWhenHidden = state.worker.beats;
    state.tray.closeHidesToTray = true; push(); save();
  });
  win.on('show', () => {
    if (hiddenAt) { state.worker.aliveWhileHidden = state.worker.beats > beatsWhenHidden; state.worker.secondsHidden = Math.round((Date.now() - hiddenAt) / 1000); hiddenAt = null; }
    push();
  });
  win.webContents.on('did-finish-load', push);
}

app.whenReady().then(async () => {
  state.ozonePlatform = app.commandLine.getSwitchValue('ozone-platform') || app.commandLine.getSwitchValue('ozone-platform-hint') || '(default)';

  // 1. Tray + background utilityProcess
  try {
    tray = new Tray(trayIcon()); tray.setToolTip('Commander check (prototype)');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open window', click: () => { win.show(); state.tray.menuOpenWorked = true; push(); } },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { win.show(); state.tray.clickOpenedWindow = true; push(); });
    state.tray.created = true;
  } catch (e) { state.tray.created = false; state.tray.error = String(e); }
  worker = utilityProcess.fork(path.join(__dirname, 'worker.js'));
  worker.on('message', (m) => { if (m.type === 'beat') { state.worker.beats = m.beats; if (state.worker.beats % 5 === 0) push(); } });

  // 2. Global shortcut (through the XDG GlobalShortcuts portal on Wayland)
  const accel = 'CommandOrControl+Shift+Space';
  try {
    const ok = globalShortcut.register(accel, () => { state.shortcut.fired = (state.shortcut.fired || 0) + 1; win.show(); win.focus(); push(); });
    state.shortcut = { accelerator: accel, registered: ok, fired: 0 };
  } catch (e) { state.shortcut = { accelerator: accel, registered: false, error: String(e) }; }

  // 3. safeStorage
  try {
    state.safeStorage.available = safeStorage.isEncryptionAvailable();
    state.safeStorage.backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'n/a';
    const enc = safeStorage.encryptString('commander-test-token');
    state.safeStorage.roundTrip = safeStorage.decryptString(enc) === 'commander-test-token';
    state.safeStorage.realKeyring = !['basic_text', 'unknown'].includes(state.safeStorage.backend);
  } catch (e) { state.safeStorage.error = String(e); }

  // 4. Email sandbox: block every remote request from the sandbox frame; log what was attempted.
  const blocked = []; state.emailSandbox.remoteRequestsReachedNetwork = 0;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    if (details.url.includes('tracker.invalid')) { blocked.push(details.url); state.emailSandbox.remoteRequestsReachedNetwork = blocked.length; push(); cb({ cancel: true }); return; }
    cb({});
  });

  // 5. Display facts
  const d = screen.getPrimaryDisplay();
  state.display = { scaleFactor: d.scaleFactor, size: d.size, workArea: d.workArea };

  createWindow();
  ipcMain.on('manual', (_e, k, v) => { state.manual[k] = v; save(); push(); });
  ipcMain.on('report', (_e, k, v) => { state.emailSandbox[k] = v; save(); push(); });
  save();
});

app.on('before-quit', () => { quitting = true; save(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
