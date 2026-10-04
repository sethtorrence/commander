import { safeMailto } from '@commander/domain';
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';
import { JSDOM } from 'jsdom';
import { cssSanitiser } from './css';
import { foldQuotes } from './quotes';

// Email HTML, sanitised for the reader's frame (#134). The sender wrote it, so nothing in it is
// trusted (ADR 0004). This is the first of the reader's layers, not the only one: the frame is
// sandboxed without scripts, its document has a CSP of its own, and the network is closed to it at
// the session, so a miss here still runs nothing and loads nothing. What this layer adds is that the
// document never even asks: it is parsed by a spec-following parser (jsdom's parse5) and cleaned by
// DOMPurify, with an allowlist narrowed for email:
//
// - HTML only: no SVG or MathML (and with them the namespace-confusion mutation tricks);
// - no scripts, event handlers, frames, objects, forms or form controls, media, <meta>, <base>,
//   <link>, <template>, raw-text elements (noscript, xmp, noembed…) or comments;
// - links: only web and mail addresses, each opening a new window (which the main process sends to
//   the system browser) with no referrer, and no pings;
// - images: a remote image becomes Commander's image handler (`imageUrl(n)`) when images are shown,
//   or a quiet placeholder of the same size with no URL at all when they are held back; `cid:` images
//   become the message's own part (`partUrl`); anything else (data:, relative, file:…) is dropped,
//   as are srcset, background images in CSS that aren't allowed, and every other attribute that
//   names something to load;
// - CSS is parsed and rebuilt by css.ts.
//
// The result is a whole document of Commander's own: UTF-8, no referrer, a light colour scheme, the
// email's style sheets in its head and its body as sanitised.

export type SanitizeOptions = {
  // Whether the message's remote images are shown (through Commander's image handler) or held back.
  images: 'shown' | 'held';
  // Keep quoted history (false folds it away; see quotes.ts).
  quotes: boolean;
  // Commander's URL for the n-th distinct remote image.
  imageUrl: (index: number) => string;
  // Commander's URL for an inline part, by its Content-ID.
  partUrl: (contentId: string) => string;
  // The most distinct remote images named (500).
  maxRemoteImages?: number;
};

export type SanitizedEmail = {
  // The whole document.
  html: string;
  // The distinct remote images it names, by index (empty when held back).
  remoteImages: string[];
  // How many distinct remote images were held back.
  heldImages: number;
  // It has quoted history (folded away unless `quotes`).
  hasQuote: boolean;
};

const FORBID_TAGS = [
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
  'option',
  'optgroup',
  'textarea',
  'datalist',
  'output',
  'keygen',
  'isindex',
  'meta',
  'base',
  'link',
  'title',
  'noscript',
  'noembed',
  'noframes',
  'xmp',
  'plaintext',
  'template',
  'slot',
  'portal',
  'dialog',
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
  'picture',
];
const FORBID_ATTR = [
  'ping',
  'srcset',
  'sizes',
  'srcdoc',
  'action',
  'formaction',
  'method',
  'enctype',
  'form',
  'target',
  'download',
  'http-equiv',
  'content',
  'charset',
  'manifest',
  'cite',
  'longdesc',
  'lowsrc',
  'dynsrc',
  'poster',
  'usemap',
  'ismap',
  'crossorigin',
  'referrerpolicy',
  'loading',
  'fetchpriority',
  'integrity',
  'nonce',
  'autofocus',
  'contenteditable',
  'popover',
  'popovertarget',
  'popovertargetaction',
  'is',
  'slot',
  'part',
  'exportparts',
  'codebase',
  'code',
  'archive',
  'classid',
  'data',
  'xmlns',
];
// DOMPurify's own URI check, narrowed to the schemes email uses: values with no scheme pass (sizes,
// colours, words), and those with one only as http(s), mailto or cid. The handlers below then decide
// exactly what each URL attribute may hold.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
// Attributes that name a URL and are handled here (anything else naming one is forbidden above).
const URL_ATTRIBUTES = new Set(['href', 'src', 'background']);
// Longer remote URLs are dropped.
const URL_MAX = 8192;

const BASE_CSS = [
  'html { background: #fff; color: #1f2023; color-scheme: light; }',
  'body { margin: 0; padding: 16px 20px; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow-wrap: break-word; }',
  'img[data-commander-held] { background: #f1f1f1; outline: 1px dashed #c9c9c9; outline-offset: -1px; min-width: 16px; min-height: 16px; }',
  'a { cursor: pointer; }',
].join('\n');

type Reference = { kind: 'remote'; url: string } | { kind: 'cid'; contentId: string };

// What a URL in the email names: a web address (protocol-relative ones over https), a Content-ID, or
// nothing usable (null).
function referenceOf(raw: string): Reference | null {
  const value = raw.trim();
  if (/^cid:/i.test(value)) {
    let contentId = value.slice(4).trim();
    try {
      contentId = decodeURIComponent(contentId);
    } catch {
      // Not percent-encoded after all: use it as written.
    }
    return contentId ? { kind: 'cid', contentId } : null;
  }
  let url: URL;
  try {
    url = new URL(value.startsWith('//') ? `https:${value}` : value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.href.length > URL_MAX) return null;
  return { kind: 'remote', url: url.href };
}

// A link's destination: web and mail addresses only.
function linkOf(raw: string): string | null {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value.startsWith('//') ? `https:${value}` : value);
  } catch {
    return null;
  }
  if (url.protocol === 'mailto:') return safeMailto(url.href);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.href.length > URL_MAX) return null;
  return url.href;
}

// One sanitising pass: what it has found so far.
type Pass = {
  options: SanitizeOptions;
  remote: Map<string, number>;
  remoteImages: string[];
  held: Set<string>;
  // Distinct Content-IDs named (each may cost a request to the Source to find).
  contentIds: Set<string>;
  max: number;
};

// More inline (cid:) images than any real email names; the rest are dropped.
export const CONTENT_IDS_MAX = 50;

let purifier: DOMPurify | null = null;
let pass: Pass | null = null;

const current = (): Pass => {
  if (!pass) throw new Error('No sanitising pass under way');
  return pass;
};

// Commander's URL for an image the email names, or null when it is held back or not allowed.
function imageRef(raw: string): string | null {
  const state = current();
  const reference = referenceOf(raw);
  if (!reference) return null;
  if (reference.kind === 'cid') {
    const key = reference.contentId.trim().toLowerCase();
    if (!state.contentIds.has(key)) {
      if (state.contentIds.size >= CONTENT_IDS_MAX) return null;
      state.contentIds.add(key);
    }
    return state.options.partUrl(reference.contentId);
  }
  if (state.options.images === 'held') {
    if (state.held.size < state.max) state.held.add(reference.url);
    return null;
  }
  let index = state.remote.get(reference.url);
  if (index === undefined) {
    if (state.remoteImages.length >= state.max) return null;
    index = state.remoteImages.length;
    state.remoteImages.push(reference.url);
    state.remote.set(reference.url, index);
  }
  return state.options.imageUrl(index);
}

// Whether a url() in generated CSS is one of Commander's own (the last check on CSS as text).
function isOwnUrl(url: string): boolean {
  return url.startsWith('commander-mail://image/') || url.startsWith('commander-mail://part/');
}

const css = cssSanitiser(imageRef, isOwnUrl);

function setUp(): DOMPurify {
  const { window } = new JSDOM('');
  const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      // Rebuilt from what is allowed, with "<" escaped, before DOMPurify looks at its text.
      node.textContent = css.stylesheet(node.textContent);
    }
  });

  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style') {
      const cleaned = css.declarations(data.attrValue);
      if (cleaned) data.attrValue = cleaned;
      else data.keepAttr = false;
    }
  });

  purify.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element;
    if (typeof element.getAttribute !== 'function') return;
    const tag = element.localName;
    for (const name of URL_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      if (name === 'href' && tag === 'a') {
        const href = linkOf(value);
        if (href) element.setAttribute('href', href);
        else element.removeAttribute('href');
      } else if ((name === 'src' && tag === 'img') || name === 'background') {
        const ref = imageRef(value);
        if (ref) element.setAttribute(name, ref);
        else {
          element.removeAttribute(name);
          if (name === 'src' && referenceOf(value)?.kind === 'remote' && current().options.images === 'held')
            element.setAttribute('data-commander-held', '');
        }
      } else element.removeAttribute(name);
    }
    if (tag === 'a') {
      if (element.hasAttribute('href')) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      } else element.removeAttribute('rel');
    }
  });
  return purify;
}

const CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  RETURN_DOM: true,
  USE_PROFILES: { html: true },
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOWED_URI_REGEXP,
  KEEP_CONTENT: true,
  SAFE_FOR_XML: true,
};

// Browsers stop nesting at 512 elements deep (Chromium hangs deeper ones on the 512th), and the
// serialiser recurses, so elements nested deeper than this are unwrapped: their content stays, at
// this depth.
const DEPTH_MAX = 400;

function flattenDeep(body: Element) {
  const depth = new Map<Node, number>([[body, 0]]);
  const deep: Element[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, 1 /* NodeFilter.SHOW_ELEMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const level = (depth.get(node.parentNode as Node) ?? 0) + 1;
    depth.set(node, level);
    if (level > DEPTH_MAX) deep.push(node as Element);
  }
  // Deepest first, so each one's content moves up to a parent that stays.
  for (const element of deep.reverse()) element.replaceWith(...element.childNodes);
}

function serialise(root: Element): string {
  const document = root.ownerDocument;
  const styles = [...root.querySelectorAll('head style')]
    .map((style) => style.textContent ?? '')
    .filter((text) => text.trim());
  const body = root.querySelector('body') ?? document.createElement('body');
  // Comments are never kept (Outlook's conditional ones carry markup for its own renderer).
  const comments = document.createTreeWalker(body, 128 /* NodeFilter.SHOW_COMMENT */);
  const found: Node[] = [];
  for (let node = comments.nextNode(); node; node = comments.nextNode()) found.push(node);
  for (const node of found) node.parentNode?.removeChild(node);
  return [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light">',
    `<style>${BASE_CSS}</style>`,
    ...styles.map((text) => `<style>${text}</style>`),
    '</head>',
    body.outerHTML,
    '</html>',
  ].join('');
}

// Parsing and sanitising slow down sharply with nesting (20,000 nested elements take half a minute,
// all of it blocking the Core), so HTML nested deeper than this, which no real email is, is refused
// and the message is read as text instead.
export const NESTING_MAX = 3000;
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  'keygen',
  'isindex',
  'basefont',
  'bgsound',
  'frame',
  'spacer',
]);

// Elements the parser closes when another of the same kind opens (an unclosed <p>, <li>, <td>…).
const SELF_CLOSING_SIBLINGS = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'option',
  'optgroup',
  'thead',
  'tbody',
  'tfoot',
  'rp',
  'rt',
]);

/**
 * How deep the HTML's elements nest at most, as one linear scan of its tags estimates it, the way the
 * parser would: a closing tag closes the innermost open element of its name (and those inside it), and
 * is ignored when none is open; an unclosed <p>, <li>, <td>… closes when the next of its kind opens.
 * The scan stops as soon as it passes `limit`.
 */
export function nestingDepth(html: string, limit = Number.POSITIVE_INFINITY): number {
  const stack: string[] = [];
  const open = new Map<string, number>();
  const push = (name: string) => {
    stack.push(name);
    open.set(name, (open.get(name) ?? 0) + 1);
  };
  const popTo = (name: string) => {
    while (stack.length) {
      const top = stack.pop() as string;
      open.set(top, (open.get(top) ?? 1) - 1);
      if (top === name) return;
    }
  };
  let max = 0;
  let at = 0;
  for (;;) {
    const start = html.indexOf('<', at);
    if (start < 0) break;
    let i = start + 1;
    const closing = html[i] === '/';
    if (closing) i += 1;
    let end = i;
    while (end < html.length && /[A-Za-z0-9:-]/.test(html[end] as string)) end += 1;
    if (end === i || !/[A-Za-z]/.test(html[i] as string)) {
      at = start + 1;
      continue;
    }
    const name = html.slice(i, end).toLowerCase();
    const close = html.indexOf('>', end);
    if (close < 0) break;
    at = close + 1;
    if (closing) {
      if ((open.get(name) ?? 0) > 0) popTo(name);
      continue;
    }
    if (html[close - 1] === '/' || VOID.has(name)) continue;
    if (SELF_CLOSING_SIBLINGS.has(name) && (open.get(name) ?? 0) > 0) popTo(name);
    push(name);
    if (stack.length > max) {
      max = stack.length;
      if (max > limit) break;
    }
  }
  return max;
}

export class TooComplex extends Error {
  override name = 'TooComplex';
}

/** Sanitises an email's HTML into a document for the reader's frame (see above). */
export function sanitizeEmailHtml(html: string, options: SanitizeOptions): SanitizedEmail {
  if (nestingDepth(html, NESTING_MAX) > NESTING_MAX)
    throw new TooComplex('This message’s HTML is nested too deeply to show.');
  purifier ??= setUp();
  pass = {
    options,
    remote: new Map(),
    remoteImages: [],
    held: new Set(),
    contentIds: new Set(),
    max: options.maxRemoteImages ?? 500,
  };
  try {
    const root = purifier.sanitize(html, CONFIG) as unknown as Element;
    const body = root.querySelector('body');
    if (body) flattenDeep(body);
    const hasQuote = body ? foldQuotes(body, { remove: !options.quotes }) : false;
    return {
      html: serialise(root),
      remoteImages: pass.remoteImages,
      heldImages: pass.held.size,
      hasQuote,
    };
  } finally {
    pass = null;
  }
}
