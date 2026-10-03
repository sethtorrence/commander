import type { WebContents } from 'electron';

// Links clicked in the window (in a Linear issue's description or comments, "Open in Linear") open
// in the system browser. The window itself never navigates away from Commander, and never opens
// another Electron window: only web and mail links leave, and nothing else is opened at all.

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The link as the browser should get it, or null when it isn't a web or mail link. */
export function externalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
}

export type LinkGuardedContents = {
  getURL(): string;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }): void;
  on(event: 'will-navigate', listener: (event: { url: string; preventDefault(): void }) => void): void;
};

const withoutHash = (url: string) => url.split('#')[0];

/** Sends the window's links to `openExternal` (shell.openExternal) and keeps the window on Commander. */
export function keepLinksInBrowser(
  contents: LinkGuardedContents | WebContents,
  openExternal: (url: string) => void,
): void {
  const guarded = contents as LinkGuardedContents;
  const leave = (raw: string) => {
    const url = externalUrl(raw);
    if (url) openExternal(url);
  };
  guarded.setWindowOpenHandler(({ url }) => {
    leave(url);
    return { action: 'deny' };
  });
  guarded.on('will-navigate', (event) => {
    // Reloading Commander's own page is fine; going anywhere else is not.
    if (withoutHash(event.url) === withoutHash(guarded.getURL())) return;
    event.preventDefault();
    leave(event.url);
  });
}
