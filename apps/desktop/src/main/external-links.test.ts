import { describe, expect, it } from 'vitest';
import { externalUrl, keepLinksInBrowser, type LinkGuardedContents } from './external-links';

// Stands in for the window's webContents: its open handler and will-navigate listeners.
function fakeContents(current = 'file:///app/out/renderer/index.html#/linear') {
  let openHandler: Parameters<LinkGuardedContents['setWindowOpenHandler']>[0] = () => ({ action: 'allow' });
  const navigateListeners: ((event: { url: string; preventDefault(): void }) => void)[] = [];
  const contents: LinkGuardedContents = {
    getURL: () => current,
    setWindowOpenHandler: (handler) => {
      openHandler = handler;
    },
    on: (_event, listener) => {
      navigateListeners.push(listener);
    },
  };
  return {
    contents,
    open: (url: string) => openHandler({ url }),
    navigate(url: string) {
      let prevented = false;
      for (const listener of navigateListeners) listener({ url, preventDefault: () => (prevented = true) });
      return prevented;
    },
  };
}

describe('which links leave for the system browser', () => {
  it('lets web and mail links through', () => {
    expect(externalUrl('https://linear.app/acme/issue/ENG-418')).toBe(
      'https://linear.app/acme/issue/ENG-418',
    );
    expect(externalUrl('http://example.com/a b')).toBe('http://example.com/a%20b');
    expect(externalUrl('mailto:priya@acme.test')).toBe('mailto:priya@acme.test');
  });

  it('keeps anything else in: files, scripts, custom schemes and garbage', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://open', 'not a url', '']) {
      expect(externalUrl(url)).toBeNull();
    }
  });
});

describe('keeping links in the browser', () => {
  it('opens a link meant for a new window in the system browser, never in a Commander window', () => {
    const fake = fakeContents();
    const opened: string[] = [];
    keepLinksInBrowser(fake.contents, (url) => opened.push(url));

    expect(fake.open('https://linear.app/acme/issue/ENG-418')).toEqual({ action: 'deny' });
    expect(fake.open('file:///etc/passwd')).toEqual({ action: 'deny' });
    expect(opened).toEqual(['https://linear.app/acme/issue/ENG-418']);
  });

  it('never lets the window navigate away from Commander: web links open in the browser instead', () => {
    const fake = fakeContents();
    const opened: string[] = [];
    keepLinksInBrowser(fake.contents, (url) => opened.push(url));

    expect(fake.navigate('https://example.com/')).toBe(true);
    expect(fake.navigate('file:///etc/passwd')).toBe(true);
    expect(opened).toEqual(['https://example.com/']);
  });

  it('lets the window reload itself', () => {
    const fake = fakeContents('http://localhost:5173/#/todos');
    keepLinksInBrowser(fake.contents, () => {});

    expect(fake.navigate('http://localhost:5173/')).toBe(false);
    expect(fake.navigate('http://localhost:5173/#/linear')).toBe(false);
  });
});
