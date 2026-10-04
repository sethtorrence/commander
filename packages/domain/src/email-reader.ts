import { z } from 'zod';

/*
  The email reader (#134): how an email's HTML reaches the screen without reaching the app. Email HTML
  is written by whoever sent it (ADR 0004), so the Core sanitises it, and the main process serves the
  result from its own locked-down protocol, `commander-mail:`, into a sandboxed frame that runs no
  script and reaches no network: remote images come only through the main process, when the
  message's image rule allows them, and inline (`cid:`) parts only from the message's own parts.

  Each opened message gets a fresh random token, and every URL its document can name carries it:

    commander-mail://message/<token>          the sanitised document
    commander-mail://image/<token>/<n>        its n-th remote image (fetched by the main process)
    commander-mail://part/<token>/<cid>       an inline part, by its Content-ID (percent-encoded)

  A token names one rendering of one message, so a document can only ever reach its own images and
  parts, and a URL can't be guessed or built for another message.
*/

export const emailReaderScheme = 'commander-mail';

const TOKEN = /^[0-9a-f]{32}$/;
const PREFIX = `${emailReaderScheme}://`;
// More than any real email names; a document naming more remote images shows only these.
export const EMAIL_REMOTE_IMAGES_MAX = 500;
const CONTENT_ID_MAX = 998;

export const isEmailReaderToken = (token: string): boolean => TOKEN.test(token);

export const emailMessageUrl = (token: string): string => `${PREFIX}message/${token}`;
export const emailImageUrl = (token: string, index: number): string => `${PREFIX}image/${token}/${index}`;
export const emailPartUrl = (token: string, contentId: string): string =>
  `${PREFIX}part/${token}/${encodeURIComponent(contentId)}`;

export type EmailReaderUrl =
  | { kind: 'message'; token: string }
  | { kind: 'image'; token: string; index: number }
  | { kind: 'part'; token: string; contentId: string };

/**
 * What a `commander-mail:` URL asks for, or null for anything but the exact forms above (no query,
 * fragment, dot segments or other host).
 */
export function emailReaderUrlOf(url: string): EmailReaderUrl | null {
  if (!url.startsWith(PREFIX)) return null;
  const [host, token, rest, ...more] = url.slice(PREFIX.length).split('/');
  if (!token || !TOKEN.test(token) || more.length) return null;
  if (host === 'message') return rest === undefined ? { kind: 'message', token } : null;
  if (host === 'image') {
    if (rest === undefined || !/^(?:0|[1-9]\d{0,3})$/.test(rest)) return null;
    const index = Number(rest);
    return index < EMAIL_REMOTE_IMAGES_MAX ? { kind: 'image', token, index } : null;
  }
  if (host === 'part') {
    if (!rest || /[?#]/.test(rest)) return null;
    let contentId: string;
    try {
      contentId = decodeURIComponent(rest);
    } catch {
      return null;
    }
    if (!contentId || contentId.length > CONTENT_ID_MAX || contentId === '.' || contentId === '..')
      return null;
    return { kind: 'part', token, contentId };
  }
  return null;
}

/** A Content-ID as a `cid:` URL names it: without its angle brackets, compared case-insensitively. */
export const normaliseContentId = (value: string): string =>
  value
    .trim()
    .replace(/^<(.*)>$/s, '$1')
    .trim()
    .toLowerCase();

/**
 * A mailto: link with only what a mail client should take from it: the addresses, and subject, body,
 * cc and bcc. Anything else (`attach=`, `attachment=` and the like, which some clients act on) is
 * dropped. Null when it isn't a mailto: link.
 */
export function safeMailto(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^mailto:/i.test(trimmed)) return null;
  const [rest = ''] = trimmed.slice('mailto:'.length).split('#');
  const question = rest.indexOf('?');
  const addresses = question < 0 ? rest : rest.slice(0, question);
  const query = question < 0 ? '' : rest.slice(question + 1);
  const kept = query
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      const name = (equals < 0 ? pair : pair.slice(0, equals)).toLowerCase();
      return ['subject', 'body', 'cc', 'bcc'].includes(name)
        ? `${name}${equals < 0 ? '' : pair.slice(equals)}`
        : null;
    })
    .filter((pair): pair is string => pair !== null);
  return `mailto:${addresses}${kept.length ? `?${kept.join('&')}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Attachments

const NAME_MAX = 120;
// Path separators and characters some file systems refuse.
const RESERVED = /[<>:"|?*]/g;
// Control characters, and the bidirectional and invisible characters that disguise an extension
// ("photo‮gnp.exe" shows as "photoexe.png").
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** An attachment's name as Commander writes it to disk: no path, nothing hidden, at most 120 characters. */
export function safeAttachmentName(raw: string): string {
  let name = (raw.split(/[/\\]/).pop() ?? '').replace(HIDDEN, '').replace(RESERVED, '_').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!name) return 'attachment';
  // Names Windows reserves for devices, whatever the extension ("CON.pdf", "nul.txt").
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, NAME_MAX - extension.length) + extension;
  }
  return name;
}

// What Open offers: PDFs, plain text, Office Open XML documents (which can't hold macros: those are
// .docm, .xlsm…), images, audio and video, which the system opens in a viewer. Anything else can only
// be saved: programs, scripts, installers, archives, web pages, calendar files, unknown types, and
// documents that can carry macros or have a history of exploits (doc, xls, ppt, rtf, OpenDocument,
// csv, which spreadsheets run formulas from).
const OPENABLE = new Set([
  'pdf',
  'txt',
  'docx',
  'xlsx',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'heic',
  'tif',
  'tiff',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'flac',
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
]);
// Types that say "this runs", whatever the name says.
const RUNNABLE_TYPE =
  /(?:^text\/(?:html|javascript|x-sh|x-shellscript|x-python|x-perl)$)|(?:^application\/(?:x-msdownload|x-msdos-program|x-msi|x-ms-installer|x-executable|x-elf|x-sharedlib|x-mach-binary|x-sh|x-shellscript|x-csh|x-bat|x-desktop|x-java-archive|java-archive|javascript|x-javascript|ecmascript|x-python|x-perl|x-ruby|vnd\.microsoft\.portable-executable|x-dosexec|x-apple-diskimage|vnd\.debian\.binary-package|x-rpm|x-appimage|hta|xhtml\+xml|x-ms-shortcut)$)/i;

/** Whether Open (the system's default app) is offered for an attachment, or only Save…. */
export function isOpenableAttachment(name: string, type: string): boolean {
  const safe = safeAttachmentName(name);
  const dot = safe.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = safe.slice(dot + 1).toLowerCase();
  if (!OPENABLE.has(extension)) return false;
  return !RUNNABLE_TYPE.test(type.split(';')[0]?.trim() ?? '');
}

// ---------------------------------------------------------------------------------------------
// The window's requests (window → main)

const id = z.string().min(1).max(200);
const address = z.string().min(3).max(320);

// How a message's remote images stand: it has none, they are held back, or they are shown.
export const emailImagesState = z.enum(['none', 'held', 'shown']);
export type EmailImagesState = z.infer<typeof emailImagesState>;

// One email Account's image rules, for Settings → Email.
export const emailImageAccount = z.object({
  account: id,
  name: z.string().nullable(),
  source: z.enum(['gmail', 'outlook']),
  // Gmail Accounts: ask before showing images (they show by default, as in Gmail).
  askFirst: z.boolean(),
  // Senders whose images always show (Always show from this sender), lower-case.
  trustedSenders: z.array(z.string()),
});
export type EmailImageAccount = z.infer<typeof emailImageAccount>;

// The image rules the window can change, which the Core keeps.
export const emailImageChange = z.discriminatedUnion('op', [
  // Show images (this message).
  z.object({ op: z.literal('show-images'), itemId: id }),
  // Always show from this sender: the message's sender, for its Account.
  z.object({ op: z.literal('trust-sender'), itemId: id }),
  z.object({ op: z.literal('untrust-sender'), account: id, address }),
  z.object({ op: z.literal('set-ask-first'), account: id, on: z.boolean() }),
]);
export type EmailImageChange = z.infer<typeof emailImageChange>;

export const emailReaderRequest = z.union([
  // Prepares a message's HTML to show (`quotes`: with its quoted history unfolded).
  z.object({ op: z.literal('open'), itemId: id, quotes: z.boolean() }),
  // How tall a prepared message's document is at this width, in CSS pixels.
  z.object({ op: z.literal('measure'), url: z.string().max(200), width: z.number().int().min(80).max(8000) }),
  z.object({ op: z.literal('save-attachment'), itemId: id, partId: z.string().max(200) }),
  z.object({ op: z.literal('open-attachment'), itemId: id, partId: z.string().max(200) }),
  z.object({ op: z.literal('image-settings') }),
  emailImageChange,
]);
export type EmailReaderRequest = z.infer<typeof emailReaderRequest>;

// A prepared message, as the window shows it.
export type EmailView = {
  // The document's commander-mail://message/<token> URL, for the frame.
  url: string;
  images: EmailImagesState;
  // How many remote images it names (held back or shown).
  imageCount: number;
  // Quoted history was folded away (unfold by opening it again with `quotes`).
  hasQuote: boolean;
  // The sender's address (for Always show from this sender), lower-case.
  sender: string | null;
};

export type EmailReaderResponse =
  | { ok: true; view: EmailView }
  | { ok: true; height: number }
  | { ok: true; saved: boolean }
  | { ok: true; accounts: EmailImageAccount[] }
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// The main process and the Core

export const coreEmailRequest = z.union([
  // The message's HTML, sanitised for the frame, with its URLs named for `token`.
  z.object({ op: z.literal('render'), itemId: id, quotes: z.boolean(), token: z.string().regex(TOKEN) }),
  // One of the message's parts, fetched through its Source (once) and cached in its Account's
  // folder: by part id (an attachment), or by Content-ID (an inline image).
  z.object({ op: z.literal('part'), itemId: id, partId: z.string().max(200) }),
  z.object({ op: z.literal('part'), itemId: id, contentId: z.string().min(1).max(CONTENT_ID_MAX) }),
  z.object({ op: z.literal('image-settings') }),
  emailImageChange,
]);
export type CoreEmailRequest = z.infer<typeof coreEmailRequest>;

export const coreEmailReaderRequest = z.object({
  type: z.literal('email-reader-request'),
  id: z.number().int().positive(),
  request: coreEmailRequest,
});
export type CoreEmailReaderRequest = z.infer<typeof coreEmailReaderRequest>;

export const emailRender = z.object({
  // The whole document, sanitised.
  html: z.string(),
  // The remote images it names, by index; empty unless they are shown.
  remoteImages: z.array(z.string()).max(EMAIL_REMOTE_IMAGES_MAX),
  images: emailImagesState,
  imageCount: z.number().int().nonnegative(),
  hasQuote: z.boolean(),
  account: id,
  sender: z.string().nullable(),
});
export type EmailRender = z.infer<typeof emailRender>;

export const emailPart = z.object({
  // The cached file (in the Account's folder under the data folder).
  path: z.string().min(1),
  name: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative(),
});
export type EmailPart = z.infer<typeof emailPart>;

export const coreEmailReaderReply = z.object({
  type: z.literal('email-reader-reply'),
  id: z.number().int().positive(),
  response: z.union([
    z.object({ ok: z.literal(true), render: emailRender }),
    z.object({ ok: z.literal(true), part: emailPart }),
    z.object({ ok: z.literal(true), accounts: z.array(emailImageAccount) }),
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});
export type CoreEmailReaderReply = z.infer<typeof coreEmailReaderReply>;
