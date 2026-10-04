// Teams message bodies as Commander keeps them: plain text with light structure, converted from the
// HTML Teams sends. Paragraphs, line breaks, lists, links (with their address) and @mentions are
// kept; scripts, styles, frames and every tag are dropped, and inline images show as "[image]".
// Chat text is untrusted Source content, so nothing of the markup survives to be rendered.

// Elements whose content is never text for the User.
const SKIPPED = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'head',
  'title',
  'svg',
  'math',
]);
const BLOCKS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'table',
  'hr',
  'section',
  'article',
  'header',
  'footer',
]);
const LINE_BREAKS = new Set(['br', 'tr']);
const CELLS = new Set(['td', 'th']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return decode(match[2] ?? match[3] ?? match[4] ?? '');
}

const isSafeLink = (href: string) => /^(https?:|mailto:)/i.test(href.trim());
const sameAddress = (text: string, href: string) => {
  const bare = (value: string) =>
    value
      .trim()
      .replace(/^mailto:/i, '')
      .replace(/\/$/, '');
  return bare(text) === bare(href);
};

export function teamsText(content: string, contentType: 'html' | 'text' = 'html'): string {
  if (contentType === 'text') return content.trim();
  let out = '';
  // Open elements whose content is dropped.
  let skipping: string | null = null;
  let skipDepth = 0;
  // Open lists, innermost last: null for bullets, else the next number.
  const lists: (number | null)[] = [];
  // Open links: where their text starts in `out`, and their address.
  const links: { start: number; href: string | null }[] = [];

  const block = () => {
    out += '\n\n';
  };
  // A tag's attributes may hold a quoted `>` (an address with markup in it), which doesn't end it.
  const tokens = content.matchAll(
    /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g,
  );
  for (const [token, rawName] of tokens) {
    const name = rawName?.toLowerCase();
    const closing = token.startsWith('</');
    if (skipping) {
      if (name === skipping) skipDepth += closing ? -1 : token.endsWith('/>') ? 0 : 1;
      if (skipDepth === 0) skipping = null;
      continue;
    }
    if (token.startsWith('<!--')) continue;
    if (!name) {
      out += decode(token).replace(/\s+/g, ' ');
      continue;
    }
    if (SKIPPED.has(name)) {
      if (!closing && !token.endsWith('/>')) {
        skipping = name;
        skipDepth = 1;
      }
      continue;
    }
    if (BLOCKS.has(name)) block();
    else if (LINE_BREAKS.has(name)) {
      if (!closing) out += '\n';
    } else if (CELLS.has(name)) out += ' ';
    else if (name === 'ul' || name === 'ol') {
      if (closing) lists.pop();
      else lists.push(name === 'ol' ? 1 : null);
      block();
    } else if (name === 'li' && !closing) {
      const number = lists[lists.length - 1];
      const marker = typeof number === 'number' ? `${number}.` : '-';
      if (typeof number === 'number') lists[lists.length - 1] = number + 1;
      out += `\n${marker} `;
    } else if (name === 'img' && !closing) {
      out += ' [image] ';
    } else if (name === 'emoji' && !closing) {
      out += attribute(token, 'alt') ?? '';
    } else if (name === 'at' && !closing) {
      out += '@';
    } else if (name === 'a') {
      if (!closing) {
        const href = attribute(token, 'href');
        links.push({ start: out.length, href: href && isSafeLink(href) ? href.trim() : null });
      } else {
        const link = links.pop();
        if (link?.href) {
          const text = out.slice(link.start).trim();
          if (!text) out += link.href;
          else if (!sameAddress(text, link.href)) out += ` (${link.href})`;
        }
      }
    }
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
