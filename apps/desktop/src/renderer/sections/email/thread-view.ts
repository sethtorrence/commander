import type { EmailDetail } from '@commander/domain';

/*
  The thread view's decisions (#134), kept apart from its components: which messages start expanded,
  how a plain-text message's quoted history folds, how its text becomes links, and how sizes read.
*/

/** The messages shown expanded when a thread opens: the newest, and every unread one. */
export function expandedAtFirst(messages: readonly { item: { id: string; detail: unknown } }[]): Set<string> {
  const open = new Set<string>();
  messages.forEach(({ item }, index) => {
    const detail = item.detail as EmailDetail | null;
    if (index === messages.length - 1 || detail?.read === false) open.add(item.id);
  });
  return open;
}

const significant = (line: string) => line.trim() !== '';
const ATTRIBUTION = /^(?:On\b.{0,300}\bwrote:|Le\b.{0,300}\ba écrit\s?:|Am\b.{0,300}\bschrieb.{0,80}:)\s*$/i;
const ORIGINAL = /^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}\s*$/i;

/**
 * A plain-text message's trailing quoted history (after "On … wrote:", Outlook's "Original Message",
 * or a closing run of "> " lines), folded away. Only trailing history folds: a reply written between
 * quoted lines, or a message that is only a quote, stays whole.
 */
export function splitQuote(text: string): { body: string; quote: string | null } {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const rest = lines.slice(i + 1).filter(significant);
    const quoted =
      ORIGINAL.test(line.trim()) ||
      (ATTRIBUTION.test(line.trim()) &&
        rest.length > 0 &&
        rest.every((each) => each.trimStart().startsWith('>'))) ||
      (line.trimStart().startsWith('>') && rest.every((each) => each.trimStart().startsWith('>')));
    if (!quoted) continue;
    const body = lines.slice(0, i).join('\n').trimEnd();
    if (!lines.slice(0, i).some(significant)) return { body: text, quote: null };
    return { body, quote: lines.slice(i).join('\n') };
  }
  return { body: text, quote: null };
}

export type TextPiece = { text: string; href?: string };

// Web addresses (http and https only) and mail addresses, with trailing punctuation left out.
const LINK = /\bhttps?:\/\/[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A plain-text body as text and links (web and mail only), every character kept, in order. */
export function textPieces(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    let found = match[0];
    const start = match.index ?? 0;
    // A sentence's closing punctuation isn't part of the address.
    const trailing = /[.,;:!?)\]}]+$/.exec(found)?.[0] ?? '';
    found = found.slice(0, found.length - trailing.length);
    if (!found) continue;
    if (start > at) pieces.push({ text: text.slice(at, start) });
    const href = /^https?:/i.test(found) ? found : `mailto:${found}`;
    let valid = true;
    try {
      new URL(href);
    } catch {
      valid = false;
    }
    pieces.push(valid ? { text: found, href } : { text: found });
    at = start + found.length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** An attachment's size as mail clients show it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
