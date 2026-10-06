import {
  type ComposeBlock,
  type ComposeBody,
  type ComposeRun,
  isComposeLink,
  plainBody,
} from '@commander/domain';
import { JSDOM } from 'jsdom';

// A draft made in Gmail or Outlook (#138) as the composer's body: its HTML read into the composer's
// own model (paragraphs and lists of runs, bold, italic and links to web and mail addresses only), so
// nothing it holds (styles, images, scripts) ever reaches the window. jsdom parses it without running
// anything. What the model can't hold (tables, colours, images) comes through as its text.

// The most of a draft's HTML read.
const HTML_MAX = 1_000_000;
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'tr',
  'center',
]);
const SKIPPED = new Set([
  'script',
  'style',
  'head',
  'title',
  'template',
  'noscript',
  'iframe',
  'object',
  'svg',
  'math',
]);

type Marks = { bold: boolean; italic: boolean; href: string | null };

/** A draft's HTML as the composer's body (its text, a paragraph a line, when there is no HTML). */
export function bodyFromHtml(html: string | null, text: string): ComposeBody {
  if (!html?.trim()) return plainBody(text.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  const { document } = new JSDOM(html.slice(0, HTML_MAX)).window;
  const blocks: ComposeBlock[] = [];
  let runs: ComposeRun[] = [];
  const flush = () => {
    // Runs of only spaces between blocks make no paragraph.
    if (runs.some((run) => run.text.trim()) || (runs.length && runs.every((run) => run.text === ''))) {
      blocks.push({ type: 'paragraph', runs: merge(runs) });
    }
    runs = [];
  };
  const push = (text: string, marks: Marks) => {
    if (!text) return;
    runs.push({
      text,
      ...(marks.bold ? { bold: true } : {}),
      ...(marks.italic ? { italic: true } : {}),
      ...(marks.href ? { href: marks.href } : {}),
    });
  };

  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === 3) {
      push((node.textContent ?? '').replace(/\s+/g, ' '), marks);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return;
    if (tag === 'br') {
      flush();
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const items: ComposeRun[][] = [];
      for (const child of element.children) {
        if (child.tagName.toLowerCase() !== 'li') continue;
        const saved = runs;
        runs = [];
        for (const each of child.childNodes) walk(each, marks);
        items.push(merge(trim(runs)));
        runs = saved;
      }
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
      return;
    }
    const next: Marks = {
      bold: marks.bold || tag === 'b' || tag === 'strong',
      italic: marks.italic || tag === 'i' || tag === 'em',
      href: marks.href,
    };
    if (tag === 'a') {
      const href = element.getAttribute('href')?.trim() ?? '';
      next.href = isComposeLink(href) ? href : null;
    }
    const block = BLOCKS.has(tag);
    if (block) flush();
    for (const child of element.childNodes) walk(child, next);
    if (block) flush();
  };
  for (const child of document.body.childNodes) walk(child, { bold: false, italic: false, href: null });
  flush();
  return blocks.length
    ? blocks.map((block) => (block.type === 'paragraph' ? { ...block, runs: trim(block.runs) } : block))
    : plainBody(text);
}

// Neighbouring runs with the same marks joined.
function merge(runs: ComposeRun[]): ComposeRun[] {
  const out: ComposeRun[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic && last.href === run.href)
      out[out.length - 1] = { ...last, text: last.text + run.text };
    else out.push(run);
  }
  return out;
}

// A paragraph's spaces at its start and end gone.
function trim(runs: ComposeRun[]): ComposeRun[] {
  const out = runs.map((run) => ({ ...run }));
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, '');
  const last = out.at(-1);
  if (last) last.text = last.text.replace(/\s+$/, '');
  return out.filter((run) => run.text !== '' || out.length === 1);
}
