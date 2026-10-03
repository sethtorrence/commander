import type { CoreMessage } from '@commander/domain';
// The ipc subpath keeps zod (and the schemas) out of the sandboxed preload bundle.
import { type Diagnostics, ipc, type SecretStorageStatus } from '@commander/domain/ipc';
import { contextBridge, ipcRenderer } from 'electron';

// The only bridge between the renderer and the app.
const commander = {
  onCoreMessage(listener: (message: CoreMessage) => void) {
    const handler = (_event: unknown, message: CoreMessage) => listener(message);
    ipcRenderer.on(ipc.coreMessage, handler);
    return () => {
      ipcRenderer.off(ipc.coreMessage, handler);
    };
  },
  diagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(ipc.diagnostics),
  // Only the status of secret storage crosses to the window; secrets themselves never do.
  secretStorageStatus: (): Promise<SecretStorageStatus> => ipcRenderer.invoke(ipc.secretStorageStatus),
};

export type CommanderBridge = typeof commander;
contextBridge.exposeInMainWorld('commander', commander);
