import firstSync from '@commander/sources/src/outlook/recorded/first-sync.json';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { HOSTILE } from './hostile-corpus';
import {
  CONTENT_IDS_MAX,
  NESTING_MAX,
  nestingDepth,
  type SanitizeOptions,
  sanitizeEmailHtml,
  TooComplex,
} from './sanitize';

const TOKEN = 'T';
const options = (overrides: Partial<SanitizeOptions> = {}): SanitizeOptions => ({
  images: 'held',
  quotes: true,
  imageUrl: (index) => `commander-mail://image/${TOKEN}/${index}`,
  partUrl: (contentId) => `commander-mail://part/${TOKEN}/${encodeURIComponent(contentId)}`,
  ...overrides,
});

const run = (html: string, overrides: Partial<SanitizeOptions> = {}) =>
  sanitizeEmailHtml(html, options(overrides));

const parse = (html: string) => new JSDOM(html).window.document;
const body = (html: string, overrides: Partial<SanitizeOptions> = {}) =>
  parse(run(html, overrides).html).body;

// Elements that load something, run something, submit something or change how the document is read.
const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'param',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'base',
  'link',
  'noscript',
  'noembed',
  'noframes',
  'xmp',
  'plaintext',
  'template',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'map',
  'area',
  'svg',
  'math',
  'image',
  'portal',
  'isindex',
  'keygen',
];
// Attributes that name something to load or a place to send things.
const URL_ATTRIBUTES = [
  'src',
  'srcset',
  'href',
  'xlink:href',
  'background',
  'poster',
  'action',
  'formaction',
  'data',
  'codebase',
  'cite',
  'longdesc',
  'lowsrc',
  'dynsrc',
  'ping',
  'usemap',
  'manifest',
  'srcdoc',
];
const ALLOWED_FETCH = /^commander-mail:\/\/(?:image|part)\/T\//;

/**
 * Everything that makes output safe for the frame, checked on the output as the frame would parse
 * it: no forbidden element, no event handler, no URL anywhere but a link's web or mail address and
 * Commander's own handlers, and no CSS that loads or runs anything.
 */
function expectSafe(html: string, label = '') {
  const document = parse(html);
  // Only Commander's own <meta>s, in the head: the charset, no referrer, a light colour scheme.
  const metas = [...document.querySelectorAll('meta')].map((meta) => meta.outerHTML);
  expect(metas, `${label}: <meta>`).toEqual([
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light">',
  ]);
  expect(document.head.querySelectorAll('meta')).toHaveLength(3);
  for (const tag of FORBIDDEN_TAGS)
    expect(document.getElementsByTagName(tag).length, `${label}: <${tag}>`).toBe(0);
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      expect(name.startsWith('on'), `${label}: ${name} on <${element.localName}>`).toBe(false);
      if (name === 'style') expectSafeCss(attribute.value, `${label}: style on <${element.localName}>`);
      if (!URL_ATTRIBUTES.includes(name)) continue;
      const value = attribute.value.trim();
      if (name === 'href' && element.localName === 'a') {
        expect(value, `${label}: link`).toMatch(/^(?:https?:|mailto:)/i);
        expect(element.getAttribute('target'), `${label}: link target`).toBe('_blank');
        expect(element.getAttribute('rel'), `${label}: link rel`).toBe('noopener noreferrer');
        continue;
      }
      if ((name === 'src' && element.localName === 'img') || name === 'background') {
        expect(value, `${label}: ${name} on <${element.localName}>`).toMatch(ALLOWED_FETCH);
        continue;
      }
      throw new Error(`${label}: unexpected ${name}="${value}" on <${element.localName}>`);
    }
  }
  const styles = [...document.querySelectorAll('style')];
  for (const style of styles) expectSafeCss(style.textContent ?? '', `${label}: <style>`);
  // Style text can't break out of its element: what was one <style> stays one.
  expect(html.match(/<style/gi)?.length ?? 0, `${label}: style count`).toBe(styles.length);
  expect(html, `${label}: script`).not.toMatch(/<script/i);
  // Comments are dropped (Outlook's conditional comments carry markup).
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */);
  expect(walker.nextNode(), `${label}: comment`).toBeNull();
}

function expectSafeCss(css: string, label: string) {
  const lower = css.toLowerCase();
  for (const [index] of [...lower.matchAll(/url\s*\(/g)].map((match) => [match.index ?? 0])) {
    const rest = lower.slice(index).replace(/^url\s*\(\s*["']?/, '');
    expect(rest, `${label}: url()`).toMatch(/^commander-mail:\/\/(?:image|part)\/t\//);
  }
  for (const banned of [
    '@import',
    '@font-face',
    '@namespace',
    'expression(',
    'behavior',
    '-moz-binding',
    'image-set(',
    'var(',
    'attr(',
    'javascript:',
    'vbscript:',
    'data:',
    '\\',
    '</',
  ]) {
    // Backslashes may appear only as our own escape of "<".
    if (banned === '\\') {
      expect(lower.replace(/\\3c /g, ''), `${label}: escape`).not.toContain('\\');
      continue;
    }
    expect(lower, `${label}: ${banned}`).not.toContain(banned);
  }
}

describe('sanitising email HTML: the hostile corpus', () => {
  for (const [name, html] of Object.entries(HOSTILE)) {
    it(`is safe with images held: ${name}`, () => {
      const result = run(html, { images: 'held' });
      expectSafe(result.html, name);
      expect(result.remoteImages).toEqual([]);
    });
    it(`is safe with images shown: ${name}`, () => {
      const result = run(html, { images: 'shown' });
      expectSafe(result.html, name);
      for (const url of result.remoteImages) expect(url, name).toMatch(/^https:\/\//);
    });
    it(`is safe with quoted history folded: ${name}`, () => {
      expectSafe(run(html, { quotes: false }).html, name);
    });
  }
});

describe('sanitising email HTML: what is kept', () => {
  it('wraps the email in a document of its own, on a light sheet, saying it is UTF-8', () => {
    const { html } = run('<p>Hello <b>there</b></p>');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    const document = parse(html);
    expect(document.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    expect(document.body.innerHTML).toContain('<p>Hello <b>there</b></p>');
    expect(document.head.querySelector('style')?.textContent).toContain('background: #fff');
  });

  it('keeps the layout markup and styling newsletters use', () => {
    const html = `
      <table width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#f4f4f4" role="presentation">
        <tr><td style="padding: 20px; font-family: Arial, sans-serif; color: #333333" class="hero" id="top">
          <h1 style="margin:0;font-size:24px">Big news</h1>
          <p>Read <a href="https://news.example.com/story?id=1">the story</a>.</p>
          <ul><li>One</li><li>Two</li></ul>
          <font color="red" face="Georgia">Old-school</font>
          <center>centred</center>
        </td></tr>
      </table>`;
    const out = body(html);
    const table = out.querySelector('table') as HTMLTableElement;
    expect(table.getAttribute('width')).toBe('600');
    expect(table.getAttribute('bgcolor')).toBe('#f4f4f4');
    const cell = out.querySelector('td.hero#top') as HTMLElement;
    expect(cell.getAttribute('style')).toContain('padding:20px');
    expect(cell.getAttribute('style')).toContain('color:#333333');
    expect(out.querySelector('font')?.getAttribute('color')).toBe('red');
    expect(out.querySelector('center')?.textContent).toBe('centred');
    expect(out.querySelectorAll('li')).toHaveLength(2);
  });

  it('keeps style sheets, media queries included, without what loads or runs', () => {
    const html = `<html><head><style>
      @import url(https://tracker.test/i.css);
      @font-face { font-family: X; src: url(https://tracker.test/f.woff) }
      body { color: #222 } .btn { background: #0a84ff; border-radius: 4px }
      @media (max-width: 600px) { .col { display: block !important; width: 100% !important } }
    </style></head><body><p class="btn">Go</p></body></html>`;
    const { html: out } = run(html);
    const css = [...parse(out).querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(css).toContain('.btn');
    expect(css).toContain('#0a84ff');
    expect(css).toContain('@media (max-width:600px)');
    expect(css).toContain('display:block!important');
    expect(css).not.toContain('tracker.test');
    expect(css).not.toContain('@font-face');
  });

  it('keeps the body’s own colours and styles', () => {
    const out = body('<body bgcolor="#eeeeee" style="margin:0;color:#111"><p>x</p></body>');
    expect(out.getAttribute('bgcolor')).toBe('#eeeeee');
    expect(out.getAttribute('style')).toContain('color:#111');
  });

  it('keeps text that looks like markup as text', () => {
    const out = body('<p>if a &lt; b &amp;&amp; c &gt; d then &lt;script&gt;</p>');
    expect(out.textContent).toContain('if a < b && c > d then <script>');
    expect(out.querySelector('script')).toBeNull();
  });
});

describe('sanitising email HTML: links', () => {
  it('sends web and mail links to a new window (the system browser), with no referrer', () => {
    const out = body(
      '<a href="https://shop.example.com/order/1">Order</a> <a href="mailto:help@shop.example.com">Mail</a>',
    );
    const [web, mail] = [...out.querySelectorAll('a')];
    expect(web?.getAttribute('href')).toBe('https://shop.example.com/order/1');
    expect(web?.getAttribute('target')).toBe('_blank');
    expect(web?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mail?.getAttribute('href')).toBe('mailto:help@shop.example.com');
  });

  it('keeps the real destination of a link whose text names another (shown on hover)', () => {
    const out = body('<a href="https://evil.example/login">https://bank.example.com</a>');
    expect(out.querySelector('a')?.getAttribute('href')).toBe('https://evil.example/login');
    expect(out.querySelector('a')?.textContent).toBe('https://bank.example.com');
  });

  it('turns a link to anything but the web or mail into plain text', () => {
    for (const href of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'jav&#x09;ascript:alert(1)',
      '&#106;avascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
      'commander-mail://message/0123456789abcdef0123456789abcdef',
      'attachment://local/x.png',
      'cid:logo@x',
      'about:blank',
      'chrome://settings',
      '/relative/path',
      '#top',
      'ftp://files.example.com/x',
      'tel:+15551234',
    ]) {
      const out = body(`<a href="${href}">click</a>`);
      expect(out.querySelector('a')?.hasAttribute('href') ?? false, href).toBe(false);
      expect(out.textContent, href).toContain('click');
    }
  });

  it('keeps only addresses, subject, body, cc and bcc in a mail link', () => {
    const out = body('<a href="mailto:a@x.test?subject=Hi&attach=/home/me/.ssh/id_rsa">x</a>');
    expect(out.querySelector('a')?.getAttribute('href')).toBe('mailto:a@x.test?subject=Hi');
  });

  it('resolves a protocol-relative link to https', () => {
    const out = body('<a href="//news.example.com/x">x</a>');
    expect(out.querySelector('a')?.getAttribute('href')).toBe('https://news.example.com/x');
  });

  it('takes away hyperlink auditing pings and downloads', () => {
    const out = body('<a href="https://ok.example/" ping="https://tracker.test/ping" download="x.exe">x</a>');
    const link = out.querySelector('a') as HTMLAnchorElement;
    expect(link.hasAttribute('ping')).toBe(false);
    expect(link.hasAttribute('download')).toBe(false);
  });
});

describe('sanitising email HTML: remote images', () => {
  const newsletter = `
    <img src="https://cdn.shop.test/hero.png" width="600" height="300" alt="Autumn sale">
    <img src="https://tracker.test/open.gif?u=42" width="1" height="1">
    <img src="https://cdn.shop.test/hero.png" alt="again">
    <table background="https://cdn.shop.test/bg.png"><tr><td style="background-image:url('https://cdn.shop.test/cell.png')">x</td></tr></table>
    <img srcset="https://cdn.shop.test/hero@2x.png 2x" src="https://cdn.shop.test/hero.png">`;

  it('holds every one back: no URL to fetch, a quiet placeholder of the same size, and a count', () => {
    const result = run(newsletter, { images: 'held' });
    expect(result.remoteImages).toEqual([]);
    expect(result.heldImages).toBe(4);
    const out = parse(result.html).body;
    expect(result.html).not.toContain('cdn.shop.test');
    expect(result.html).not.toContain('tracker.test');
    const [hero, pixel] = [...out.querySelectorAll('img')];
    expect(hero?.hasAttribute('src')).toBe(false);
    expect(hero?.getAttribute('width')).toBe('600');
    expect(hero?.getAttribute('alt')).toBe('Autumn sale');
    expect(hero?.hasAttribute('data-commander-held')).toBe(true);
    expect(pixel?.hasAttribute('src')).toBe(false);
    expect(out.querySelector('table')?.hasAttribute('background')).toBe(false);
    expect(out.querySelector('td')?.getAttribute('style') ?? '').not.toContain('url(');
  });

  it('shows them through Commander’s image handler, each URL once, in order', () => {
    const result = run(newsletter, { images: 'shown' });
    expect(result.remoteImages).toEqual([
      'https://cdn.shop.test/hero.png',
      'https://tracker.test/open.gif?u=42',
      'https://cdn.shop.test/bg.png',
      'https://cdn.shop.test/cell.png',
    ]);
    expect(result.heldImages).toBe(0);
    const out = parse(result.html).body;
    const images = [...out.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(images).toEqual([
      'commander-mail://image/T/0',
      'commander-mail://image/T/1',
      'commander-mail://image/T/0',
      'commander-mail://image/T/0',
    ]);
    expect(out.querySelector('table')?.getAttribute('background')).toBe('commander-mail://image/T/2');
    expect(out.querySelector('td')?.getAttribute('style')).toContain('url(commander-mail://image/T/3)');
    expect(out.querySelector('img[srcset]')).toBeNull();
    expect(result.html).not.toContain('https://');
  });

  it('shows a protocol-relative image over https, and drops relative, data and other images', () => {
    const result = run(
      '<img src="//cdn.test/a.png"><img src="/b.png"><img src="data:image/png;base64,iVBORw0KGgo="><img src="file:///etc/x.png"><img src="ftp://x.test/c.png">',
      { images: 'shown' },
    );
    expect(result.remoteImages).toEqual(['https://cdn.test/a.png']);
    const sources = [...parse(result.html).body.querySelectorAll('img')].map((image) =>
      image.getAttribute('src'),
    );
    expect(sources).toEqual(['commander-mail://image/T/0', null, null, null, null]);
  });

  it('rewrites remote images in style sheets too, and holds them back with the rest', () => {
    const html = '<style>.hero{background:url("https://cdn.test/s.png") no-repeat;color:red}</style>';
    const shown = run(html, { images: 'shown' });
    expect(shown.remoteImages).toEqual(['https://cdn.test/s.png']);
    expect(shown.html).toContain('url(commander-mail://image/T/0)');
    const held = run(html, { images: 'held' });
    expect(held.heldImages).toBe(1);
    expect(held.html).not.toContain('cdn.test');
    expect(held.html).toContain('color:red');
  });

  it('names at most 500 remote images', () => {
    const html = Array.from({ length: 600 }, (_, i) => `<img src="https://cdn.test/${i}.png">`).join('');
    const result = run(html, { images: 'shown' });
    expect(result.remoteImages).toHaveLength(500);
    expect(parse(result.html).body.querySelectorAll('img[src]')).toHaveLength(500);
  });
});

describe('sanitising email HTML: inline (cid:) images', () => {
  it('serves them from the message’s own parts, whether remote images are held or not', () => {
    for (const images of ['held', 'shown'] as const) {
      const result = run(
        '<img src="cid:logo@shop.test" alt="Logo"><div style="background:url(cid:bg@shop.test)">x</div>',
        { images },
      );
      const out = parse(result.html).body;
      expect(out.querySelector('img')?.getAttribute('src')).toBe('commander-mail://part/T/logo%40shop.test');
      expect(out.querySelector('div')?.getAttribute('style')).toContain(
        'url(commander-mail://part/T/bg%40shop.test)',
      );
      expect(result.heldImages).toBe(0);
    }
  });
});

describe('sanitising email HTML: quoted history', () => {
  const gmailReply = `<div dir="ltr">Sounds good, see you then.</div><br>
    <div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Fri, Dana wrote:<br></div>
    <blockquote class="gmail_quote">Are we still on for Friday?</blockquote></div>`;

  it('folds a reply’s quoted history away, and says so', () => {
    const result = run(gmailReply, { quotes: false });
    expect(result.hasQuote).toBe(true);
    const text = parse(result.html).body.textContent ?? '';
    expect(text).toContain('Sounds good');
    expect(text).not.toContain('Are we still on');
  });

  it('shows it all when asked', () => {
    const result = run(gmailReply, { quotes: true });
    expect(result.hasQuote).toBe(true);
    expect(parse(result.html).body.textContent).toContain('Are we still on');
  });

  it('folds Apple Mail’s and Thunderbird’s cited replies, and Outlook’s reply header and what follows it', () => {
    const apple = '<div>Yes.</div><blockquote type="cite"><div>Coming?</div></blockquote>';
    expect(parse(run(apple, { quotes: false }).html).body.textContent).not.toContain('Coming?');
    const outlook =
      '<div>Done.</div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Dana</div><div>Can you finish it?</div>';
    const folded = run(outlook, { quotes: false });
    expect(folded.hasQuote).toBe(true);
    const text = parse(folded.html).body.textContent ?? '';
    expect(text).toContain('Done.');
    expect(text).not.toContain('Can you finish it?');
    expect(text).not.toContain('From:');
  });

  it('leaves a quote alone when the reply is written between its lines', () => {
    const inline = '<blockquote type="cite">First question?</blockquote><p>Answer one.</p>';
    const result = run(inline, { quotes: false });
    expect(result.hasQuote).toBe(false);
    expect(parse(result.html).body.textContent).toContain('First question?');
  });

  it('leaves a message that is only a quote (a forward) alone', () => {
    const forward = '<div class="gmail_quote">---------- Forwarded message ---------<br>The details</div>';
    const result = run(forward, { quotes: false });
    expect(result.hasQuote).toBe(false);
    expect(parse(result.html).body.textContent).toContain('The details');
  });

  it('says there is no quote when there is none', () => {
    expect(run('<p>Just a note.</p>', { quotes: false }).hasQuote).toBe(false);
  });
});

describe('sanitising email HTML: Outlook’s bodies (#136)', () => {
  // Dana's message as Graph sends it (the Outlook adapter's recording): a whole Word-made document,
  // with conditional comments, VML, Office's `o:p` tags, an inline logo and a tracking pixel.
  const outlook = (
    firstSync as { response: { body: { value?: { id: string; body?: { content: string } }[] } } }[]
  )
    .flatMap((exchange) => exchange.response.body.value ?? [])
    .find((message) => message.id === 'AAMkAGI2-msg-offsite-1=')?.body?.content as string;

  it('shows the text, without Office’s own markup, conditional comments or VML behaviours', () => {
    const { html } = run(outlook);
    const shown = parse(html);
    expect(shown.body.textContent).toContain('Which dates work for you for the Q4 offsite?');
    expect(html).not.toMatch(/<o:p|\[if |behavior|urn:schemas-microsoft-com/i);
    expect(shown.querySelectorAll('p.MsoNormal').length).toBeGreaterThan(0);
  });

  it('serves its inline logo from the message’s parts and holds its tracking pixel back', () => {
    const result = run(outlook);
    const images = [...parse(result.html).body.querySelectorAll('img[src]')].map((img) =>
      img.getAttribute('src'),
    );
    // The reader matches it to the part by its normalised Content-ID.
    expect(images).toEqual([
      `commander-mail://part/${TOKEN}/${encodeURIComponent('image001.png@01DB1A2B.3C4D5E60')}`,
    ]);
    expect(result.remoteImages).toEqual([]);
    expect(result.heldImages).toBe(1);
  });
});

describe('sanitising email HTML: robustness', () => {
  it('copes with an empty body, a fragment, and plain text', () => {
    expect(() => run('')).not.toThrow();
    expect(parse(run('just words').html).body.textContent).toContain('just words');
    expect(parse(run('<td>orphan cell</td>').html).body.textContent).toContain('orphan cell');
  });

  it('copes with very deep nesting', () => {
    const deep = `${'<div>'.repeat(2000)}deep${'</div>'.repeat(2000)}`;
    const result = run(deep);
    expectSafe(result.html, 'deep');
    expect(parse(result.html).body.textContent).toContain('deep');
  });

  it('refuses HTML nested deeper than any real email, rather than block on it', () => {
    const deep = `${'<div>'.repeat(NESTING_MAX + 1)}x${'</div>'.repeat(NESTING_MAX + 1)}`;
    expect(() => run(deep)).toThrow(TooComplex);
    expect(nestingDepth('<p><br><img src=x><b>x</b></p><hr/>')).toBe(2);
    expect(nestingDepth('<div><span></span></div><div></div>')).toBe(2);
  });

  it('names at most 50 distinct inline images (each may cost a request to the Source)', () => {
    const html = Array.from({ length: 80 }, (_, i) => `<img src="cid:part${i}@x">`).join('');
    const sources = [...parse(run(html).html).body.querySelectorAll('img[src]')];
    expect(sources).toHaveLength(CONTENT_IDS_MAX);
  });

  it('estimates nesting the way the parser builds it', () => {
    expect(nestingDepth('<div></x>'.repeat(10))).toBe(10);
    expect(nestingDepth('<p>a<p>b<p>c')).toBe(1);
    expect(nestingDepth('<ul><li>a<li>b</ul>')).toBe(2);
  });

  it('gives the same answer twice (no state left between messages)', () => {
    const first = run('<img src="https://a.test/1.png"><img src="https://a.test/2.png">', {
      images: 'shown',
    });
    const second = run('<img src="https://b.test/9.png">', { images: 'shown' });
    expect(first.remoteImages).toEqual(['https://a.test/1.png', 'https://a.test/2.png']);
    expect(second.remoteImages).toEqual(['https://b.test/9.png']);
  });
});
