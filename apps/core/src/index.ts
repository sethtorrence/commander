// The Core: syncs Sources, holds the Items and runs the Agent. It runs as an Electron
// utilityProcess and talks to the main process only through validated CoreMessages.
import type { CoreMessage } from '@commander/domain';

const port = process.parentPort;
let beats = 0;

setInterval(() => {
  beats += 1;
  const message: CoreMessage = { type: 'heartbeat', beats, at: Date.now() };
  port.postMessage(message);
}, 1000);
