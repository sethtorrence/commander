import { describe, expect, it } from 'vitest';
import { windowWebPreferences } from './window-config';

describe('windowWebPreferences', () => {
  it('isolates the renderer from Node: context isolation and sandbox on, node integration off', () => {
    const prefs = windowWebPreferences('/app/out/preload/index.js');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.webviewTag).toBe(false);
  });

  it('loads the given preload script, the only bridge between the renderer and the app', () => {
    expect(windowWebPreferences('/app/out/preload/index.js').preload).toBe('/app/out/preload/index.js');
  });
});
