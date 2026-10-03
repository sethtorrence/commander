import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealWhenPainted } from './reveal';

class FakeWindow {
  shows = 0;
  show() {
    this.shows += 1;
  }
}

// Stands in for the window's "first frame painted" message.
function painted() {
  let listener = () => {};
  return {
    onPainted: (next: () => void) => {
      listener = next;
    },
    paint: () => listener(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('revealWhenPainted', () => {
  it('shows the window once its first frame is painted, in the saved theme, and not before', () => {
    const window = new FakeWindow();
    const frame = painted();
    revealWhenPainted({ window, startsHidden: false, onPainted: frame.onPainted });

    expect(window.shows).toBe(0);
    frame.paint();
    expect(window.shows).toBe(1);
    vi.runAllTimers();
    frame.paint();
    expect(window.shows).toBe(1);
  });

  it('shows the window anyway if the frame never reports, so Commander cannot start invisible', () => {
    const window = new FakeWindow();
    revealWhenPainted({ window, startsHidden: false, onPainted: painted().onPainted, timeoutMs: 3000 });

    vi.advanceTimersByTime(2999);
    expect(window.shows).toBe(0);
    vi.advanceTimersByTime(1);
    expect(window.shows).toBe(1);
  });

  it('leaves a Commander started at login waiting in the tray', () => {
    const window = new FakeWindow();
    const frame = painted();
    revealWhenPainted({ window, startsHidden: true, onPainted: frame.onPainted });

    frame.paint();
    vi.runAllTimers();
    expect(window.shows).toBe(0);
  });
});
