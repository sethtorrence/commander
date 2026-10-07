import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  attachmentScheme,
  type CoreMessage,
  type CoreStatus,
  type Diagnostics,
  ipc,
  parseCoreMessage,
} from '@commander/domain';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  protocol,
  shell,
  utilityProcess,
} from 'electron';
import { setUpAccounts } from './accounts/set-up-accounts';
import { attachmentSchemePrivileges, serveAttachment } from './attachments-protocol';
import { createAutonomyChannels } from './autonomy-channel';
import { claimSingleInstance, runInBackground, startsHidden } from './background';
import { createBackupsChannel } from './backups-channel';
import { createComposeChannel } from './compose-channel';
import { createConversationsChannel } from './conversations-channel';
import { createCoreSupervisor } from './core-supervisor';
import { displayServerFromHyprland, inferDisplayServer } from './display-server';
import { setUpEmailReader } from './email-reader';
import { emailReaderSchemePrivileges } from './email-reader/protocol';
import { keepLinksInBrowser } from './external-links';
import { createItemStoreChannel } from './item-store-channel';
import { launchSwitches } from './launch-switches';
import { createMarkdownCopyChannel } from './markdown-copy-channel';
import { createMeetingHeadsUp } from './meeting-heads-up';
import { setUpModels } from './models';
import { alwaysHere, watchPresence } from './presence';
import { revealWhenPainted } from './reveal';
import { setUpSecretStorage } from './secret-storage';
import type { Secrets } from './secrets';
import { focusThroughHyprland, summonWindow } from './summon';
import type { CommanderTray } from './tray';
import { createUpdatesChannel } from './updates-channel';
import { windowWebPreferences } from './window-config';
import {
  frameBehaviour,
  hyprlandCompositor,
  installWindowControls,
  windowFrameOptions,
} from './window-frame';

for (const [name, value] of launchSwitches(process.platform)) app.commandLine.appendSwitch(name, value);
// Pasted images reach the window through attachment://, and emails' HTML its sandboxed frames through
// commander-mail:// (email-reader/protocol.ts); both must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([attachmentSchemePrivileges, emailReaderSchemePrivileges]);
const primary = claimSingleInstance();

let window: BrowserWindow | null = null;

const hyprland = !!process.env.HYPRLAND_INSTANCE_SIGNATURE;

// Guessed from the launch switches and the session; readDisplayServer asks Hyprland when it can.
const inferredDisplayServer = () =>
  inferDisplayServer({
    platform: process.platform,
    ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
    ozoneHint: app.commandLine.getSwitchValue('ozone-platform-hint'),
    waylandDisplay: process.env.WAYLAND_DISPLAY,
  });

async function readDisplayServer(): Promise<Pick<Diagnostics, 'displayServer' | 'displaySource'>> {
  // The window may not be mapped yet when the renderer first asks, so give Hyprland a moment.
  for (let attempt = 0; hyprland && attempt < 10; attempt++) {
    try {
      const { stdout } = await promisify(execFile)('hyprctl', ['clients', '-j']);
      const server = displayServerFromHyprland(stdout, process.pid);
      if (server) return { displayServer: server, displaySource: 'compositor' };
    } catch {
      break; // hyprctl missing or failed: fall back to guessing.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { displayServer: inferredDisplayServer(), displaySource: 'inferred' };
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

// The tray shows Ares's quiet count of what he has queued (the Core's word may come before the tray).
let tray: CommanderTray | null = null;
let queued = 0;

// The end-to-end tests may shorten the waits before a new Core after the Core stops (comma-separated
// milliseconds, one per stop in a row), so a test can see Commander stop trying.
const testRestartDelays =
  testHooks && process.env.COMMANDER_TEST_CORE_RESTART_DELAYS_MS
    ? process.env.COMMANDER_TEST_CORE_RESTART_DELAYS_MS.split(',').map(Number)
    : null;

// The Core's arguments. It keeps the database in userData (which --user-data-dir overrides, e.g. in
// e2e tests).
function coreArgs(): string[] {
  return [
    `--data-dir=${app.getPath('userData')}`,
    ...(testHooks ? ['--test-hooks'] : []),
    // The end-to-end tests shorten Ares's pause after typing (the Core honours it only with test hooks).
    ...(testHooks && process.env.COMMANDER_TEST_ARES_PAUSE_MS
      ? [`--ares-typing-pause-ms=${process.env.COMMANDER_TEST_ARES_PAUSE_MS}`]
      : []),
    // And the hour the daily GitHub summary is due from (05:00 otherwise).
    ...(testHooks && process.env.COMMANDER_TEST_SUMMARY_HOUR
      ? [`--github-summary-hour=${process.env.COMMANDER_TEST_SUMMARY_HOUR}`]
      : []),
    // And whether the Monday roll-up is written too (tests that expect one summary turn it off).
    ...(testHooks && process.env.COMMANDER_TEST_SUMMARY_ROLLUP === 'off'
      ? ['--github-summary-rollup=off']
      : []),
    // The end-to-end tests may treat their fake model server (on this machine) as a cloud model, so
    // Conversations answer at once rather than taking turns.
    ...(testHooks && process.env.COMMANDER_TEST_MODEL_IN_CLOUD === '1' ? ['--test-model-in-cloud'] : []),
    // And where send later's clock starts (#139): moved on, as if Commander had been closed meanwhile.
    ...(testHooks && process.env.COMMANDER_TEST_SEND_LATER_OFFSET_MS
      ? [`--send-later-clock-offset-ms=${process.env.COMMANDER_TEST_SEND_LATER_OFFSET_MS}`]
      : []),
    // The end-to-end tests search by meaning with a stand-in model, so none of them ever downloads the
    // real one (#73). It can only make search by meaning worse, so it needs no test hooks.
    ...(process.env.COMMANDER_TEST_EMBEDDINGS === 'fake' ? ['--embeddings=fake'] : []),
  ];
}

// The window hears whether the Core is running (the banner), and, once a new one is, that it may ask
// again for what the old one would have pushed.
function tellWindow(status: CoreStatus) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(ipc.coreStatusChanged, status);
  if (status.state === 'running' && status.restarts > 0)
    window.webContents.send(ipc.coreMessage, {
      type: 'core-restarted',
      at: Date.now(),
    } satisfies CoreMessage);
}

function startCore(secrets: Secrets) {
  // The Core runs under a supervisor that starts a new one when it stops (#200). Every message to it
  // goes through `send` (dropped while there is none), and every window request through `relay`,
  // which fails at once while the Core is down rather than waiting out its time.
  let fromCore: (raw: unknown) => void = () => {};
  let coreRestarted = () => {};
  const supervisor = createCoreSupervisor({
    fork: () => utilityProcess.fork(join(__dirname, 'core.js'), coreArgs()),
    onMessage: (raw) => fromCore(raw),
    onStarted: (restarted) => {
      if (restarted) coreRestarted();
    },
    onStatus: tellWindow,
    ...(testRestartDelays ? { delaysMs: testRestartDelays } : {}),
  });
  supervisor.start();
  const send = (message: unknown) => void supervisor.send(message);
  const relay = <R>(run: () => Promise<R>) => supervisor.whileRunning(run);
  ipcMain.handle(ipc.coreStatus, () => supervisor.status());
  // The banner's Try again, once Commander has stopped starting the Core.
  ipcMain.handle(ipc.restartCore, () => supervisor.tryAgain());
  // Whatever stops once Commander is quitting stays stopped.
  app.on('before-quit', () => supervisor.quit());

  const itemStore = createItemStoreChannel(send);
  ipcMain.handle(ipc.itemStore, (_event, request: unknown) => relay(() => itemStore.request(request)));
  // The email reader (#134): emails' HTML in sandboxed frames, their images and attachments.
  const emailReader = window ? setUpEmailReader({ window, send, testHooks, whileCoreRuns: relay }) : null;
  const accounts = setUpAccounts({
    secrets,
    sendToCore: (message) => {
      // A removed Account's remote images and prepared emails go with it (the Core removes its
      // cached attachments and image rules).
      if (message.type === 'remove-account-items') emailReader?.forgetAccount(message.account);
      send(message);
    },
    testHooks,
    whileCoreRuns: relay,
  });
  const models = setUpModels(secrets, supervisor);
  const autonomy = createAutonomyChannels(send);
  ipcMain.handle(ipc.autonomy, (_event, request: unknown) => relay(() => autonomy.window.request(request)));
  const markdownCopy = createMarkdownCopyChannel({
    userData: app.getPath('userData'),
    send,
    // Read at call time, so the end-to-end tests can stand in for the system picker.
    async chooseFolder() {
      const options: Electron.OpenDialogOptions = {
        title: 'Markdown copy folder',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  ipcMain.handle(ipc.markdownCopy, (_event, request: unknown) => relay(() => markdownCopy.request(request)));
  // Settings → Data's snapshots, Restore and Export everything (#202). Restore relaunches Commander:
  // a clean quit (Quit's steps, so nothing held is lost and the Core's stop is no crash), and the
  // new Core restores before it opens the database. Both read at call time, so the end-to-end tests
  // can stand in for the picker and the relaunch.
  const backups = createBackupsChannel({
    userData: app.getPath('userData'),
    send,
    async chooseFolder() {
      const options: Electron.OpenDialogOptions = {
        title: 'Export everything to…',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    relaunch() {
      // Back in the window, even when this start was at login (hidden in the tray).
      app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--hidden') });
      app.quit();
    },
  });
  ipcMain.handle(ipc.backups, (_event, request: unknown) => relay(() => backups.request(request)));
  // Ares's Updates: the window asks (`U`, the header button, the palette), the Core answers.
  const updates = createUpdatesChannel(send);
  ipcMain.handle(ipc.updates, (_event, request: unknown) => relay(() => updates.request(request)));
  // Writing email (#138): the window's composer, answered by the Core.
  const compose = createComposeChannel(send);
  ipcMain.handle(ipc.compose, (_event, request: unknown) => relay(() => compose.request(request)));
  // Conversations with Ares (#191): the window asks, the Core answers; his answers stream as core
  // messages.
  const conversations = createConversationsChannel(send);
  ipcMain.handle(ipc.conversations, (_event, request: unknown) =>
    relay(() => conversations.request(request)),
  );
  // Whether the User is at the machine, from powerMonitor, for "You're here / away" and having the
  // Update ready on return.
  // The end-to-end tests stand in for powerMonitor (their input never reaches the system).
  const monitor = process.env.COMMANDER_TEST_PRESENCE === 'here' ? alwaysHere : powerMonitor;
  // The opt-in heads-up 2 minutes before a meeting (the Core decides when): a system notification
  // that opens the event. The end-to-end tests only note it, never showing one on the desktop.
  const headsUp = createMeetingHeadsUp({
    notify: (options) => {
      if (testHooks) return { on: () => {}, show: () => {} };
      return Notification.isSupported() ? new Notification(options) : null;
    },
    open: (itemId) => {
      if (!window || window.isDestroyed()) return;
      summonWindow(window);
      focusThroughHyprland();
      window.webContents.send(ipc.openItem, { sectionId: 'calendar', itemId });
    },
  });
  const watch = () => watchPresence({ monitor, send });
  let stopPresence = watch();
  app.on('will-quit', () => stopPresence());
  // A new Core hears the Accounts to sync, the machine's state and the User's presence again (it
  // reads everything else from the database).
  coreRestarted = () => {
    accounts.coreRestarted();
    stopPresence();
    stopPresence = watch();
  };
  if (testHooks) {
    Object.assign(globalThis, {
      commanderTestHooks: {
        autonomy: autonomy.test.request,
        setOnline: accounts.setOnline,
        saveGitHubItems: accounts.saveGitHubItems,
        meetingHeadsUps: headsUp.shown,
        clickMeetingHeadsUp: headsUp.click,
        // The email reader: what the window's session saw, and email Items to save as a Source would.
        emailRequests: () => emailReader?.seenRequests() ?? [],
        prepareUnsanitisedEmail: (html: string) => emailReader?.prepareUnsanitisedForTest(html) ?? null,
        saveEmailItems: (source: string, account: string, items: unknown[]) =>
          send({ type: 'email-test-items', source, account, items }),
        // Moves the Core's snooze clock on (#135), so snoozed mail comes back without waiting.
        moveSnoozeClock: (offsetMs: number) => send({ type: 'snooze-test-clock', offsetMs }),
        // Moves send later's clock on (#139), so a scheduled message's time comes without waiting.
        moveSendLaterClock: (offsetMs: number) => send({ type: 'send-later-test-clock', offsetMs }),
        // The running Core's process id, so a test can stop it as a crash would (#200).
        corePid: () => supervisor.pid(),
      },
    });
  }
  fromCore = (raw: unknown) => {
    if (itemStore.settle(raw) || autonomy.window.settle(raw) || autonomy.test.settle(raw)) return;
    if (markdownCopy.settle(raw) || backups.settle(raw) || updates.settle(raw) || compose.settle(raw)) return;
    if (conversations.settle(raw)) return;
    if (emailReader?.settle(raw)) return;
    // Before Accounts: it answers the Core's token requests for model API keys.
    if (models(raw)) return;
    if (accounts.fromCore(raw)) return;
    const parsed = parseCoreMessage(raw);
    if (!parsed.ok) {
      console.warn('Rejected malformed message from core:', parsed.error);
      return;
    }
    if (headsUp.handle(parsed.message)) return;
    if (parsed.message.type === 'ares-updates') {
      queued = parsed.message.queued;
      tray?.setQueued(queued);
    }
    window?.webContents.send(ipc.coreMessage, parsed.message);
  };
  return { core: supervisor, sendHeld: () => compose.sendHeld() };
}

app.whenReady().then(() => {
  if (!primary) return;
  ipcMain.handle(ipc.diagnostics, () => diagnostics());
  const secrets = setUpSecretStorage();
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Commander',
    // No Electron or system frame: the header is the title bar and holds the window controls.
    ...windowFrameOptions(process.platform),
    // Hidden until the first frame is painted in the User's theme (see reveal.ts); this colour
    // only shows while resizing.
    backgroundColor: '#141516',
    show: false,
    webPreferences: windowWebPreferences(join(__dirname, '../preload/index.cjs')),
  });
  const created = window;
  installWindowControls({
    window: created,
    ipc: ipcMain,
    behaviour: frameBehaviour({
      platform: process.platform,
      displayServer: inferredDisplayServer(),
      hyprland,
    }),
    compositor: hyprlandCompositor(process.pid),
  });
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
  const started = startCore(secrets);
  // Quitting sends the messages held for Undo first (#138).
  tray = runInBackground(window, started.core, { sendHeld: started.sendHeld });
  tray.setQueued(queued);
  if (testHooks) {
    // The tray's menu, for the end-to-end tests: its labels, and choosing one.
    const menu = (tray as CommanderTray).menu;
    Object.assign((globalThis as { commanderTestHooks?: object }).commanderTestHooks ?? {}, {
      trayLabels: () => menu().map((item) => item.label ?? null),
      clickTray: (label: string) =>
        (menu().find((item) => item.label === label)?.click as (() => void) | undefined)?.(),
    });
  }
});
