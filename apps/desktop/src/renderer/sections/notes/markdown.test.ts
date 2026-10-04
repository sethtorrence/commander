// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  blockHtml,
  headingLevel,
  linkSelection,
  parseBlock,
  pastedUrl,
  type Span,
  toggleMark,
} from './markdown';

// Spans written compactly: marks as `{…}`, styled runs as tag(…).
function show(spans: Span[]): string {
  return spans
    .map((span) => {
      switch (span.type) {
        case 'text':
          return span.text;
        case 'mark':
          return `{${span.text}}`;
        case 'link':
          return `link<${span.href}>(${show(span.children)})`;
        case 'chip':
          return `chip<${span.text}>`;
        default:
          return `${span.type}(${show(span.children)})`;
      }
    })
    .join('');
}

const parsed = (text: string) => show(parseBlock(text).spans);

describe('a Block in Markdown', () => {
  it.each([
    ['plain words', 'plain words'],
    ['**bold**', 'strong({**}bold{**})'],
    ['*italic*', 'em({*}italic{*})'],
    ['`code`', 'code({`}code{`})'],
    ['a **b** c *d* e `f` g', 'a strong({**}b{**}) c em({*}d{*}) e code({`}f{`}) g'],
    ['***both***', 'strong({**}em({*}both{*}){**})'],
    ['**bold *and italic***', 'strong({**}bold em({*}and italic{*}){**})'],
    ['*italic **and bold***', 'em({*}italic strong({**}and bold{**}){*})'],
    ['`**not bold**`', 'code({`}**not bold**{`})'],
    ['**`code` in bold**', 'strong({**}code({`}code{`}) in bold{**})'],
  ])('reads %j', (text, expected) => {
    expect(parsed(text)).toBe(expected);
  });

  it.each([
    '**',
    '****',
    '** not bold **',
    '**unclosed',
    '*',
    '* not italic *',
    '2 * 3 * 4',
    '`',
    '``',
    'unclosed `code',
    'snake_case_name',
  ])('leaves %j as plain text', (text) => {
    expect(parsed(text)).toBe(text);
  });

  it('takes a backslash before a mark as the mark itself', () => {
    expect(parsed('\\*not italic\\*')).toBe('{\\}*not italic{\\}*');
    expect(parsed('\\`x\\`')).toBe('{\\}`x{\\}`');
  });

  describe('links', () => {
    it.each([
      ['[Commander](https://example.com)', 'link<https://example.com>({[}Commander{](https://example.com)})'],
      [
        'see [the **plan**](https://x.dev/p) now',
        'see link<https://x.dev/p>({[}the strong({**}plan{**}){](https://x.dev/p)}) now',
      ],
      [
        '[mail me](mailto:me@example.com)',
        'link<mailto:me@example.com>({[}mail me{](mailto:me@example.com)})',
      ],
    ])('reads %j', (text, expected) => {
      expect(parsed(text)).toBe(expected);
    });

    it.each([
      ['https://example.com', 'link<https://example.com>(https://example.com)'],
      ['go to http://x.dev/a?b=c#d now', 'go to link<http://x.dev/a?b=c#d>(http://x.dev/a?b=c#d) now'],
      ['(see https://example.com/a).', '(see link<https://example.com/a>(https://example.com/a)).'],
      [
        'https://en.wikipedia.org/wiki/Foo_(bar)',
        'link<https://en.wikipedia.org/wiki/Foo_(bar)>(https://en.wikipedia.org/wiki/Foo_(bar))',
      ],
      [
        'Read https://example.com, then rest.',
        'Read link<https://example.com>(https://example.com), then rest.',
      ],
      ['**https://example.com**', 'strong({**}link<https://example.com>(https://example.com){**})'],
    ])('linkifies a bare URL in %j', (text, expected) => {
      expect(parsed(text)).toBe(expected);
    });

    it.each(['https://', 'xhttps://example.com', 'ftp://example.com', '`https://example.com`'])(
      'does not linkify %j',
      (text) => {
        expect(parsed(text)).not.toContain('link<');
      },
    );
  });

  describe('headings', () => {
    it.each([
      ['# Morning', 1, '{# }Morning'],
      ['## Meetings', 2, '{## }Meetings'],
      ['### Notes on **this**', 3, '{### }Notes on strong({**}this{**})'],
      ['# ', 1, '{# }'],
    ])('reads %j as a heading', (text, level, spans) => {
      expect(headingLevel(text)).toBe(level);
      expect(parseBlock(text).heading).toBe(level);
      expect(parsed(text)).toBe(spans);
    });

    it.each([
      '#LT',
      '#LT fix the build',
      '##LT',
      '#',
      '#### too deep',
      ' # indented',
      'Not # a heading',
      '\\# escaped',
    ])('leaves %j as text', (text) => {
      expect(headingLevel(text)).toBe(0);
      expect(parsed(text)).not.toMatch(/^\{#/);
    });
  });

  it('knows an image Block', () => {
    const name = `${'a'.repeat(64)}.png`;
    expect(parseBlock(`![](attachments/${name})`).image).toBe(name);
    expect(parseBlock('just text').image).toBeNull();
  });
});

describe('the rendered row', () => {
  const render = (text: string) => {
    const element = document.createElement('div');
    element.innerHTML = blockHtml(text);
    return element;
  };

  it.each([
    'plain',
    '**bold** and *italic* and `code`',
    '# Heading with [a link](https://example.com)',
    'bare https://example.com/x?y=1&z=<2> link',
    '<script>alert("x")</script> & "quotes"',
    'line one\nline two\n',
    '\\*escaped\\*',
    '#LT shorthand',
  ])('holds exactly the stored text of %j, so the caret and saving see the Markdown', (text) => {
    expect(render(text).textContent).toBe(text);
  });

  it('holds exactly the stored text of any mix of marks', () => {
    const alphabet = [
      '*',
      '**',
      '`',
      '[',
      ']',
      '(',
      ')',
      '# ',
      '#',
      ' ',
      'a',
      '\\',
      'https://x.dev',
      '\n',
      '<',
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: next() % 14 }, () => alphabet[next() % alphabet.length]).join('');
      expect(render(text).textContent).toBe(text);
    }
  });

  it('shows marks as marks, and styles what they mark', () => {
    const element = render('**b** *i* `c`');
    expect([...element.querySelectorAll('.n-mk')].map((m) => m.textContent)).toEqual([
      '**',
      '**',
      '*',
      '*',
      '`',
      '`',
    ]);
    expect(element.querySelector('strong')?.textContent).toBe('**b**');
    expect(element.querySelector('em')?.textContent).toBe('*i*');
    expect(element.querySelector('code')?.textContent).toBe('`c`');
  });

  it('marks a link with where it goes, without making it something the page could follow', () => {
    const element = render('[x](https://example.com/?a="b") and https://e.dev');
    const links = [...element.querySelectorAll<HTMLElement>('[data-href]')];
    expect(links.map((link) => link.dataset.href)).toEqual(['https://example.com/?a="b"', 'https://e.dev']);
    expect(element.querySelector('a')).toBeNull();
  });

  it('never turns text into markup', () => {
    const element = render('<img src=x onerror=alert(1)> **<b>x</b>**');
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('b')).toBeNull();
  });

  it('ends a Block that ends with a new line with a break, so the empty line shows', () => {
    expect(blockHtml('a\n').endsWith('<br>')).toBe(true);
    expect(blockHtml('a').endsWith('<br>')).toBe(false);
  });
});

describe('formatting shortcuts', () => {
  it('wraps the selection in the mark and keeps it selected', () => {
    expect(toggleMark('make this bold', 5, 9, '**')).toEqual({
      text: 'make **this** bold',
      start: 7,
      end: 11,
    });
    expect(toggleMark('make this italic', 5, 9, '*')).toEqual({
      text: 'make *this* italic',
      start: 6,
      end: 10,
    });
    expect(toggleMark('run npm test', 4, 12, '`')).toEqual({ text: 'run `npm test`', start: 5, end: 13 });
  });

  it('leaves the spaces around a selection outside the marks', () => {
    expect(toggleMark('make this bold', 4, 10, '**')).toEqual({
      text: 'make **this** bold',
      start: 7,
      end: 11,
    });
  });

  it('unwraps a selection that is already marked', () => {
    expect(toggleMark('make **this** bold', 7, 11, '**')).toEqual({
      text: 'make this bold',
      start: 5,
      end: 9,
    });
    expect(toggleMark('make **this** bold', 5, 13, '**')).toEqual({
      text: 'make this bold',
      start: 5,
      end: 9,
    });
    expect(toggleMark('make *this* italic', 6, 10, '*')).toEqual({
      text: 'make this italic',
      start: 5,
      end: 9,
    });
  });

  it('does not take bold for italic', () => {
    expect(toggleMark('make **this** bold', 7, 11, '*')).toEqual({
      text: 'make ***this*** bold',
      start: 8,
      end: 12,
    });
    expect(toggleMark('make ***this*** bold', 8, 12, '*')).toEqual({
      text: 'make **this** bold',
      start: 7,
      end: 11,
    });
  });

  it('with nothing selected, puts the caret between a new pair of marks', () => {
    expect(toggleMark('ab', 1, 1, '**')).toEqual({ text: 'a****b', start: 3, end: 3 });
    expect(toggleMark('', 0, 0, '`')).toEqual({ text: '``', start: 1, end: 1 });
  });

  it('with the caret between an empty pair, takes the pair away again', () => {
    expect(toggleMark('a****b', 3, 3, '**')).toEqual({ text: 'ab', start: 1, end: 1 });
  });
});

describe('pasting a link', () => {
  it('knows a pasted URL', () => {
    expect(pastedUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(pastedUrl('  https://example.com/a\n')).toBe('https://example.com/a');
    expect(pastedUrl('mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(pastedUrl('see https://example.com')).toBeNull();
    expect(pastedUrl('javascript:alert(1)')).toBeNull();
    expect(pastedUrl('plain words')).toBeNull();
  });

  it('makes the selected text a link to the pasted URL, with the caret after it', () => {
    expect(linkSelection('read the plan today', 5, 13, 'https://x.dev/plan')).toEqual({
      text: 'read [the plan](https://x.dev/plan) today',
      start: 35,
      end: 35,
    });
  });

  it('does nothing without a selection', () => {
    expect(linkSelection('abc', 1, 1, 'https://x.dev')).toBeNull();
  });
});
