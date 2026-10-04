import { emailImageUrl, emailMessageUrl, emailPartUrl } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { frameNavigationAllowed, measurerRequestAllowed, windowRequestAllowed } from './guards';

const TOKEN = '12'.repeat(16);
const WINDOW = 3;
const production = { windowId: () => WINDOW, devOrigin: null };
const dev = { windowId: () => WINDOW, devOrigin: 'http://localhost:5173' };

describe('the window’s request guard', () => {
  it('cancels every web request: the window never needs the network', () => {
    for (const url of [
      'https://tracker.test/pixel.gif',
      'http://tracker.test/x',
      'wss://tracker.test/socket',
      'ftp://tracker.test/x',
      'HTTPS://TRACKER.TEST/',
    ])
      expect(
        windowRequestAllowed({ url, resourceType: 'image', webContentsId: WINDOW }, production),
        url,
      ).toBe(false);
  });

  it('lets the development server through in development, and nothing else', () => {
    expect(
      windowRequestAllowed({ url: 'http://localhost:5173/src/main.tsx', resourceType: 'script' }, dev),
    ).toBe(true);
    expect(windowRequestAllowed({ url: 'ws://localhost:5173/', resourceType: 'webSocket' }, dev)).toBe(true);
    expect(windowRequestAllowed({ url: 'http://localhost:5174/', resourceType: 'script' }, dev)).toBe(false);
    expect(windowRequestAllowed({ url: 'https://tracker.test/', resourceType: 'image' }, dev)).toBe(false);
  });

  it('leaves Commander’s own files and pasted images alone', () => {
    expect(
      windowRequestAllowed({ url: 'file:///app/renderer/index.html', resourceType: 'mainFrame' }, production),
    ).toBe(true);
    expect(
      windowRequestAllowed(
        { url: `attachment://local/${'a'.repeat(64)}.png`, resourceType: 'image' },
        production,
      ),
    ).toBe(true);
  });

  it('loads a message’s document only as a frame of the window, and its images and parts only as images', () => {
    const doc = emailMessageUrl(TOKEN);
    expect(
      windowRequestAllowed({ url: doc, resourceType: 'subFrame', webContentsId: WINDOW }, production),
    ).toBe(true);
    expect(windowRequestAllowed({ url: doc, resourceType: 'subFrame', webContentsId: 99 }, production)).toBe(
      false,
    );
    for (const resourceType of ['mainFrame', 'script', 'stylesheet', 'xhr', 'object', 'font', 'image'])
      expect(
        windowRequestAllowed({ url: doc, resourceType, webContentsId: WINDOW }, production),
        resourceType,
      ).toBe(false);
    for (const url of [emailImageUrl(TOKEN, 0), emailPartUrl(TOKEN, 'a@b')]) {
      expect(windowRequestAllowed({ url, resourceType: 'image' }, production)).toBe(true);
      for (const resourceType of ['subFrame', 'script', 'stylesheet', 'font', 'media', 'xhr'])
        expect(windowRequestAllowed({ url, resourceType }, production), `${url} ${resourceType}`).toBe(false);
    }
    expect(windowRequestAllowed({ url: 'commander-mail://other/x', resourceType: 'image' }, production)).toBe(
      false,
    );
  });
});

describe('the measurer’s request guard', () => {
  it('allows a message’s document as its page and images, and nothing else', () => {
    expect(measurerRequestAllowed({ url: emailMessageUrl(TOKEN), resourceType: 'mainFrame' })).toBe(true);
    expect(measurerRequestAllowed({ url: emailImageUrl(TOKEN, 1), resourceType: 'image' })).toBe(true);
    expect(measurerRequestAllowed({ url: emailMessageUrl(TOKEN), resourceType: 'subFrame' })).toBe(false);
    expect(measurerRequestAllowed({ url: 'https://tracker.test/x', resourceType: 'image' })).toBe(false);
    expect(measurerRequestAllowed({ url: 'file:///etc/passwd', resourceType: 'image' })).toBe(false);
    expect(measurerRequestAllowed({ url: 'data:image/png;base64,AA==', resourceType: 'image' })).toBe(false);
  });
});

describe('the frame guard', () => {
  const main = { url: 'file:///app/index.html', parent: null, routingId: 1, processId: 1 };
  const emailFrame = (url: string) => ({ url, parent: main, routingId: 7, processId: 9 });
  const doc = emailMessageUrl(TOKEN);

  it('lets the window point a new frame at a message’s document', () => {
    expect(
      frameNavigationAllowed({ url: doc, isMainFrame: false, frame: emailFrame(''), initiator: main }, main),
    ).toBe(true);
    expect(
      frameNavigationAllowed(
        { url: doc, isMainFrame: false, frame: emailFrame('about:blank'), initiator: null },
        main,
      ),
    ).toBe(true);
  });

  it('never lets an email frame navigate anywhere, not even to another message', () => {
    const shown = emailFrame(doc);
    for (const url of [
      'https://evil.test/',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,x',
      emailMessageUrl('34'.repeat(16)),
    ])
      expect(
        frameNavigationAllowed({ url, isMainFrame: false, frame: shown, initiator: shown }, main),
        url,
      ).toBe(false);
  });

  it('refuses a frame pointed at anything of commander-mail: but a document, or by anyone but the window', () => {
    expect(
      frameNavigationAllowed(
        { url: emailImageUrl(TOKEN, 0), isMainFrame: false, frame: emailFrame(''), initiator: main },
        main,
      ),
    ).toBe(false);
    const other = { url: 'https://x.test/', parent: main, routingId: 8, processId: 9 };
    expect(
      frameNavigationAllowed({ url: doc, isMainFrame: false, frame: emailFrame(''), initiator: other }, main),
    ).toBe(false);
    expect(
      frameNavigationAllowed(
        { url: doc, isMainFrame: false, frame: emailFrame('https://x.test/'), initiator: main },
        main,
      ),
    ).toBe(false);
  });

  it('leaves the main frame and other frames to their own rules', () => {
    expect(frameNavigationAllowed({ url: 'https://x.test/', isMainFrame: true, frame: main }, main)).toBe(
      true,
    );
    expect(
      frameNavigationAllowed({ url: 'about:blank', isMainFrame: false, frame: emailFrame('') }, main),
    ).toBe(true);
  });
});
