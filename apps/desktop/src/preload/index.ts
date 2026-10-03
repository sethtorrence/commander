import type { CoreMessage, ItemStoreRequest, ItemStoreResponse, ItemStoreResults } from '@commander/domain';
// The ipc subpath keeps zod (and the schemas) out of the sandboxed preload bundle.
import {
  type AccountsRequest,
  type AccountsResponse,
  type AccountsState,
  type Diagnostics,
  ipc,
  type SecretStorageStatus,
} from '@commander/domain/ipc';
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
  startAtLogin: (): Promise<boolean> => ipcRenderer.invoke(ipc.startAtLogin),
  setStartAtLogin: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(ipc.setStartAtLogin, enabled),
  // Settings → Accounts. Answers carry Account summaries, never a token or key.
  accounts: (request: AccountsRequest): Promise<AccountsResponse> =>
    ipcRenderer.invoke(ipc.accounts, request),
  onAccountsChanged(listener: (state: AccountsState) => void) {
    const handler = (_event: unknown, state: AccountsState) => listener(state);
    ipcRenderer.on(ipc.accountsChanged, handler);
    return () => {
      ipcRenderer.off(ipc.accountsChanged, handler);
    };
  },
  // Tells the app the first frame is on screen (in the saved theme), so the window can be shown.
  framePainted: (): void => ipcRenderer.send(ipc.framePainted),
};

export type CommanderBridge = typeof commander;
contextBridge.exposeInMainWorld('commander', commander);
