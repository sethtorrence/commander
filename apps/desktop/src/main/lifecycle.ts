// Commander is always there: closing the window hides it to the tray and the Core keeps
// running. Only quitting (tray menu, or app.quit() from anywhere) closes the window and
// stops the Core.

type Cancellable = { preventDefault(): void };
type QuittableApp = {
  on(event: 'before-quit', listener: (event: Cancellable) => void): unknown;
  quit(): void;
};

type HideableWindow = {
  on(event: 'close', listener: (event: Cancellable) => void): unknown;
  hide(): void;
};

export function keepInTray(window: HideableWindow, app: QuittableApp): void {
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
}

type StoppableCore = {
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
};

// Quit waits for the Core to exit (it gets SIGTERM, so it can finish what it is writing),
// but never longer than timeoutMs.
export function stopCoreOnQuit(app: QuittableApp, core: StoppableCore, { timeoutMs = 3000 } = {}): void {
  let state: 'running' | 'stopping' | 'stopped' = 'running';
  let finish = () => {};
  core.on('exit', () => {
    state = 'stopped';
    finish();
  });
  app.on('before-quit', (event) => {
    if (state === 'stopped') return;
    event.preventDefault();
    if (state === 'stopping') return;
    state = 'stopping';
    const timer = setTimeout(() => {
      state = 'stopped';
      finish();
    }, timeoutMs);
    finish = () => {
      finish = () => {};
      clearTimeout(timer);
      app.quit();
    };
    core.kill();
  });
}
