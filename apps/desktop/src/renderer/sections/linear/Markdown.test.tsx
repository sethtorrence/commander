// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

// Linear descriptions and comments, rendered read-only from their Markdown: never as HTML, links open
// in the system browser (through the window's new-window handler), and remote images never load.

afterEach(cleanup);

describe('rendering Markdown read-only', () => {
  it('draws paragraphs, emphasis, code, headings, lists, quotes and code blocks', () => {
    const { container } = render(
      <Markdown
        source={[
          '## Steps',
          '',
          'The login page **loops** after _SSO_, see `auth.ts`.',
          '',
          '1. Sign in',
          '2. Watch it ~~work~~ loop',
          '',
          '- [x] Reproduced',
          '- [ ] Fixed',
          '',
          '> Seen on staging',
          '',
          '```ts',
          'const a = 1 < 2;',
          '```',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Steps' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('loops');
    expect(container.querySelector('em')?.textContent).toBe('SSO');
    expect(container.querySelector('p code')?.textContent).toBe('auth.ts');
    expect(container.querySelector('del')?.textContent).toBe('work');
    expect([...container.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual([
      'Sign in',
      'Watch it work loop',
    ]);
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(container.querySelector('blockquote')?.textContent).toBe('Seen on staging');
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1 < 2;');
  });

  it('turns links into links that open outside Commander, and bare URLs too', () => {
    render(<Markdown source="See [the runbook](https://acme.test/runbook) or https://status.acme.test" />);

    const runbook = screen.getByRole('link', { name: 'the runbook' });
    expect(runbook.getAttribute('href')).toBe('https://acme.test/runbook');
    expect(runbook.getAttribute('target')).toBe('_blank');
    expect(runbook.getAttribute('rel')).toBe('noreferrer');
    expect(screen.getByRole('link', { name: 'https://status.acme.test' })).toBeTruthy();
  });

  it('never makes a link of anything but a web or mail address', () => {
    const { container } = render(
      <Markdown source="[click](javascript:alert(1)) [file](file:///etc/passwd)" />,
    );

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('click');
  });

  it('shows images as links to them, so a remote image is never fetched', () => {
    const { container } = render(
      <Markdown source="![Screenshot of the loop](https://uploads.linear.app/acme/loop.png)" />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    const link = screen.getByRole('link', { name: /Screenshot of the loop/ });
    expect(link.getAttribute('href')).toBe('https://uploads.linear.app/acme/loop.png');
  });

  it('shows raw HTML as the text it is, never as HTML', () => {
    const { container } = render(
      <Markdown
        source={
          '<img src="https://tracker.test/pixel.gif" onerror="alert(1)">\n\nA <b>bold</b> &amp; brave move'
        }
      />,
    );

    expect(container.querySelectorAll('img, b, script')).toHaveLength(0);
    expect(container.textContent).toContain('<img src="https://tracker.test/pixel.gif" onerror="alert(1)">');
    expect(container.textContent).toContain('A <b>bold</b> & brave move');
  });
});
