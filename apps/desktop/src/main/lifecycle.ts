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

// Runs each step in turn, giving each no more than its own time: one that hangs never stops the next.
export function inTurn(
  steps: readonly { run: () => Promise<void>; timeoutMs: number }[],
): () => Promise<void> {
  return async () => {
    for (const step of steps) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tooLong = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, step.timeoutMs);
      });
      await Promise.race([step.run().catch(() => {}), tooLong]);
      clearTimeout(timer);
    }
  };
}

export type StoppableCore = {
  // Whether there is a Core to stop: none while one that stopped waits to start again (#200).
  running(): boolean;
  on(event: 'exit', listener: () => void): unknown;
  // Stops it for good: no new Core starts after this.
  kill(): boolean;
};

// Quit waits for the Core to exit (it gets SIGTERM, so it can finish what it is writing),
// but never longer than timeoutMs. First, `beforeStop` gets up to beforeStopTimeoutMs to finish
// with the Core while it still runs: the window saves the edits it is holding. With no Core running
// (one stopped, and the next isn't up yet), Commander quits straight away.
export function stopCoreOnQuit(
  app: QuittableApp,
  core: StoppableCore,
  {
    timeoutMs = 3000,
    beforeStop,
    beforeStopTimeoutMs = 2000,
  }: { timeoutMs?: number; beforeStop?: () => Promise<void>; beforeStopTimeoutMs?: number } = {},
): void {
  let state: 'running' | 'stopping' | 'stopped' = 'running';
  let finish = () => {};
  core.on('exit', () => finish());
  app.on('before-quit', (event) => {
    if (state === 'stopped') return;
    if (state === 'running' && !core.running()) {
      state = 'stopped';
      return;
    }
    event.preventDefault();
    if (state === 'stopping') return;
    state = 'stopping';
    const stop = () => {
      // The Core may have exited by itself in the meantime.
      if (!core.running()) {
        state = 'stopped';
        return app.quit();
      }
      const timer = setTimeout(() => finish(), timeoutMs);
      finish = () => {
        finish = () => {};
        clearTimeout(timer);
        state = 'stopped';
        app.quit();
      };
      core.kill();
    };
    if (!beforeStop) return stop();
    let waited: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<void>((resolve) => {
      waited = setTimeout(resolve, beforeStopTimeoutMs);
    });
    Promise.race([beforeStop().catch(() => {}), tooLong]).then(() => {
      clearTimeout(waited);
      stop();
    });
  });
}
