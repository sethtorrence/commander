// The Core: syncs Sources, holds the Items and runs the Agent. It runs as an Electron
// utilityProcess and talks to the main process only through validated messages.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreMessage } from '@commander/domain';
import { createAccessTokens } from './access-tokens';
import { answerRemoveAccountItems } from './account-requests';
import { openItemStore } from './item-store';
import { answerItemStoreRequest } from './item-store-requests';
import { setUpModels } from './models';
import { setUpSync } from './sync';

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
const accessTokens = createAccessTokens((message) => port.postMessage(message));
// Model calls for Ares; the API key is borrowed the same way, for each call.
const models = setUpModels(itemStore, { send: (message) => port.postMessage(message), accessTokens });
// Source sync: every Account on its cadence, writing through the Item store.
const sync = setUpSync(itemStore, { send: (message) => port.postMessage(message), accessTokens });

port.on('message', ({ data }) => {
  if (accessTokens.settle(data)) return;
  if (models.handle(data)) return;
  if (sync.handle(data)) return;
  const reply =
    answerRemoveAccountItems(itemStore, data, sync.forget) ?? answerItemStoreRequest(itemStore, data);
  if (reply) port.postMessage(reply);
});

// Closing the last connection checkpoints the WAL into commander.db.
let closed = false;
const closeStore = () => {
  if (closed) return;
  closed = true;
  sync.stop();
  itemStore.close();
};
process.on('exit', closeStore);
// Quit stops the Core with SIGTERM (utilityProcess.kill()), which would otherwise end the
// process without running 'exit' handlers.
process.on('SIGTERM', () => {
  closeStore();
  process.exit(0);
});
