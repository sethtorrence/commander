import { describe, expect, it } from 'vitest';
import { askWindowToSave } from './save-before-quit';

class FakeWindow {
  sent: [string, number][] = [];
  destroyed = false;
  send(channel: string, id: number) {
    this.sent.push([channel, id]);
  }
  isDestroyed() {
    return this.destroyed;
  }
}

describe('askWindowToSave', () => {
  it('asks the window to save and waits for its answer to that request', async () => {
    const window = new FakeWindow();
    const saving = askWindowToSave(window);
    let saved = false;
    const request = saving.request().then(() => {
      saved = true;
    });

    const [[channel, id] = ['', 0]] = window.sent;
    expect(channel).toBe('save-before-quit');
    saving.settle(id + 1);
    await Promise.resolve();
    expect(saved).toBe(false);

    saving.settle(id);
    await request;
    expect(saved).toBe(true);
  });

  it('does not wait for a window that is gone', async () => {
    const window = new FakeWindow();
    window.destroyed = true;

    await askWindowToSave(window).request();
    expect(window.sent).toEqual([]);
  });
});
