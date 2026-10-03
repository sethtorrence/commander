import type { CoreMessage } from '@commander/domain';
import { contextBridge, ipcRenderer } from 'electron';

export type Diagnostics = { displayServer: string; passwordStore: string; electron: string };

// The only bridge between the renderer and the app.
const commander = {
  onCoreMessage(listener: (message: CoreMessage) => void) {
    const handler = (_event: unknown, message: CoreMessage) => listener(message);
    ipcRenderer.on('core-message', handler);
    return () => {
      ipcRenderer.off('core-message', handler);
    };
  },
  diagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke('diagnostics'),
};

export type CommanderBridge = typeof commander;
contextBridge.exposeInMainWorld('commander', commander);
