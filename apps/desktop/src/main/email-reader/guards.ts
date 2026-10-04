// The email reader's backstops in the main process (#134), behind the sanitiser and the frame's
// sandbox and CSP: should either ever miss, the session and the window still hold.
//
// - The request guard (the window's session): the window never needs the network (its CSP is
//   `default-src 'self'`; Sources are reached by the Core and the main process, never from the
//   window), so every web request from it is cancelled, the email frame's among them. The only
//   exception is the development server the window is loaded from in `pnpm dev`. And since
//   commander-mail: bypasses CSP (protocol.ts), the guard takes CSP's place for it: a message's
//   document loads only as a frame of the window itself, its images and parts only as images.
// - The measurer's session allows commander-mail: and nothing else at all.
// - The frame guard (the window's contents): a frame showing an email never navigates. Its links
//   open new windows, which the window's handler (external-links.ts) sends to the system browser if
//   they are web or mail links; anything that would move the frame itself (a link without a target,
//   a refresh, a form) is stopped. A frame is only ever pointed at a message's document by the window.
//   Hovering a link reports its real destination to the window, which shows it under the message.
import { emailReaderScheme, emailReaderUrlOf } from '@commander/domain';

export type RequestDetails = { url: string; resourceType: string; webContentsId?: number };

const WEB = /^(?:https?|wss?|ftp):/i;

/** Whether the window's session lets a request through. */
export function windowRequestAllowed(
  { url, resourceType, webContentsId }: RequestDetails,
  { windowId, devOrigin }: { windowId: () => number | null; devOrigin: string | null },
): boolean {
  if (url.startsWith(`${emailReaderScheme}:`)) {
    const asked = emailReaderUrlOf(url);
    if (!asked) return false;
    if (asked.kind === 'message') return resourceType === 'subFrame' && webContentsId === windowId();
    return resourceType === 'image';
  }
  if (WEB.test(url)) {
    if (!devOrigin) return false;
    try {
      const target = new URL(url);
      const dev = new URL(devOrigin);
      return (
        target.host === dev.host &&
        target.hostname === dev.hostname &&
        ['http:', 'ws:'].includes(target.protocol)
      );
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether the measurer's session lets a request through: a message's document as its page, and images. */
export function measurerRequestAllowed({ url, resourceType }: RequestDetails): boolean {
  const asked = emailReaderUrlOf(url);
  if (!asked) return false;
  return asked.kind === 'message' ? resourceType === 'mainFrame' : resourceType === 'image';
}

type Frame = { url: string; parent: Frame | null; routingId: number; processId: number };

export type FrameNavigation = {
  url: string;
  isMainFrame: boolean;
  frame: Frame | null;
  initiator?: Frame | null;
  preventDefault(): void;
};

const sameFrame = (a: Frame | null | undefined, b: Frame | null | undefined) =>
  !!a && !!b && a.routingId === b.routingId && a.processId === b.processId;

/**
 * Whether a frame of the window may navigate: an email frame (one showing, or about to show, a
 * commander-mail: document) only from nothing to a message's document, at the window's own asking.
 * Other frames are left alone.
 */
export function frameNavigationAllowed(
  navigation: Omit<FrameNavigation, 'preventDefault'>,
  mainFrame: Frame,
): boolean {
  if (navigation.isMainFrame) return true;
  const current = navigation.frame?.url ?? '';
  const toEmail = navigation.url.startsWith(`${emailReaderScheme}:`);
  const fromEmail = current.startsWith(`${emailReaderScheme}:`);
  if (!toEmail && !fromEmail) return true;
  if (fromEmail) return false;
  if (emailReaderUrlOf(navigation.url)?.kind !== 'message') return false;
  if (current !== '' && current !== 'about:blank') return false;
  // A new frame is pointed at its document by the window (its parent).
  return navigation.initiator == null || sameFrame(navigation.initiator, mainFrame);
}

export type GuardedContents = {
  id: number;
  mainFrame: Frame;
  on(event: 'will-frame-navigate', listener: (event: FrameNavigation) => void): void;
  on(event: 'update-target-url', listener: (event: unknown, url: string) => void): void;
};

/** Keeps email frames from navigating, and reports hovered links' real destinations. */
export function guardEmailFrames(contents: GuardedContents, onHover: (url: string) => void) {
  contents.on('will-frame-navigate', (event) => {
    if (!frameNavigationAllowed(event, contents.mainFrame)) event.preventDefault();
  });
  contents.on('update-target-url', (_event, url) => onHover(url));
}
