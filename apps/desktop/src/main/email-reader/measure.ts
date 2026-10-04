// How tall a message's document is (#134), so its frame can be sized to its content. The frame is
// sandboxed without scripts and without same-origin, so neither the window nor the main process can
// look inside it; instead the same document is laid out a second time, out of sight, in a page of
// its own, with JavaScript switched off altogether, its own empty in-memory session, every request
// refused but commander-mail:'s, and no permissions. It is laid out at the frame's width, once its
// images (if shown) have loaded, and Chromium's own layout metrics (the DevTools protocol's
// Page.getLayoutMetrics, from the main process) say how tall it is: nothing in the page is asked.
import { emailReaderScheme } from '@commander/domain';
import { session, WebContentsView } from 'electron';
import { measurerRequestAllowed } from './guards';

const PARTITION = 'commander-mail-measure';
// The longest a measurement waits for the document (and its images) to load.
const LOAD_MS = 8_000;
const SETTLE_MS = 50;
// The tallest a frame is made; a longer message scrolls inside it.
export const HEIGHT_MAX = 20_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMeasurer(
  handler: (request: Request) => Promise<Response>,
  // Hears each request the measurer's page makes, and whether it was let through (end-to-end tests).
  onRequest?: (details: { url: string; resourceType: string }, allowed: boolean) => void,
) {
  let view: WebContentsView | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function viewOf(): WebContentsView {
    if (view && !view.webContents.isDestroyed()) return view;
    const ses = session.fromPartition(PARTITION);
    if (!ses.protocol.isProtocolHandled(emailReaderScheme)) ses.protocol.handle(emailReaderScheme, handler);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = measurerRequestAllowed(details);
      onRequest?.(details, allowed);
      callback({ cancel: !allowed });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    view = new WebContentsView({
      webPreferences: {
        session: ses,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webgl: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('render-process-gone', () => {
      view = null;
    });
    return view;
  }

  async function measureNow(url: string, width: number, zoom: number): Promise<number | null> {
    const current = viewOf();
    const contents = current.webContents;
    current.setBounds({ x: 0, y: 0, width, height: 100 });
    contents.setZoomFactor(zoom);
    try {
      await Promise.race([contents.loadURL(url), wait(LOAD_MS)]);
      // No scrollbar narrowing the layout (the frame has none once sized).
      await contents.insertCSS('html { overflow: hidden !important; }');
      await wait(SETTLE_MS);
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
        cssContentSize?: { height?: number };
      };
      const height = metrics.cssContentSize?.height ?? 0;
      return height > 0 ? Math.min(Math.ceil(height), HEIGHT_MAX) : null;
    } catch {
      return null;
    }
  }

  return {
    /** The document's height at this width, in CSS pixels; null if it couldn't be laid out. */
    measure(url: string, width: number, zoom = 1): Promise<number | null> {
      const next = queue.then(() => measureNow(url, width, zoom));
      queue = next.catch(() => null);
      return next;
    },
    close() {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
      view = null;
    },
  };
}
