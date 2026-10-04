// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from '../linear/Markdown';

// GitHub bodies and comments are other people's Markdown (ADR 0004: untrusted Source content). The
// GitHub Section shows them through the Linear Section's read-only renderer, so this corpus of
// hostile Markdown pins down what it may never do: run script, load anything (images, frames,
// styles), or link anywhere but a web or mail address in the system browser.

afterEach(cleanup);

const CORPUS: [name: string, source: string][] = [
  ['script tag', '<script>alert(1)</script>'],
  ['inline script', 'Hello <script>alert(1)</script> there'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['img tracking pixel', '<img src="https://tracker.test/pixel.gif" width="1" height="1">'],
  ['iframe', '<iframe src="https://evil.test/frame"></iframe>'],
  ['object and embed', '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x">'],
  ['svg onload', '<svg onload="alert(1)"><circle r="5"/></svg>'],
  ['style tag', '<style>body { display: none }</style>'],
  [
    'link and meta',
    '<link rel="stylesheet" href="https://evil.test/x.css"><meta http-equiv="refresh" content="0;url=https://evil.test">',
  ],
  ['base tag', '<base href="https://evil.test/">'],
  ['form', '<form action="https://evil.test"><input name="token"><button>Go</button></form>'],
  [
    'picture source',
    '<picture><source srcset="https://evil.test/a.png"><img src="https://evil.test/b.png"></picture>',
  ],
  [
    'video and audio',
    '<video src="https://evil.test/v.mp4" autoplay></video><audio src="https://evil.test/a.mp3"></audio>',
  ],
  ['raw anchor', '<a href="javascript:alert(1)">click</a>'],
  ['details', '<details><summary>More</summary>hidden <b>bold</b></details>'],
  ['html comment', 'before <!-- <img src="https://evil.test/c.png"> --> after'],
  ['javascript link', '[click](javascript:alert(1))'],
  ['mixed-case javascript link', '[click](JaVaScRiPt:alert(1))'],
  ['spaced javascript link', '[click]( javascript:alert(1))'],
  ['bracketed javascript link', '[click](<javascript:alert(1)>)'],
  ['entity javascript link', '[click](&#106;avascript:alert(1))'],
  ['tab javascript link', '[click](java\tscript:alert(1))'],
  ['vbscript link', '[click](vbscript:msgbox(1))'],
  ['data link', '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
  ['file link', '[click](file:///etc/passwd)'],
  ['protocol-relative link', '[click](//evil.test/x)'],
  ['javascript autolink', '<javascript:alert(1)>'],
  ['reference javascript link', '[click][evil]\n\n[evil]: javascript:alert(1)'],
  ['reference image', '![pixel][p]\n\n[p]: https://tracker.test/p.gif'],
  ['protocol-relative image', '![pixel](//tracker.test/p.gif)'],
  ['data image', '![pixel](data:image/png;base64,iVBORw0KGgo=)'],
  ['image inside a link (a badge)', '[![build](https://img.shields.test/badge.svg)](https://ci.test/run/1)'],
  ['title with quotes', '[ok](https://ok.test "a\\" onmouseover=\\"alert(1)")'],
  ['html in a table', '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |'],
  ['script in code', '```html\n<script>alert(1)</script>\n```'],
  ['deep quotes', `${'> '.repeat(200)}deep`],
  ['many emphasis markers', `${'*'.repeat(2000)}x`],
  ['bidi and zero-width', 'safe‮txt.exe​ and ⁦hidden⁩'],
];

// Elements that load something, run something, or take input.
const FORBIDDEN =
  'img, script, iframe, frame, object, embed, svg, math, style, link, meta, base, form, button, picture, source, video, audio, track, textarea, select, input:not([type="checkbox"])';

function expectInert(container: HTMLElement) {
  expect(container.querySelectorAll(FORBIDDEN)).toHaveLength(0);
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith('on'), `${element.tagName} ${attribute}`).toBe(false);
      expect(['src', 'srcset', 'style', 'action', 'formaction', 'background', 'poster']).not.toContain(
        attribute,
      );
    }
  }
  for (const link of container.querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '').toMatch(/^(https?:|mailto:)/i);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  }
  // A link never holds another link.
  expect(container.querySelectorAll('a a')).toHaveLength(0);
  for (const box of container.querySelectorAll('input'))
    expect((box as HTMLInputElement).disabled).toBe(true);
}

describe('hostile Markdown in GitHub bodies and comments', () => {
  it.each(CORPUS)('%s: draws nothing that runs, loads or links outside the web', (_name, source) => {
    const { container } = render(<Markdown source={source} />);
    expectInert(container);
  });

  it('shows raw HTML as the text it is', () => {
    const { container } = render(
      <Markdown source={'<script>alert(1)</script>\n\n<a href="javascript:alert(1)">click</a>'} />,
    );
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<a href="javascript:alert(1)">click</a>');
  });

  it('keeps a badge inside a link as the link’s text, never a second link or an image', () => {
    render(<Markdown source="[![build](https://img.shields.test/badge.svg)](https://ci.test/run/1)" />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://ci.test/run/1');
    expect(links[0]?.textContent).toContain('Image: build');
  });

  it('turns a lone HTML image (GitHub’s screenshot uploads) into a link to it, never loading it', () => {
    const { container } = render(
      <Markdown source='<img width="420" alt="Retry graph" src="https://github.com/user-attachments/assets/abc">' />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    const link = screen.getByRole('link', { name: '[Image: Retry graph]' });
    expect(link.getAttribute('href')).toBe('https://github.com/user-attachments/assets/abc');
    // One that points anywhere else stays text.
    cleanup();
    const other = render(<Markdown source={'<img alt="x" src="javascript:alert(1)">'} />);
    expect(other.container.querySelectorAll('a')).toHaveLength(0);
  });

  it('still makes web and mail addresses into links', () => {
    render(
      <Markdown source="[docs](https://docs.test/a) and [mail](mailto:ops@acme.test) and https://status.test" />,
    );
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://docs.test/a',
      'mailto:ops@acme.test',
      'https://status.test',
    ]);
  });
});
