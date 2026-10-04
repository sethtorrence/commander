// The Core: syncs Sources, holds the Items and runs the Agent. It runs as an Electron
// utilityProcess and talks to the main process only through validated messages.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreMessage } from '@commander/domain';
import { createAccessTokens } from './access-tokens';
import { answerRemoveAccountItems } from './account-requests';
import { setUpAgent } from './agent';
import { openGate } from './autonomy/gate';
import { answerAutonomyRequest } from './autonomy/requests';
import { openItemStore } from './item-store';
import { answerItemStoreRequest } from './item-store-requests';
import { setUpMarkdownCopy } from './markdown-copy';
import { setUpModels } from './models';
import { createKnownSecrets } from './safety/known-secrets';
import { setUpSync } from './sync';
import { setUpUpdates, type Updates } from './updates';

const port = process.parentPort;
let beats = 0;

setInterval(() => {
  beats += 1;
  const message: CoreMessage = { type: 'heartbeat', beats, at: Date.now() };
  port.postMessage(message);
}, 1000);

// The main process passes the app's data folder; the Core never touches Electron main-process APIs.
const dataDir = process.argv.find((arg) => arg.startsWith('--data-dir='))?.slice('--data-dir='.length);
if (!dataDir) throw new Error('The Core needs --data-dir=<folder> to know where the database lives');
mkdirSync(dataDir, { recursive: true });

const itemStore = openItemStore({
  path: join(dataDir, 'commander.db'),
  snapshotDir: join(dataDir, 'snapshots'),
  // Copied next to the bundled Core at build time (see electron.vite.config.ts).
  migrationsFolder: join(import.meta.dirname, 'migrations'),
});

// The daily snapshot: taken at start-up, then checked hourly so a Commander left running still gets one.
itemStore.takeDailySnapshot();
setInterval(() => itemStore.takeDailySnapshot(), 60 * 60 * 1000);

// Sources borrow their Accounts' access tokens from the main process through this, in memory only.
// Each one is remembered by fingerprint, so no prompt to a model can carry it (agent/prompt.ts).
const secrets = createKnownSecrets();
const accessTokens = createAccessTokens((message) => port.postMessage(message), { secrets });
// Model calls for Ares; the API key is borrowed the same way, for each call.
const models = setUpModels(itemStore, {
  send: (message) => port.postMessage(message),
  accessTokens,
  secrets,
});
// Source sync: every Account on its cadence, writing through the Item store.
const sync = setUpSync(itemStore, { send: (message) => port.postMessage(message), accessTokens });
// The read-only Markdown copy of the Daily Notes, in the folder chosen in Settings → Notes.
const markdownCopy = setUpMarkdownCopy({
  store: itemStore,
  dataDir,
  attachmentsDir: join(dataDir, 'attachments'),
  send: (message) => port.postMessage(message),
});
markdownCopy.start();
// What a sync changed (new Linear Todos among it) shows at once in open views.
sync.engine.onSynced(({ itemIds }) => {
  if (itemIds.length) port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage);
  // A Linear-backed Todo ticked in Linear ticks its Block's checkbox in the copy.
  markdownCopy.itemsChanged(itemIds);
});

// The gate every Ares action goes through. Test hooks (proposing from end-to-end tests) are on only
// when the main process asks for them.
const testHooks = process.argv.includes('--test-hooks');
// Ares's Updates (set up below, once the Agent is): their producers look again whenever the gate acts.
let updates: Updates | undefined;
const gate = openGate({
  itemStore,
  onChange: (itemIds) => {
    port.postMessage({ type: 'ares-activity', at: Date.now() } satisfies CoreMessage);
    // What Ares added (or the User accepted, or undid) shows in every open Section.
    if (itemIds.length) port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage);
    // And in the Markdown copy: an Ares Todo puts a checkbox on its Block there too.
    markdownCopy.itemsChanged(itemIds);
    // A suggested (or added) Todo is ranked on the Dashboard.
    agent.aresChanged();
    updates?.sweep();
  },
});

// Ares's jobs, on their triggers. The end-to-end tests may shorten the pause after typing.
const typingPauseMs = Number(
  process.argv.find((arg) => arg.startsWith('--ares-typing-pause-ms='))?.split('=')[1] ?? Number.NaN,
);
const agent = setUpAgent(itemStore, {
  gate,
  client: models.client,
  send: (message) => port.postMessage(message),
  typingPauseMs: testHooks && Number.isFinite(typingPauseMs) ? typingPauseMs : undefined,
  secrets,
  // A steering warning mark shows at once in open views.
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
});
sync.engine.onSynced((event) => agent.synced(event));

// Ares's queue and the Update Skill. The main process reports the User's presence (powerMonitor);
// the queued count and "You're here / away" go to the window as they change, and the machine going
// idle is the Agent's cue for its catch-up work. Nothing here ever draws the User's attention.
updates = setUpUpdates({
  itemStore,
  gate,
  client: models.client,
  secrets,
  send: (message) => port.postMessage(message),
  onState: (state) => port.postMessage({ type: 'ares-updates', ...state } satisfies CoreMessage),
  onIdle: () => agent.idle(),
  onItemsChanged: (itemIds) => port.postMessage({ type: 'items-changed', itemIds } satisfies CoreMessage),
});
// Injection warnings arrive with a sync.
sync.engine.onSynced(() => updates?.sweep());

port.on('message', ({ data }) => {
  if (accessTokens.settle(data)) return;
  if (models.handle(data)) return;
  if (sync.handle(data)) return;
  if (markdownCopy.handle(data)) return;
  if (updates?.handle(data)) return;
  let changed: CoreMessage | null = null;
  let changedIds: string[] = [];
  const reply =
    answerRemoveAccountItems(itemStore, data, sync.forget) ??
    answerItemStoreRequest(itemStore, data, (itemIds) => {
      changed = { type: 'items-changed', itemIds };
      changedIds = itemIds;
      // The window's changes are the User's: typing in a Daily Note, say.
      agent.userChanged(itemIds);
    }) ??
    answerAutonomyRequest(gate, data, { testHooks, jobs: agent.runner });
  if (reply) port.postMessage(reply);
  // After the reply, so the window that made the change has its answer first.
  if (changed) port.postMessage(changed);
  // The Markdown copy writes the days the change touched, a moment later.
  if (reply?.type === 'item-store-reply') {
    markdownCopy.itemsChanged(changedIds);
    markdownCopy.afterRequest((data as { request?: unknown }).request);
  }
});

// Closing the last connection checkpoints the WAL into commander.db.
let closed = false;
const closeStore = () => {
  if (closed) return;
  closed = true;
  agent.stop();
  updates?.stop();
  sync.stop();
  markdownCopy.stop();
  itemStore.close();
};
process.on('exit', closeStore);
// Quit stops the Core with SIGTERM (utilityProcess.kill()), which would otherwise end the
// process without running 'exit' handlers.
process.on('SIGTERM', () => {
  closeStore();
  process.exit(0);
});
