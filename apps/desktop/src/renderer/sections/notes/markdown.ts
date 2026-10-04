import { type BlockLinkTarget, blockLinksIn, imageAttachmentOf, isOpenableLink } from '@commander/domain';
import { chipHtml, type LabelChip } from './chips';

/*
  A Block's formatting is Markdown, kept in the Block's own text: headings (`# `, `## `, `### ` at the
  start), **bold**, *italic*, `inline code`, [links](https://…) and bare URLs, and an image Block
  (`![](attachments/<name>)`, see @commander/domain's attachments). The stored text is the source of
  truth, so it reads the same in the Markdown copy later.

  The row shows that text rendered, with every character of the source still in it: the marks (`**`,
  `# `, `](url)`) sit in their own spans, faint while the Block is being edited and hidden otherwise.
  So the caret's offsets, and what is saved, are always offsets into the Markdown.

  `#` straight before letters (`#LT`) is not a heading: that's the Project shorthand. A `[[` link token
  (`[[2026-10-09]]`, `[[project:<id>]]`) is drawn as a chip (chips.ts), its token kept in it.
*/

export type Span =
  | { type: 'text'; text: string }
  | { type: 'mark'; text: string }
  | { type: 'strong' | 'em' | 'code'; children: Span[] }
  | { type: 'link'; href: string; children: Span[] }
  | { type: 'chip'; text: string; target: BlockLinkTarget };

export interface ParsedBlock {
  /** 1–3 for a heading, 0 for anything else. */
  heading: 0 | 1 | 2 | 3;
  /** The attachment an image Block shows, or null. */
  image: string | null;
  spans: Span[];
}

const HEADING = /^(#{1,3}) /;
// The marks a backslash makes literal.
const ESCAPABLE = new Set(['\\', '*', '`', '[', ']', '#', '!']);
const MARKDOWN_LINK = /^\[([^[\]\n]+)\]\(([^\s()]+)\)/;
const BARE_URL = /^https?:\/\/[^\s<>/][^\s<>]*/i;
const TRAILING = /[.,;:!?'"*_~]$/;

export function headingLevel(text: string): 0 | 1 | 2 | 3 {
  return (HEADING.exec(text)?.[1]?.length ?? 0) as 0 | 1 | 2 | 3;
}

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

// A bare URL without the punctuation that usually follows one; a ")" stays if it closes a "(" in it.
function trimUrl(url: string): string {
  let trimmed = url;
  for (;;) {
    if (TRAILING.test(trimmed)) trimmed = trimmed.slice(0, -1);
    else if (trimmed.endsWith(')') && count(trimmed, '(') < count(trimmed, ')'))
      trimmed = trimmed.slice(0, -1);
    else return trimmed;
  }
}
const count = (text: string, char: string) => text.split(char).length - 1;

// Where the `**` closing one opened at `from` is: the last of a run of asterisks, with no space before it.
function closingStrong(src: string, from: number): number {
  for (let j = src.indexOf('**', from + 3); j !== -1; j = src.indexOf('**', j + 1)) {
    while (src[j + 2] === '*') j++;
    if (!isSpace(src[j - 1])) return j;
  }
  return -1;
}

// Where the `*` closing one opened at `from` is, stepping over `**` pairs inside it.
function closingEm(src: string, from: number): number {
  for (let j = from + 2; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src.startsWith('**', j) && !isSpace(src[j + 2])) {
      const end = closingStrong(src, j);
      if (end === -1) continue;
      // `***` closing both: the bold closes first, then this.
      if (src[end - 1] === '*') return end + 1;
      j = end + 1;
    } else if (src[j] === '*' && !isSpace(src[j - 1])) return j;
  }
  return -1;
}

function inline(src: string, links = true): Span[] {
  const spans: Span[] = [];
  let text = '';
  const push = (span: Span) => {
    if (text) spans.push({ type: 'text', text });
    text = '';
    spans.push(span);
  };

  for (let i = 0; i < src.length; ) {
    const char = src[i] as string;
    const rest = src.slice(i);

    if (char === '\\' && ESCAPABLE.has(src[i + 1] ?? '')) {
      push({ type: 'mark', text: '\\' });
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        push({
          type: 'code',
          children: [
            { type: 'mark', text: '`' },
            { type: 'text', text: src.slice(i + 1, end) },
            { type: 'mark', text: '`' },
          ],
        });
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith('**') && !isSpace(src[i + 2])) {
      const end = closingStrong(src, i);
      if (end !== -1) {
        push({
          type: 'strong',
          children: [
            { type: 'mark', text: '**' },
            ...inline(src.slice(i + 2, end), links),
            { type: 'mark', text: '**' },
          ],
        });
        i = end + 2;
        continue;
      }
    }

    if (char === '*' && src[i + 1] !== '*' && !isSpace(src[i + 1])) {
      const end = closingEm(src, i);
      if (end !== -1) {
        push({
          type: 'em',
          children: [
            { type: 'mark', text: '*' },
            ...inline(src.slice(i + 1, end), links),
            { type: 'mark', text: '*' },
          ],
        });
        i = end + 1;
        continue;
      }
    }

    if (char === '[' && src[i + 1] === '[') {
      const token = blockLinksIn(rest)[0];
      if (token?.start === 0) {
        push({ type: 'chip', text: rest.slice(0, token.end), target: token.target });
        i += token.end;
        continue;
      }
    }

    if (links && char === '[') {
      const match = MARKDOWN_LINK.exec(rest);
      if (match) {
        const [whole, label = '', href = ''] = match;
        push({
          type: 'link',
          href,
          children: [
            { type: 'mark', text: '[' },
            ...inline(label, false),
            { type: 'mark', text: `](${href})` },
          ],
        });
        i += whole.length;
        continue;
      }
    }

    if (links && (char === 'h' || char === 'H') && !isWordChar(src[i - 1])) {
      const match = BARE_URL.exec(rest);
      const url = match && trimUrl(match[0]);
      if (url && BARE_URL.test(url)) {
        push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    text += char;
    i += 1;
  }
  if (text) spans.push({ type: 'text', text });
  return spans;
}

export function parseBlock(text: string): ParsedBlock {
  const image = imageAttachmentOf(text);
  if (image) return { heading: 0, image, spans: [{ type: 'mark', text }] };
  const heading = headingLevel(text);
  if (!heading) return { heading, image: null, spans: inline(text) };
  const mark = text.slice(0, heading + 1);
  return { heading, image: null, spans: [{ type: 'mark', text: mark }, ...inline(text.slice(mark.length))] };
}

// ---- rendering ----

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

// Without labels (the Markdown tests, say), a chip shows its token's target as it is.
const plainLabel: LabelChip = (target) =>
  target.type === 'day'
    ? { text: target.day, title: target.day }
    : target.type === 'event'
      ? { text: 'A meeting', title: 'A calendar event' }
      : { text: 'Project', title: 'A Project' };

function spansHtml(spans: Span[], label: LabelChip): string {
  return spans
    .map((span) => {
      switch (span.type) {
        case 'text':
          return escapeHtml(span.text);
        case 'chip':
          return chipHtml(span.text, span.target, label);
        case 'mark':
          return `<span class="n-mk">${escapeHtml(span.text)}</span>`;
        case 'link': {
          const href = escapeHtml(span.href);
          const tone = isOpenableLink(span.href) ? '' : ' n-link-off';
          return `<span class="n-link${tone}" data-href="${href}" title="${href}">${spansHtml(span.children, label)}</span>`;
        }
        default:
          return `<${span.type}>${spansHtml(span.children, label)}</${span.type}>`;
      }
    })
    .join('');
}

/**
 * The markup a Block's row shows for its text. Its text content is exactly the Block's text. Links
 * are spans that carry their target (`data-href`), never anchors, so nothing in the page follows them.
 * `label` says what each `[[` chip reads.
 */
export function blockHtml(text: string, label: LabelChip = plainLabel): string {
  // A new line at the very end needs something after it to show as a line, and a chip at the very
  // end needs something after it for the caret to go there (the browser won't put it after a
  // non-editable element that ends the line). A trailing <br> adds no line and no text.
  const endsWithChip = blockLinksIn(text).some((token) => token.end === text.length);
  return spansHtml(parseBlock(text).spans, label) + (text.endsWith('\n') || endsWithChip ? '<br>' : '');
}

// ---- editing ----

/** A Block's text after an edit, with the selection to put back. */
export interface TextEdit {
  text: string;
  start: number;
  end: number;
}

export type Mark = '**' | '*' | '`';

// The length of the run of `char` ending just before `at` (or starting at `at`, going forward).
function runBefore(text: string, at: number, char: string) {
  let n = 0;
  while (text[at - 1 - n] === char) n++;
  return n;
}
function runAfter(text: string, at: number, char: string) {
  let n = 0;
  while (text[at + n] === char) n++;
  return n;
}

// Whether a run of this many mark characters holds the mark: `***` holds both bold and italic.
function holds(run: number, mark: Mark): boolean {
  if (mark === '`') return run === 1;
  return mark === '**' ? run === 2 || run === 3 : run === 1 || run === 3;
}

/** Ctrl+B, Ctrl+I or Ctrl+E: marks the selection, or takes the mark off if it has it. */
export function toggleMark(text: string, start: number, end: number, mark: Mark): TextEdit {
  const m = mark.length;
  const char = mark[0] as string;

  if (start === end) {
    // Between an empty pair: take it away again. Otherwise start a pair with the caret inside.
    if (text.slice(start - m, start) === mark && text.slice(start, start + m) === mark)
      return { text: text.slice(0, start - m) + text.slice(start + m), start: start - m, end: start - m };
    return { text: text.slice(0, start) + mark + mark + text.slice(start), start: start + m, end: start + m };
  }

  // Spaces at either end of the selection stay outside the marks.
  while (start < end && /\s/.test(text[start] as string)) start++;
  while (end > start && /\s/.test(text[end - 1] as string)) end--;

  // Already marked around the selection: unwrap.
  if (holds(runBefore(text, start, char), mark) && holds(runAfter(text, end, char), mark))
    return {
      text: text.slice(0, start - m) + text.slice(start, end) + text.slice(end + m),
      start: start - m,
      end: end - m,
    };

  // The selection takes in its own marks: unwrap.
  const selected = text.slice(start, end);
  if (
    selected.length > 2 * m &&
    holds(runAfter(selected, 0, char), mark) &&
    holds(runBefore(selected, selected.length, char), mark)
  )
    return {
      text: text.slice(0, start) + selected.slice(m, -m) + text.slice(end),
      start,
      end: end - 2 * m,
    };

  return {
    text: text.slice(0, start) + mark + selected + mark + text.slice(end),
    start: start + m,
    end: end + m,
  };
}

/** The URL a paste holds, if that is all it holds: an http(s) or mailto link. */
export function pastedUrl(pasted: string): string | null {
  const url = pasted.trim();
  return !/\s/.test(url) && isOpenableLink(url) ? url : null;
}

/** Pasting a URL onto selected text: the text becomes a link to it, and the caret goes after. */
export function linkSelection(text: string, start: number, end: number, url: string): TextEdit | null {
  if (start === end) return null;
  const link = `[${text.slice(start, end)}](${url})`;
  const caret = start + link.length;
  return { text: text.slice(0, start) + link + text.slice(end), start: caret, end: caret };
}
