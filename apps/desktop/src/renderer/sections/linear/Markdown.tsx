import { cn } from '@commander/ui';
import { marked, type Token, type Tokens } from 'marked';
import { type ReactNode, useMemo } from 'react';

/*
  Read-only Markdown, for Linear descriptions and comments. marked only parses (its lexer); the
  tokens become React elements here, so nothing is ever set as HTML: raw HTML shows as the text it
  is, only web and mail addresses become links (opened in the system browser through the window's
  new-window handler, see main/external-links.ts), and images become links to them, so a remote
  image is never fetched (the window's CSP would refuse it anyway).
*/

const linkable = (href: string) => /^(https?:|mailto:)/i.test(href.trim());

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// marked leaves entities in text as they were typed; show them as the characters they stand for.
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const linkClass =
  'text-ink underline decoration-line underline-offset-2 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal';

function ExternalLink({
  href,
  title,
  children,
}: {
  href: string;
  title?: string | null;
  children: ReactNode;
}) {
  return (
    <a href={href} title={title ?? undefined} target="_blank" rel="noreferrer" className={linkClass}>
      {children}
    </a>
  );
}

function inline(tokens: readonly Token[] | undefined, key = ''): ReactNode[] {
  return (tokens ?? []).map((token, index) => inlineToken(token, `${key}${index}`));
}

function inlineToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'strong':
      return <strong key={key}>{inline(token.tokens, `${key}.`)}</strong>;
    case 'em':
      return <em key={key}>{inline(token.tokens, `${key}.`)}</em>;
    case 'del':
      return <del key={key}>{inline(token.tokens, `${key}.`)}</del>;
    case 'codespan':
      return (
        <code key={key} className="border border-line2 bg-raise px-1 font-mono text-[0.88em]">
          {decode(token.text)}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'link': {
      const { href, title } = token as Tokens.Link;
      const children = inline(token.tokens, `${key}.`);
      if (!linkable(href)) return <span key={key}>{children}</span>;
      return (
        <ExternalLink key={key} href={href} title={title}>
          {children}
        </ExternalLink>
      );
    }
    case 'image': {
      const { href, text } = token as Tokens.Image;
      const label = `Image: ${decode(text) || href}`;
      if (!linkable(href)) return <span key={key}>[{label}]</span>;
      return (
        <ExternalLink key={key} href={href} title="Opens the image in your browser">
          [{label}]
        </ExternalLink>
      );
    }
    case 'text':
      // A list item's text holds its own inline tokens.
      if (token.tokens?.length) return <span key={key}>{inline(token.tokens, `${key}.`)}</span>;
      return <span key={key}>{decode(token.text)}</span>;
    case 'escape':
      return <span key={key}>{token.text}</span>;
    case 'checkbox':
      return (
        <input
          key={key}
          type="checkbox"
          checked={(token as Tokens.Checkbox).checked}
          disabled
          readOnly
          className="mr-1.5 align-[-1px] accent-ink"
        />
      );
    default:
      // Raw HTML, and anything marked adds later: shown as typed.
      return <span key={key}>{token.raw}</span>;
  }
}

function block(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
      return (
        <p key={key} className="my-0 mb-3 last:mb-0">
          {inline(token.tokens, `${key}.`)}
        </p>
      );
    case 'heading': {
      const { depth } = token as Tokens.Heading;
      const Tag = (['h3', 'h3', 'h4', 'h5', 'h5', 'h5'] as const)[depth - 1] ?? 'h5';
      return (
        <Tag
          key={key}
          className={cn(
            'mt-4 mb-2 font-sans font-bold text-ink first:mt-0',
            depth <= 2 ? 'text-intro leading-tight' : 'text-row leading-tight',
          )}
        >
          {inline(token.tokens, `${key}.`)}
        </Tag>
      );
    }
    case 'list': {
      const list = token as Tokens.List;
      const Tag = list.ordered ? 'ol' : 'ul';
      return (
        <Tag
          key={key}
          start={list.ordered && list.start !== '' && list.start !== 1 ? list.start : undefined}
          className={cn('my-0 mb-3 pl-5 last:mb-0', list.ordered ? 'list-decimal' : 'list-disc')}
        >
          {list.items.map((item, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their place
              key={index}
              className={cn('mb-1 [&>p]:mb-1', item.task && 'list-none -ml-5')}
            >
              {item.tokens.map((child, i) =>
                child.type === 'text' || child.type === 'checkbox'
                  ? inlineToken(child, `${key}.${index}.${i}`)
                  : block(child, `${key}.${index}.${i}`),
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case 'blockquote':
      return (
        <blockquote key={key} className="my-0 mb-3 border-l-2 border-line pl-3 text-muted last:mb-0">
          {(token as Tokens.Blockquote).tokens.map((child, i) => block(child, `${key}.${i}`))}
        </blockquote>
      );
    case 'code':
      return (
        <pre
          key={key}
          className="my-0 mb-3 overflow-x-auto border border-line2 bg-raise px-3 py-2 font-mono text-[12.5px] leading-[1.5] last:mb-0"
        >
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );
    case 'hr':
      return <hr key={key} className="my-4 border-0 border-t border-line" />;
    case 'table': {
      const table = token as Tokens.Table;
      return (
        <div key={key} className="mb-3 overflow-x-auto last:mb-0">
          <table className="border-collapse text-[13.5px]">
            <thead>
              <tr>
                {table.header.map((cell, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no identity beyond their place
                  <th key={i} className="border border-line px-2 py-1 text-left font-semibold text-ink">
                    {inline(cell.tokens, `${key}.h${i}.`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table rows have no identity beyond their place
                <tr key={r}>
                  {row.map((cell, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no identity beyond their place
                    <td key={i} className="border border-line px-2 py-1">
                      {inline(cell.tokens, `${key}.${r}.${i}.`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      return (
        <p key={key} className="my-0 mb-3 whitespace-pre-wrap last:mb-0">
          {token.raw.trimEnd()}
        </p>
      );
    case 'text':
      return (
        <p key={key} className="my-0 mb-3 last:mb-0">
          {token.tokens?.length ? inline(token.tokens, `${key}.`) : decode(token.text)}
        </p>
      );
    default:
      return (
        <p key={key} className="my-0 mb-3 whitespace-pre-wrap last:mb-0">
          {token.raw}
        </p>
      );
  }
}

/** Markdown, drawn read-only. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const tokens = useMemo(() => marked.lexer(source, { gfm: true }), [source]);
  return (
    <div className={cn('text-[14.5px] leading-[1.6] text-text [overflow-wrap:anywhere]', className)}>
      {tokens.map((token, index) => block(token, String(index)))}
    </div>
  );
}
