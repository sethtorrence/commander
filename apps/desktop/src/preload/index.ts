import type { CoreMessage, ItemStoreRequest, ItemStoreResponse, ItemStoreResults } from '@commander/domain';
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
  // The window's only way to read or change Items. Rejects with the reason when the request fails.
  async itemStore<R extends ItemStoreRequest>(request: R): Promise<ItemStoreResults[R['op']]> {
    const response: ItemStoreResponse<R['op']> = await ipcRenderer.invoke(ipc.itemStore, request);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
};

export type CommanderBridge = typeof commander;
contextBridge.exposeInMainWorld('commander', commander);
