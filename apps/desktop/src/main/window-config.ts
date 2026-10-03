import type { WebPreferences } from 'electron';

// The renderer never touches Node, Sources, tokens or the database directly;
// everything goes through the preload bridge and validated messages.
export function windowWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
  };
}
