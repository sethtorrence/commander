// When Commander quits, the window may still hold edits it hasn't sent (a Daily Note saves typing
// after a pause). Before the Core stops, main asks the window to save them and waits for its answer;
// stopCoreOnQuit (lifecycle.ts) bounds the wait.
import { ipc } from '@commander/domain/ipc';

type SaveableWindow = { send(channel: string, id: number): void; isDestroyed(): boolean };

export function askWindowToSave(window: SaveableWindow) {
  let nextId = 1;
  const waiting = new Map<number, () => void>();
  return {
    // Resolves once the window says everything it held is saved.
    request(): Promise<void> {
      if (window.isDestroyed()) return Promise.resolve();
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        window.send(ipc.saveBeforeQuit, id);
      });
    },
    // The window's answer to request `id`.
    settle(id: unknown) {
      if (typeof id !== 'number') return;
      waiting.get(id)?.();
      waiting.delete(id);
    },
  };
}
