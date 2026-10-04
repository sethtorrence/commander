import {
  EMAIL_HTML_MAX,
  EMAIL_TEXT_MAX,
  type EmailAddress,
  type EmailAttachment,
  type EmailBody,
  type EmailDetail,
  emailStatus,
  normaliseContentId,
  normaliseMessageId,
  parseMessageIds,
  type SourceItem,
  threadMessages,
} from '@commander/domain';
import { teamsText as htmlText } from '../teams/html';
import type { GmailMessage, GmailPart } from './shapes';

// A Gmail message (`messages.get?format=full`) as an email Item: its headers, labels and attachment
// metadata in the detail, and its bodies beside it. Gmail sends each part's data base64url-encoded
// with its Content-Transfer-Encoding (quoted-printable, base64) already undone, but still in the
// part's own charset; encoded words in headers (RFC 2047) are left to the reader. Attachments are
// never downloaded here: only what names them. HTML is kept as it came, never rendered (ADR 0004):
// an HTML-only message's text is converted from it, for the plain-text reader and search.

// What Gmail's system labels are called in Gmail.
const SYSTEM_LABELS: Record<string, string> = {
  INBOX: 'Inbox',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  IMPORTANT: 'Important',
  SENT: 'Sent',
  DRAFT: 'Drafts',
  SPAM: 'Spam',
  TRASH: 'Trash',
  CHAT: 'Chat',
  CATEGORY_PERSONAL: 'Personal',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

/** A label's name as Gmail shows it: system labels by their Gmail names, the User's by their own. */
export const labelName = (id: string, names: ReadonlyMap<string, string>) =>
  SYSTEM_LABELS[id] ?? names.get(id) ?? id;

// ---------------------------------------------------------------------------------------------
// Charsets and encoded words

function decoderFor(charset: string | null): TextDecoder {
  try {
    return new TextDecoder(charset?.trim() || 'utf-8');
  } catch {
    // A charset TextDecoder doesn't know: UTF-8 is the likeliest truth.
    return new TextDecoder('utf-8');
  }
}

const decodeBytes = (bytes: Uint8Array, charset: string | null) => decoderFor(charset).decode(bytes);

function qBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '_') bytes.push(0x20);
    else if (char === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi;

/**
 * A header value with its RFC 2047 encoded words decoded: adjacent ones (only whitespace between)
 * are joined, their bytes decoded together so a character split across them survives.
 */
export function decodeHeader(value: string): string {
  let out = '';
  let last = 0;
  // Consecutive encoded words of one charset, waiting to be decoded together.
  let pending: { charset: string; bytes: number[] } | null = null;
  const flush = () => {
    if (pending) out += decodeBytes(Uint8Array.from(pending.bytes), pending.charset);
    pending = null;
  };
  for (const match of value.matchAll(ENCODED_WORD)) {
    const [word, rawCharset = '', encoding = '', text = ''] = match;
    const between = value.slice(last, match.index);
    const charset = rawCharset.split('*')[0] as string;
    const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : qBytes(text);
    const adjacent = pending !== null && /^\s*$/.test(between);
    if (!adjacent) {
      flush();
      out += between;
    }
    if (pending && (pending as { charset: string }).charset.toLowerCase() !== charset.toLowerCase()) flush();
    if (!pending) pending = { charset, bytes: [] };
    (pending as { bytes: number[] }).bytes.push(...bytes);
    last = (match.index ?? 0) + word.length;
  }
  flush();
  return out + value.slice(last);
}

// ---------------------------------------------------------------------------------------------
// Addresses

// Splits an address list at its top-level commas, dropping group names ("Team:") and their ends (";").
function splitAddresses(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (quoted) {
      current += char;
      if (char === '\\') current += value[++i] ?? '';
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && comment === 0) quoted = true;
    else if (char === '(') comment += 1;
    else if (char === ')' && comment > 0) comment -= 1;
    else if (char === '<' && comment === 0) angle += 1;
    else if (char === '>' && comment === 0 && angle > 0) angle -= 1;
    else if (comment === 0 && angle === 0 && (char === ',' || char === ';')) {
      items.push(current);
      current = '';
      continue;
    } else if (comment === 0 && angle === 0 && char === ':') {
      // A group's name: what came before it names the group, not an address.
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

const unquote = (name: string) =>
  name
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\(.)/g, '$1')
    .trim();

/** An address list header (From, To, Cc…) as addresses, in order. Entries with no address are left out. */
export function parseAddresses(value: string | null | undefined): EmailAddress[] {
  if (!value) return [];
  const addresses: EmailAddress[] = [];
  for (const item of splitAddresses(value)) {
    const angle = /<([^<>]*)>\s*$/.exec(item);
    if (angle) {
      const address = (angle[1] ?? '').trim();
      if (!address.includes('@')) continue;
      const name = decodeHeader(unquote(item.slice(0, angle.index).replace(/\([^)]*\)/g, '')));
      addresses.push({ name: name || null, address });
      continue;
    }
    const comment = /\(([^)]*)\)/.exec(item);
    const address = item.replace(/\([^)]*\)/g, '').trim();
    if (!address.includes('@') || /\s/.test(address)) continue;
    const name = comment ? decodeHeader(unquote(comment[1] ?? '')) : '';
    addresses.push({ name: name || null, address });
  }
  return addresses;
}

// ---------------------------------------------------------------------------------------------
// Parts

export const headerOf = (part: GmailPart | undefined, name: string): string | null => {
  const wanted = name.toLowerCase();
  return part?.headers?.find((header) => header.name.toLowerCase() === wanted)?.value ?? null;
};

export const mimeOf = (part: GmailPart) => (part.mimeType ?? '').toLowerCase();

function charsetOf(part: GmailPart): string | null {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(headerOf(part, 'Content-Type') ?? '');
  return match?.[1] ?? null;
}

function isAttachment(part: GmailPart): boolean {
  if (mimeOf(part).startsWith('multipart/')) return false;
  const disposition = (headerOf(part, 'Content-Disposition') ?? '').toLowerCase();
  return !!part.filename || disposition.startsWith('attachment') || !!part.body?.attachmentId;
}

function textOf(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  return decodeBytes(Buffer.from(data, 'base64url'), charsetOf(part)).replace(/\r\n?/g, '\n');
}

type Bodies = { text: string | null; html: string | null };

const joined = (pieces: (string | null)[], separator: string) => {
  const present = pieces.filter((piece): piece is string => piece !== null && piece.trim() !== '');
  return present.length ? present.join(separator) : null;
};

// The text and HTML of a part: one alternative's of each, every inline part's of other multiparts.
function bodiesOf(part: GmailPart): Bodies {
  const mime = mimeOf(part);
  if (mime.startsWith('multipart/')) {
    const children = (part.parts ?? []).map(bodiesOf);
    if (mime === 'multipart/alternative') {
      // Alternatives come plainest first: the first text, the last (richest) HTML.
      return {
        text: children.find((child) => child.text !== null)?.text ?? null,
        html: children.findLast((child) => child.html !== null)?.html ?? null,
      };
    }
    return {
      text: joined(
        children.map((child) => child.text?.trim() ?? null),
        '\n\n',
      ),
      html: joined(
        children.map((child) => child.html),
        '\n',
      ),
    };
  }
  if (isAttachment(part)) return { text: null, html: null };
  if (mime === 'text/plain') return { text: textOf(part), html: null };
  if (mime === 'text/html') return { text: null, html: textOf(part) };
  return { text: null, html: null };
}

export function* leaves(part: GmailPart): Generator<GmailPart> {
  if (part.parts?.length) for (const child of part.parts) yield* leaves(child);
  else yield part;
}

function attachmentOf(part: GmailPart): EmailAttachment {
  const disposition = (headerOf(part, 'Content-Disposition') ?? '').toLowerCase();
  const contentId = normaliseContentId(headerOf(part, 'Content-ID') ?? '');
  const name =
    part.filename ||
    /filename\*?\s*=\s*"?([^";]+)"?/i.exec(headerOf(part, 'Content-Disposition') ?? '')?.[1] ||
    'attachment';
  return {
    name: decodeHeader(name),
    type: mimeOf(part) || 'application/octet-stream',
    size: part.body?.size ?? 0,
    partId: part.partId ?? '',
    inline: disposition.startsWith('inline') || (!disposition && !!headerOf(part, 'Content-ID')),
    ...(contentId ? { contentId } : {}),
  };
}

const INVITATION_TYPES = new Set(['text/calendar', 'application/ics']);

/** A message's bodies as Commander keeps them (see the domain's emailBody). */
export function bodyOf(payload: GmailPart | undefined): EmailBody {
  if (!payload) return { text: '', html: null, textFromHtml: false, truncated: false };
  const found = bodiesOf(payload);
  let truncated = false;
  let html = found.html;
  const textFromHtml = found.text === null && html !== null;
  let text = (found.text ?? (html !== null ? htmlText(html) : '')).trimEnd();
  if (text.length > EMAIL_TEXT_MAX) {
    text = text.slice(0, EMAIL_TEXT_MAX);
    truncated = true;
  }
  if (html !== null && html.length > EMAIL_HTML_MAX) {
    html = null;
    truncated = true;
  }
  return { text, html, textFromHtml, truncated };
}

// ---------------------------------------------------------------------------------------------
// The Item

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Gmail's snippets come HTML-escaped ("I&#39;d").
function unescapeSnippet(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function sentAtOf(message: GmailMessage): number {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return internal;
  const date = Date.parse(headerOf(message.payload, 'Date') ?? '');
  return Number.isNaN(date) ? 0 : Math.max(0, date);
}

/**
 * The email Item for a Gmail message, with its bodies. `labels`: the Account's label names by id.
 * Its thread key is the message's own until the Item store threads it among the Account's mail.
 */
export function readGmailMessage(message: GmailMessage, labels: ReadonlyMap<string, string>): SourceItem {
  const top = message.payload;
  const header = (name: string) => headerOf(top, name);
  const labelIds = message.labelIds ?? [];
  const from = parseAddresses(header('From'))[0] ?? null;
  const to = parseAddresses(header('To'));
  const cc = parseAddresses(header('Cc'));
  const bcc = parseAddresses(header('Bcc'));
  const replyTo = parseAddresses(header('Reply-To'));
  const subject = decodeHeader(header('Subject') ?? '').trim();
  const messageId = normaliseMessageId(header('Message-ID'));
  const inReplyTo = parseMessageIds(header('In-Reply-To'))[0] ?? null;
  const references = parseMessageIds(header('References'));
  const allLeaves = top ? [...leaves(top)] : [];
  const detail: EmailDetail = {
    kind: 'email',
    messageId,
    inReplyTo,
    references,
    threadKey: '',
    sourceThreadId: message.threadId,
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    sentAt: sentAtOf(message),
    snippet: unescapeSnippet(message.snippet ?? ''),
    read: !labelIds.includes('UNREAD'),
    starred: labelIds.includes('STARRED'),
    inInbox: labelIds.includes('INBOX'),
    sentByMe: labelIds.includes('SENT'),
    labels: labelIds.map((id) => ({ id, name: labelName(id, labels) })),
    attachments: allLeaves.filter(isAttachment).map(attachmentOf),
    hasInvitation: allLeaves.some((part) => INVITATION_TYPES.has(mimeOf(part))),
    listUnsubscribe: header('List-Unsubscribe'),
    listId: header('List-Id') ? decodeHeader(header('List-Id') as string) : null,
    ...(labelIds.includes('TRASH') ? { inTrash: true } : {}),
    ...(message.historyId ? { sourceVersion: message.historyId } : {}),
  };
  detail.threadKey =
    threadMessages([
      {
        key: message.id,
        messageId,
        inReplyTo,
        references,
        sourceThreadId: message.threadId,
        sentAt: detail.sentAt,
      },
    ]).get(message.id) ?? `key:${message.id}`;
  const people = [
    ...new Set(
      [from, ...to, ...cc, ...bcc, ...replyTo].flatMap((each) => (each ? [each.address.toLowerCase()] : [])),
    ),
  ];
  return {
    externalId: message.id,
    kind: 'email',
    title: subject || '(no subject)',
    people,
    status: emailStatus(detail),
    detail,
    body: bodyOf(top),
  };
}
