// The window is created hidden and shown only once its first frame is painted. The theme lives in
// the window's own storage, so a fixed background colour would flash dark before a light frame
// (or the reverse); waiting for the painted frame shows the right theme from the first moment.
// A window that never reports is shown after timeoutMs anyway, so Commander can't start invisible.
// Started at login (--hidden), Commander keeps waiting in the tray until summoned.

type ShowableWindow = { show(): void };

export function revealWhenPainted(options: {
  window: ShowableWindow;
  startsHidden: boolean;
  /** Registers the listener for the window's "first frame painted" message. */
  onPainted: (listener: () => void) => void;
  timeoutMs?: number;
}): void {
  const { window, startsHidden, onPainted, timeoutMs = 3000 } = options;
  if (startsHidden) return;
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    clearTimeout(timer);
    window.show();
  };
  const timer = setTimeout(reveal, timeoutMs);
  onPainted(reveal);
}
