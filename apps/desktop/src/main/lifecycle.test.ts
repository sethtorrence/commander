import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { inTurn, keepInTray, stopCoreOnQuit } from './lifecycle';

describe('inTurn', () => {
  it('runs each step after the one before, never waiting on one longer than its time', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    const steps = inTurn([
      // The window never answers: its time runs out, and the held messages still go.
      { run: () => new Promise<void>(() => ran.push('save')), timeoutMs: 2_000 },
      { run: async () => void ran.push('send held'), timeoutMs: 15_000 },
    ]);

    const done = steps();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ran).toEqual(['save']);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(ran).toEqual(['save', 'send held']);
    vi.useRealTimers();
  });
});

// A stand-in for Electron's app: quit() emits a cancellable before-quit, and only quits
// for real if nobody prevented it.
class FakeApp extends EventEmitter {
  quitCount = 0;
  quit() {
    let prevented = false;
    this.emit('before-quit', { preventDefault: () => (prevented = true) });
    if (!prevented) this.quitCount += 1;
  }
}

class FakeWindow extends EventEmitter {
  hidden = false;
  closed = false;
  hide() {
    this.hidden = true;
  }
  close() {
    let prevented = false;
    this.emit('close', { preventDefault: () => (prevented = true) });
    if (!prevented) this.closed = true;
  }
}

class FakeCore extends EventEmitter {
  killed = false;
  exited = false;
  running() {
    return !this.exited;
  }
  kill() {
    this.killed = true;
    return true;
  }
  exit(code = 0) {
    this.exited = true;
    this.emit('exit', code);
  }
}

describe('keepInTray', () => {
  it('hides the window instead of closing it', () => {
    const app = new FakeApp();
    const window = new FakeWindow();
    keepInTray(window, app);
    window.close();
    expect(window.hidden).toBe(true);
    expect(window.closed).toBe(false);
  });

  it('lets the window close once Commander is quitting', () => {
    const app = new FakeApp();
    const window = new FakeWindow();
    keepInTray(window, app);
    app.quit();
    window.close();
    expect(window.closed).toBe(true);
  });
});

describe('stopCoreOnQuit', () => {
  it('holds the quit until the Core has exited', () => {
    const app = new FakeApp();
    const core = new FakeCore();
    stopCoreOnQuit(app, core);

    app.quit();
    expect(core.killed).toBe(true);
    expect(app.quitCount).toBe(0);

    core.exit();
    expect(app.quitCount).toBe(1);
  });

  it('quits straight away when the Core has already stopped', () => {
    const app = new FakeApp();
    const core = new FakeCore();
    stopCoreOnQuit(app, core);
    core.exit(1);

    app.quit();
    expect(core.killed).toBe(false);
    expect(app.quitCount).toBe(1);
  });

  it('quits straight away, without saving first, while a stopped Core waits to start again', () => {
    const app = new FakeApp();
    const core = new FakeCore();
    const beforeStop = vi.fn(async () => {});
    stopCoreOnQuit(app, core, { beforeStop });
    core.exit(1);

    app.quit();
    expect(beforeStop).not.toHaveBeenCalled();
    expect(core.killed).toBe(false);
    expect(app.quitCount).toBe(1);
  });

  it('waits for a Core started again after an earlier one stopped', () => {
    const app = new FakeApp();
    const core = new FakeCore();
    stopCoreOnQuit(app, core);
    // The first Core stopped, and a new one is running (the supervisor stands for both).
    core.exit(1);
    core.exited = false;

    app.quit();
    expect(core.killed).toBe(true);
    expect(app.quitCount).toBe(0);
    core.exit();
    expect(app.quitCount).toBe(1);
  });

  it('gives up waiting on a Core that will not exit', () => {
    vi.useFakeTimers();
    const app = new FakeApp();
    const core = new FakeCore();
    stopCoreOnQuit(app, core, { timeoutMs: 3000 });

    app.quit();
    vi.advanceTimersByTime(2999);
    expect(app.quitCount).toBe(0);
    vi.advanceTimersByTime(1);
    expect(app.quitCount).toBe(1);
    vi.useRealTimers();
  });

  it('lets the window save what it is holding before the Core stops', async () => {
    const app = new FakeApp();
    const core = new FakeCore();
    let saved = () => {};
    const beforeStop = vi.fn(() => new Promise<void>((resolve) => (saved = resolve)));
    stopCoreOnQuit(app, core, { beforeStop });

    app.quit();
    app.quit();
    expect(beforeStop).toHaveBeenCalledOnce();
    expect(core.killed).toBe(false);

    saved();
    await vi.waitFor(() => expect(core.killed).toBe(true));
    core.exit();
    expect(app.quitCount).toBe(1);
  });

  it('stops the Core anyway when saving fails or takes too long', async () => {
    vi.useFakeTimers();
    const app = new FakeApp();
    const core = new FakeCore();
    stopCoreOnQuit(app, core, { beforeStop: () => new Promise(() => {}), beforeStopTimeoutMs: 2000 });
    app.quit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(core.killed).toBe(true);
    vi.useRealTimers();

    const failing = new FakeCore();
    const other = new FakeApp();
    stopCoreOnQuit(other, failing, { beforeStop: () => Promise.reject(new Error('Window gone')) });
    other.quit();
    await vi.waitFor(() => expect(failing.killed).toBe(true));
  });

  it('asks the Core to stop only once, however many times quit is pressed', () => {
    const app = new FakeApp();
    const core = new FakeCore();
    const kill = vi.spyOn(core, 'kill');
    stopCoreOnQuit(app, core);

    app.quit();
    app.quit();
    expect(kill).toHaveBeenCalledOnce();
    core.exit();
    expect(app.quitCount).toBe(1);
  });
});
