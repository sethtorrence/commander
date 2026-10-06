import { z } from 'zod';
import { type EmailAddress, type EmailDetail, emailAddress, normaliseMessageId } from './email';

/*
  Writing email (#138, decision #15): new mail, reply, reply all and forward, with simple formatting
  (bold, italic, links and lists), attachments and the Account's signature; drafts saved to Gmail's or
  Outlook's Drafts folder as the User types; and every send held a few seconds with Undo.

  The composer's body is a small model of its own (`composeBody`), never HTML: paragraphs and lists of
  runs of text, each bold, italic or a link. The window turns its editor into this model and back
  (building only the elements the model allows), and the Core turns it into the message's HTML and its
  plain-text alternative here, escaping every character the User typed. So nothing the User pastes or
  a draft made elsewhere holds can carry script, styles or remote content into the window or into the
  message; quoted history, which is outside material (ADR 0004), never enters the model at all: it
  goes below the User's words as the Core's sanitiser cleaned it, and the composer shows it only as
  plain text.

  Sending is Act for you when Ares does it (#11): only the User sends. Ares may only leave a draft
  (#143), which stays text in the composer until the User presses Send.

  A message is an `email` Item from the moment it is first saved: a draft, then (once sent) the sent
  message in its thread, matched to the copy the Source syncs by the Source's answer (or, after a crash,
  its Message-ID) so it never appears twice. Its draft and its sending reach the Source through the
  outgoing queue (ADR 0003) as the changes `draft` and `send`; see apps/core/src/item-store/compose.ts.
*/

const id = z.string().min(1).max(200);
const timestamp = z.number().int().nonnegative();

export const COMPOSE_MODES = ['new', 'reply', 'reply-all', 'forward'] as const;
export const composeMode = z.enum(COMPOSE_MODES);
export type ComposeMode = z.infer<typeof composeMode>;

// The outgoing changes of a message written in Commander (ADR 0003): its draft as the User last left
// it (saved to the Source's Drafts folder), and its sending. Discarding a draft queues `delete`.
export const DRAFT_FIELD = 'draft';
export const SEND_FIELD = 'send';

// ---------------------------------------------------------------------------------------------
// The body

// The most text one run, and one body, may hold.
const RUN_MAX = 100_000;
const BODY_BLOCKS_MAX = 5_000;

// Links the body may carry: web and mail addresses only.
const LINK = /^(?:https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+)$/i;

/** Whether a link may go in a message: only http(s) and mailto, nothing that runs or reaches the machine. */
export const isComposeLink = (href: string) => LINK.test(href.trim()) && href.length <= 2_000;

export const composeRun = z.object({
  text: z.string().max(RUN_MAX),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  // A link's address; a run whose address isn't a web or mail address is plain text.
  href: z.string().max(2_000).optional(),
});
export type ComposeRun = z.infer<typeof composeRun>;

export const composeBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), runs: z.array(composeRun).max(5_000) }),
  z.object({
    type: z.literal('list'),
    ordered: z.boolean(),
    items: z.array(z.array(composeRun).max(5_000)).max(1_000),
  }),
]);
export type ComposeBlock = z.infer<typeof composeBlock>;

export const composeBody = z.array(composeBlock).max(BODY_BLOCKS_MAX);
export type ComposeBody = z.infer<typeof composeBody>;

/** A body of plain lines, one paragraph each. */
export const plainBody = (text: string): ComposeBody =>
  text.split('\n').map((line) => ({ type: 'paragraph', runs: line ? [{ text: line }] : [] }));

const runsText = (runs: readonly ComposeRun[]) => runs.map((run) => run.text).join('');

/** Whether the body holds no words at all (empty paragraphs and lists only). */
export const isBodyEmpty = (body: ComposeBody) =>
  body.every((block) =>
    block.type === 'paragraph'
      ? !runsText(block.runs).trim()
      : block.items.every((runs) => !runsText(runs).trim()),
  );

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text made safe to place in HTML, as content or a quoted attribute. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

function runHtml(run: ComposeRun): string {
  let html = escapeHtml(run.text).replace(/\r?\n/g, '<br>');
  if (run.italic) html = `<i>${html}</i>`;
  if (run.bold) html = `<b>${html}</b>`;
  if (run.href && isComposeLink(run.href)) html = `<a href="${escapeHtml(run.href.trim())}">${html}</a>`;
  return html;
}

const runsHtml = (runs: readonly ComposeRun[]) => runs.map(runHtml).join('');

/** The body as HTML: a <div> per paragraph (as Gmail writes them), <ul>/<ol> lists, <b>, <i> and <a>. */
export function bodyHtml(body: ComposeBody): string {
  return body
    .map((block) => {
      if (block.type === 'paragraph') {
        const inner = runsHtml(block.runs);
        return `<div>${inner || '<br>'}</div>`;
      }
      const tag = block.ordered ? 'ol' : 'ul';
      return `<${tag}>${block.items.map((runs) => `<li>${runsHtml(runs)}</li>`).join('')}</${tag}>`;
    })
    .join('');
}

function runText(run: ComposeRun): string {
  const href = run.href && isComposeLink(run.href) ? run.href.trim() : null;
  if (!href) return run.text;
  const shown = href.replace(/^mailto:/i, '');
  return run.text.trim() === shown || run.text.trim() === href ? run.text : `${run.text} <${href}>`;
}

/** The body as plain text: a line per paragraph, "- " or "1. " before list items, links in angle brackets. */
export function bodyText(body: ComposeBody): string {
  const lines: string[] = [];
  for (const block of body) {
    if (block.type === 'paragraph') lines.push(block.runs.map(runText).join(''));
    else
      block.items.forEach((runs, index) => {
        lines.push(`${block.ordered ? `${index + 1}.` : '-'} ${runs.map(runText).join('')}`);
      });
  }
  return lines.join('\n');
}

/** The body with the Account's signature below it, after a blank line and the "-- " line mail clients know. */
export function withSignature(body: ComposeBody, signature: ComposeBody | null): ComposeBody {
  if (!signature || isBodyEmpty(signature)) return body;
  return [
    ...body,
    { type: 'paragraph', runs: [] },
    { type: 'paragraph', runs: [{ text: '-- ' }] },
    ...signature,
  ];
}

// ---------------------------------------------------------------------------------------------
// Replies and forwards

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** When a message was sent, as a quote's attribution says it: "Fri, 2 Oct 2026 at 16:00" (local time). */
export function quoteTime(at: number): string {
  const date = new Date(at);
  return `${DAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} at ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** An address as a header shows it: `Dana Fox <dana@example.com>`, or the bare address. */
export const formatAddress = (address: EmailAddress) =>
  address.name?.trim() ? `${address.name.trim()} <${address.address}>` : address.address;

const lower = (address: string) => address.trim().toLowerCase();

const RE = /^\s*(?:re|aw|sv|antw)\s*(?:\[\d+\])?\s*:\s*/i;
const FWD = /^\s*(?:fwd?|wg|tr|rv)\s*(?:\[\d+\])?\s*:\s*/i;

/** A reply's or forward's subject: "Re: " or "Fwd: " before the original's, never twice. */
export function replySubject(subject: string, mode: ComposeMode): string {
  const trimmed = subject.trim();
  if (mode === 'new') return trimmed;
  if (mode === 'forward') return FWD.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
  return RE.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** Addresses once each (by address, case aside), in order, leaving out `except`. */
export function uniqueAddresses(
  addresses: readonly EmailAddress[],
  except: readonly string[] = [],
): EmailAddress[] {
  const seen = new Set(except.map(lower));
  const out: EmailAddress[] = [];
  for (const each of addresses) {
    const key = lower(each.address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: each.name, address: each.address.trim() });
  }
  return out;
}

/**
 * Who a reply goes to, as Gmail and Outlook do: a reply to the sender (or the Reply-To), a reply all
 * to them and everyone else on the message but the User, in Cc; a reply to the User's own message goes
 * back to its recipients. A forward and new mail start with no one.
 */
export function replyRecipients(
  original: Pick<EmailDetail, 'from' | 'to' | 'cc' | 'replyTo' | 'sentByMe'>,
  mode: ComposeMode,
  me: readonly string[],
): { to: EmailAddress[]; cc: EmailAddress[] } {
  if (mode === 'new' || mode === 'forward') return { to: [], cc: [] };
  const mine = new Set(me.map(lower));
  const isMe = (address: EmailAddress | null) => !!address && mine.has(lower(address.address));
  if (original.sentByMe || isMe(original.from)) {
    const to = uniqueAddresses(original.to);
    return {
      to,
      cc:
        mode === 'reply-all'
          ? uniqueAddresses(
              original.cc,
              to.map((each) => each.address),
            )
          : [],
    };
  }
  const sender = original.replyTo.length ? original.replyTo : original.from ? [original.from] : [];
  const to = uniqueAddresses(sender, [...mine]);
  if (mode === 'reply') return { to, cc: [] };
  const cc = uniqueAddresses([...original.to, ...original.cc], [...mine, ...to.map((each) => each.address)]);
  return { to, cc };
}

/** The reply headers a reply carries so it threads everywhere: In-Reply-To the original, References its chain. */
export function replyThreading(original: Pick<EmailDetail, 'messageId' | 'references' | 'inReplyTo'>): {
  inReplyTo: string | null;
  references: string[];
} {
  const own = normaliseMessageId(original.messageId);
  const chain = original.references.length
    ? [...original.references]
    : original.inReplyTo
      ? [original.inReplyTo]
      : [];
  const references = own && !chain.includes(own) ? [...chain, own] : chain;
  return { inReplyTo: own, references };
}

/** The line above a reply's quoted history: "On Fri, 2 Oct 2026 at 16:00, Dana Fox <dana@x.test> wrote:". */
export const quoteAttribution = (original: Pick<EmailDetail, 'from' | 'sentAt'>) =>
  `On ${quoteTime(original.sentAt)}, ${original.from ? formatAddress(original.from) : 'someone'} wrote:`;

/** The lines above a forwarded message, as Gmail writes them. */
export function forwardHeader(
  original: Pick<EmailDetail, 'from' | 'sentAt' | 'subject' | 'to' | 'cc'>,
): string[] {
  return [
    '---------- Forwarded message ---------',
    `From: ${original.from ? formatAddress(original.from) : ''}`,
    `Date: ${quoteTime(original.sentAt)}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.map(formatAddress).join(', ')}`,
    ...(original.cc.length ? [`Cc: ${original.cc.map(formatAddress).join(', ')}`] : []),
  ];
}

// The most of the original's text a reply quotes.
const QUOTED_TEXT_MAX = 100_000;

/** The plain-text quote of the original below a reply ("> " before each line), or its forwarded copy. */
export function quotedText(
  original: Pick<EmailDetail, 'from' | 'sentAt' | 'subject' | 'to' | 'cc'>,
  text: string,
  mode: ComposeMode,
): string {
  const body = text.slice(0, QUOTED_TEXT_MAX).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (mode === 'forward') return [...forwardHeader(original), '', body].join('\n');
  return [quoteAttribution(original), ...body.split('\n').map((line) => (line ? `> ${line}` : '>'))].join(
    '\n',
  );
}

/**
 * The HTML below a reply (in a blockquote, as Gmail marks it so every client folds it) or above a
 * forwarded message. `html` is the original's HTML as the Core's sanitiser cleaned it, or its text
 * escaped when it had none.
 */
export function quotedHtml(
  original: Pick<EmailDetail, 'from' | 'sentAt' | 'subject' | 'to' | 'cc'>,
  html: string,
  mode: ComposeMode,
): string {
  if (mode === 'forward') {
    const header = forwardHeader(original).map(escapeHtml).join('<br>');
    return `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${header}<br></div><br>${html}</div>`;
  }
  return (
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(quoteAttribution(original))}<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${html}</blockquote></div>`
  );
}

/** Plain text as HTML (for quoting a message that had no HTML). */
export const textAsHtml = (text: string) => `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;

/** The whole message's HTML and text: the User's words (with their signature), then any quote. */
export function messageBodies(
  body: ComposeBody,
  quote: { html: string; text: string } | null,
): { html: string; text: string } {
  const html = `<div dir="ltr">${bodyHtml(body)}</div>`;
  const text = bodyText(body);
  if (!quote) return { html, text };
  return { html: `${html}<br>${quote.html}`, text: `${text}\n\n${quote.text}` };
}

// ---------------------------------------------------------------------------------------------
// Attachments

// About the largest message Gmail takes (its upload cap) and Exchange's default send limit (#8).
export const ATTACHMENTS_MAX_BYTES = 35 * 1024 * 1024;
// Graph uploads attachments larger than this through an upload session.
export const GRAPH_INLINE_ATTACHMENT_MAX = 3 * 1024 * 1024;

export const composeAttachment = z.object({
  // Commander's id for the file it keeps until the message is sent (a UUID).
  id: z.uuid(),
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
});
export type ComposeAttachment = z.infer<typeof composeAttachment>;

export const attachmentsSize = (attachments: readonly Pick<ComposeAttachment, 'size'>[]) =>
  attachments.reduce((sum, each) => sum + each.size, 0);

const MB = 1024 * 1024;
/** A size as the composer shows it: "820 KB", "4.2 MB". */
export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** Why these attachments can't go in one message, or null when they fit under the 35 MB cap. */
export function attachmentsProblem(attachments: readonly Pick<ComposeAttachment, 'size'>[]): string | null {
  const total = attachmentsSize(attachments);
  if (total <= ATTACHMENTS_MAX_BYTES) return null;
  return `Attachments can add up to 35 MB per message; these come to ${attachmentSize(total)}. Remove some, or share a link instead.`;
}

// ---------------------------------------------------------------------------------------------
// Address suggestions

// One address as the User's mail knows it: how many messages the User wrote to it, how many it came
// in (written, received or copied), and when it was last seen.
export type AddressSeen = {
  address: string;
  name: string | null;
  writtenTo: number;
  seen: number;
  lastSeenAt: number;
};

/**
 * Every address in the User's mail (theirs aside), with how often and how recently each was seen:
 * written to when it was on the User's own message, seen whenever it was on any.
 */
export function addressBook(
  messages: readonly Pick<EmailDetail, 'from' | 'to' | 'cc' | 'bcc' | 'sentByMe' | 'sentAt'>[],
  me: readonly string[],
): AddressSeen[] {
  const mine = new Set(me.map(lower));
  const book = new Map<string, AddressSeen>();
  const note = (address: EmailAddress, at: number, written: boolean) => {
    const key = lower(address.address);
    if (!key || mine.has(key) || !/^[^\s@]+@[^\s@]+$/.test(key)) return;
    const known = book.get(key) ?? {
      address: address.address.trim(),
      name: null,
      writtenTo: 0,
      seen: 0,
      lastSeenAt: 0,
    };
    known.seen += 1;
    if (written) known.writtenTo += 1;
    if (at >= known.lastSeenAt) {
      known.lastSeenAt = at;
      if (address.name?.trim()) known.name = address.name.trim();
    } else if (!known.name && address.name?.trim()) known.name = address.name.trim();
    book.set(key, known);
  };
  for (const message of messages) {
    const fromMe = message.sentByMe || (!!message.from && mine.has(lower(message.from.address)));
    if (message.from) note(message.from, message.sentAt, false);
    for (const each of [...message.to, ...message.cc, ...message.bcc]) note(each, message.sentAt, fromMe);
  }
  return [...book.values()];
}

/**
 * The addresses to suggest for what was typed, best first: those the User has written to first, then
 * by how often and how recently they were seen. What was typed matches the start of the address or of
 * a word of the name.
 */
export function suggestAddresses(book: readonly AddressSeen[], typed: string, limit = 8): EmailAddress[] {
  const wanted = typed.trim().toLowerCase();
  const matches = (known: AddressSeen) => {
    if (!wanted) return true;
    const address = known.address.toLowerCase();
    if (address.startsWith(wanted)) return true;
    if (address.split('@')[1]?.startsWith(wanted)) return true;
    const name = known.name?.toLowerCase() ?? '';
    return name.startsWith(wanted) || name.split(/[\s.'-]+/).some((word) => word.startsWith(wanted));
  };
  return book
    .filter(matches)
    .sort(
      (a, b) =>
        Number(b.writtenTo > 0) - Number(a.writtenTo > 0) ||
        b.seen - a.seen ||
        b.lastSeenAt - a.lastSeenAt ||
        a.address.localeCompare(b.address),
    )
    .slice(0, limit)
    .map((known) => ({ name: known.name, address: known.address }));
}

/** Addresses typed into a field ("Dana <dana@x.test>, sam@y.test"), as addresses; what isn't one is left out. */
export function parseAddresses(text: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angled = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(trimmed);
    if (angled) {
      const name = (angled[1] ?? '')
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim();
      out.push({ name: name || null, address: angled[2] as string });
    } else if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(trimmed)) out.push({ name: null, address: trimmed });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Undo send and the default Account (Settings → Email)

export const UNDO_SEND_CHOICES = [5, 10, 20, 30, 60] as const;
export const DEFAULT_UNDO_SEND_SECONDS = 10;

export const emailComposeSettings = z.object({
  // The Account new mail goes from; null until the User picks one (the first email Account then).
  defaultAccount: id.nullable(),
  // How long every send is held, with Undo, before it really goes.
  undoSeconds: z.literal(UNDO_SEND_CHOICES),
});
export type EmailComposeSettings = z.infer<typeof emailComposeSettings>;

// ---------------------------------------------------------------------------------------------
// What the composer holds, and what reaches the Source

const addresses = z.array(emailAddress.extend({ address: z.string().trim().min(3).max(320) })).max(500);

// What the window hands the Core to save (a draft) or send: the message as the composer holds it.
export const composeDraft = z.object({
  // The message's Item once it has one (after its first save); null or absent before.
  itemId: id.nullable().optional(),
  mode: composeMode,
  // The Account it goes from (replies and forwards: the one the message arrived at).
  account: id,
  // The message replied to or forwarded (its Item).
  replyToItemId: id.nullable().optional(),
  to: addresses,
  cc: addresses,
  bcc: addresses,
  subject: z.string().max(1_000),
  body: composeBody,
  attachments: z.array(composeAttachment).max(100),
});
export type ComposeDraft = z.infer<typeof composeDraft>;

// What the composer opens with: a new message (with the signature in its body and, for a reply or
// forward, its recipients, subject and the quote to show folded), a draft, or a message taken back
// from sending (Undo).
export const composeState = composeDraft.extend({
  itemId: id.nullable(),
  replyToItemId: id.nullable(),
  // Who it is from, as the Account says.
  from: emailAddress,
  // The quoted history below a reply (or the forwarded message), as plain text, shown folded.
  quote: z.string().nullable(),
});
export type ComposeState = z.infer<typeof composeState>;

// The `draft` and `send` changes' value: everything an adapter needs to save or send the message.
export const outgoingMessage = z.object({
  // Commander's id for the message (its Item's id), which the adapter marks the message with (an
  // X-Commander-Id header, an Outlook extended property) so a retried attempt finds what an earlier one did.
  commanderId: id,
  messageId: z.string().min(3),
  mode: composeMode,
  from: emailAddress,
  to: z.array(emailAddress),
  cc: z.array(emailAddress),
  bcc: z.array(emailAddress),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  attachments: z.array(composeAttachment),
  // Threading: the reply headers, the Source's thread (Gmail threadId), and the message replied to or
  // forwarded at the Source (its external id: Graph makes replies and forwards from it).
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  sourceThreadId: z.string().nullable(),
  replyToExternalId: z.string().nullable(),
});
export type OutgoingMessage = z.infer<typeof outgoingMessage>;

/** A Message-ID for a message Commander writes: its id at the Account's own domain. */
export function newMessageId(commanderId: string, from: string): string {
  const domain = /@([^\s@<>]+)$/.exec(from.trim())?.[1] ?? 'commander.invalid';
  return `<${commanderId}@${domain.toLowerCase()}>`;
}

// ---------------------------------------------------------------------------------------------
// The Drafts and Outbox views

// A message waiting in the Outbox: held for Undo, waiting for the connection (or the Source), on its
// way, or refused (with the reason, and Retry).
export const OUTBOX_STATES = ['held', 'waiting', 'sending', 'failed'] as const;
export const outboxState = z.enum(OUTBOX_STATES);
export type OutboxState = z.infer<typeof outboxState>;

export const outboxEntry = z.object({
  itemId: id,
  account: id,
  subject: z.string(),
  to: z.array(emailAddress),
  state: outboxState,
  // When a held message goes (the end of its Undo time).
  sendAt: timestamp.nullable(),
  // Why the Source refused it, in plain words.
  error: z.string().nullable(),
  // The thread it shows in.
  threadKey: z.string(),
});
export type OutboxEntry = z.infer<typeof outboxEntry>;

export const draftEntry = z.object({
  itemId: id,
  account: id,
  subject: z.string(),
  to: z.array(emailAddress),
  snippet: z.string(),
  updatedAt: timestamp,
  // Made in Commander (true), or in Gmail or Outlook and synced in.
  commanders: z.boolean(),
});
export type DraftEntry = z.infer<typeof draftEntry>;

/** How an Outbox entry reads: "Sending in 8 s", "Waiting for a connection", "Couldn't send: …". */
export function outboxLine(entry: Pick<OutboxEntry, 'state' | 'sendAt' | 'error'>, now: number): string {
  switch (entry.state) {
    case 'held': {
      const seconds = entry.sendAt === null ? 0 : Math.max(0, Math.ceil((entry.sendAt - now) / 1000));
      return seconds > 0 ? `Sending in ${seconds} s` : 'Sending…';
    }
    case 'waiting':
      return 'Waiting to send: it goes when Commander is back online';
    case 'sending':
      return 'Sending…';
    case 'failed':
      return `Couldn’t send${entry.error ? `: ${entry.error}` : ''}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The window's requests (window → main → Core)

export const composeRequest = z.discriminatedUnion('op', [
  // A new composer: new mail (from `account`, or the default Account), or a reply, reply all or
  // forward of a message (from the Account it arrived at).
  z.object({ op: z.literal('open'), mode: composeMode, itemId: id.optional(), account: id.optional() }),
  // A draft (Commander's, or one made in Gmail or Outlook), in the composer.
  z.object({ op: z.literal('open-draft'), itemId: id }),
  // Saves the draft (to the Source's Drafts folder too, through the outgoing queue). Its Item comes back.
  z.object({ op: z.literal('save'), draft: composeDraft }),
  // Sends it: held for the Undo time, then sent. Its Item and when it goes come back.
  z.object({ op: z.literal('send'), draft: composeDraft }),
  // Takes a held (or waiting) message back: it is a draft again, in the composer.
  z.object({ op: z.literal('undo-send'), itemId: id }),
  // Discards a draft (in Gmail or Outlook too).
  z.object({ op: z.literal('discard'), itemId: id }),
  // Sends a refused message again.
  z.object({ op: z.literal('retry'), itemId: id }),
  z.object({ op: z.literal('drafts'), account: id.optional() }),
  z.object({ op: z.literal('outbox') }),
  // Address suggestions for what was typed in To, Cc or Bcc.
  z.object({
    op: z.literal('suggest'),
    text: z.string().max(320),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  // A file to attach: its bytes, kept by the Core until the message is sent.
  z.object({
    op: z.literal('add-attachment'),
    name: z.string().min(1).max(255),
    type: z.string().max(255),
    bytes: z
      .custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected the file’s bytes')
      .refine(
        (bytes) => bytes.byteLength <= ATTACHMENTS_MAX_BYTES,
        'Attachments can add up to 35 MB per message.',
      ),
  }),
  // Settings → Email: the default Account and the Undo time; Settings → Accounts: each signature.
  z.object({ op: z.literal('settings') }),
  z.object({ op: z.literal('save-settings'), settings: emailComposeSettings }),
  z.object({ op: z.literal('signature'), account: id }),
  z.object({ op: z.literal('save-signature'), account: id, body: composeBody }),
]);
export type ComposeRequest = z.input<typeof composeRequest>;
export type ComposeOp = ComposeRequest['op'];

export const composeResult = {
  open: composeState,
  'open-draft': composeState,
  save: z.object({ itemId: id }),
  send: z.object({ itemId: id, sendAt: timestamp }),
  'undo-send': composeState,
  discard: z.object({}),
  retry: z.object({}),
  drafts: z.array(draftEntry),
  outbox: z.array(outboxEntry),
  suggest: z.array(emailAddress),
  'add-attachment': composeAttachment,
  settings: emailComposeSettings,
  'save-settings': emailComposeSettings,
  signature: composeBody,
  'save-signature': composeBody,
} satisfies Record<ComposeOp, z.ZodType>;

export type ComposeResults = { [Op in ComposeOp]: z.infer<(typeof composeResult)[Op]> };
export type ComposeResponse<Op extends ComposeOp = ComposeOp> =
  | { ok: true; result: ComposeResults[Op] }
  | { ok: false; error: string };

export const COMPOSE_MESSAGES = {
  request: 'compose-request',
  reply: 'compose-reply',
  // Commander is quitting: held messages go now, and the Core answers once they have (or can't).
  sendHeld: 'compose-send-held',
  sentHeld: 'compose-sent-held',
} as const;

export const coreComposeRequest = z.object({
  type: z.literal(COMPOSE_MESSAGES.request),
  id: z.number().int().positive(),
  request: composeRequest,
});

export const coreComposeReply = z.object({
  type: z.literal(COMPOSE_MESSAGES.reply),
  id: z.number().int().positive(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});
