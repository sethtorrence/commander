import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { keepInTray, stopCoreOnQuit } from './lifecycle';

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
  kill() {
    this.killed = true;
    return true;
  }
  exit(code = 0) {
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
