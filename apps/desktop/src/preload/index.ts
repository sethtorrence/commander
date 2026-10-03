import type {
  CoreMessage,
  ItemStoreRequest,
  ItemStoreResponse,
  ItemStoreResults,
  ModelProvider,
  ModelsRequest,
  ModelsResponse,
} from '@commander/domain';
// The ipc subpath keeps zod (and the schemas) out of the sandboxed preload bundle.
import {
  type AccountsRequest,
  type AccountsResponse,
  type AccountsState,
  type Diagnostics,
  ipc,
  type ModelKeyStatus,
  type SaveModelKeyResult,
  type SecretStorageStatus,
} from '@commander/domain/ipc';
import { contextBridge, ipcRenderer } from 'electron';

// What the window must save before Commander quits (see onSaveBeforeQuit).
const savers = new Set<() => Promise<void>>();
ipcRenderer.on(ipc.saveBeforeQuit, async (_event, id: number) => {
  await Promise.allSettled([...savers].map((save) => save()));
  ipcRenderer.send(ipc.savedBeforeQuit, id);
});

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
  // Settings → Ares, answered by the Core. Resolves with the response, failures included, so the
  // window can tell an over-cap or refused-key failure apart.
  models: <R extends ModelsRequest>(request: R): Promise<ModelsResponse<R['op']>> =>
    ipcRenderer.invoke(ipc.models, request),
  // A model provider's API key goes to the main process (and the keyring) only; it is never read back.
  modelKeyStatus: (provider: ModelProvider): Promise<ModelKeyStatus> =>
    ipcRenderer.invoke(ipc.modelKeyStatus, provider),
  saveModelKey: (provider: ModelProvider, key: string): Promise<SaveModelKeyResult> =>
    ipcRenderer.invoke(ipc.saveModelKey, provider, key),
  clearModelKey: (provider: ModelProvider): Promise<void> => ipcRenderer.invoke(ipc.clearModelKey, provider),
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
  // Runs `save` when Commander quits, before the Core stops, so edits held back (typing saved after a
  // pause) reach the Item store. Returns the function that stops it.
  onSaveBeforeQuit(save: () => Promise<void>) {
    savers.add(save);
    return () => {
      savers.delete(save);
    };
  },
  // Tells the app the first frame is on screen (in the saved theme), so the window can be shown.
  framePainted: (): void => ipcRenderer.send(ipc.framePainted),
};

export type CommanderBridge = typeof commander;
contextBridge.exposeInMainWorld('commander', commander);
