import { z } from 'zod';

// The `email` kind detail, shared by Gmail and Outlook: one Item per message (decision #28: an email
// is an Item with its thread as its detail). What it keeps is what lists, threads, search and Rules
// need; the message's text and HTML bodies are kept beside the Item (see `emailBody`), never in its
// detail, so lists never load them and the activity log never copies them. Everything here came
// from outside: untrusted Source content, kept as data only (ADR 0004).

const timestamp = z.number().int().nonnegative();

export const emailAddress = z.object({ name: z.string().nullable(), address: z.string() });
export type EmailAddress = z.infer<typeof emailAddress>;

// One of the Source's labels (Gmail) or its folder (Outlook): its id, and the name the User sees.
export const emailLabel = z.object({ id: z.string().min(1), name: z.string() });
export type EmailLabel = z.infer<typeof emailLabel>;

// An attachment's metadata. Attachments are never downloaded during sync; the reading ticket fetches
// one on demand by its part id (Gmail's attachment ids aren't stable between fetches).
export const emailAttachment = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative(),
  partId: z.string(),
  // Shown inside the HTML (Content-ID) rather than listed.
  inline: z.boolean(),
});
export type EmailAttachment = z.infer<typeof emailAttachment>;

export const emailDetail = z.object({
  kind: z.literal('email'),
  // The RFC 5322 reply headers, with angle brackets ("<id@host>"); null or empty when absent.
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  // Commander's own thread (threadMessages), and the Source's (Gmail threadId, Graph conversationId).
  threadKey: z.string().min(1),
  sourceThreadId: z.string().nullable(),
  from: emailAddress.nullable(),
  to: z.array(emailAddress),
  cc: z.array(emailAddress),
  bcc: z.array(emailAddress),
  replyTo: z.array(emailAddress),
  subject: z.string(),
  // When it was sent or received (Gmail's internalDate), epoch milliseconds.
  sentAt: timestamp,
  // The Source's short preview of the text.
  snippet: z.string(),
  read: z.boolean(),
  // Starred in Gmail, flagged in Outlook.
  starred: z.boolean(),
  inInbox: z.boolean(),
  // Sent from this Account (Gmail's SENT label).
  sentByMe: z.boolean(),
  // The Source's labels (Gmail, system ones included) or folder (Outlook).
  labels: z.array(emailLabel),
  attachments: z.array(emailAttachment),
  // It carries a calendar invitation (a text/calendar part).
  hasInvitation: z.boolean(),
  listUnsubscribe: z.string().nullable(),
  listId: z.string().nullable(),
});
export type EmailDetail = z.infer<typeof emailDetail>;

// The most text and HTML kept of one message body; longer ones are cut (text) or left out (HTML, for
// the reading ticket to fetch on demand), with `truncated` set.
export const EMAIL_TEXT_MAX = 200_000;
export const EMAIL_HTML_MAX = 1_000_000;

// A message's bodies, kept in the database beside its Item (email_bodies), never in its detail. The
// text is the text/plain part, or (an HTML-only message) the HTML converted to text: what Commander
// shows until the sandboxed HTML reader (#134) arrives. The HTML is kept, unrendered, for that reader.
export const emailBody = z.object({
  text: z.string(),
  html: z.string().nullable(),
  textFromHtml: z.boolean(),
  truncated: z.boolean(),
});
export type EmailBody = z.infer<typeof emailBody>;

/** An email's status: open while it is in the inbox, archived once it isn't. */
export const emailStatus = (detail: Pick<EmailDetail, 'inInbox'>) => (detail.inInbox ? 'open' : 'archived');

/** How an address reads in a list: its name, or else the address. */
export const addressName = (address: EmailAddress | null) =>
  address ? address.name?.trim() || address.address : '';

// ---------------------------------------------------------------------------------------------
// Message ids

const MESSAGE_ID = /<[^<>\s]+>/g;

/** The message ids in a References or In-Reply-To header, in order. */
export function parseMessageIds(header: string | null | undefined): string[] {
  return header?.match(MESSAGE_ID) ?? [];
}

/** A Message-ID as Commander keeps it: trimmed, in angle brackets. null when there is none. */
export function normaliseMessageId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  const [first] = parseMessageIds(trimmed);
  if (first) return first;
  return /\s/.test(trimmed) ? null : `<${trimmed.replace(/^<|>$/g, '')}>`;
}

// ---------------------------------------------------------------------------------------------
// Threading

// What threading reads of a message. `key` names it to the caller (an external id); `threadKey` is
// the thread it already has, if it was threaded before.
export type ThreadingMessage = {
  key: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  sourceThreadId: string | null;
  sentAt: number;
  threadKey?: string | null | undefined;
};

/** What threading reads of an email Item's detail, keyed by `key` (its external id). */
export const threadingOf = (key: string, detail: EmailDetail): ThreadingMessage => ({
  key,
  messageId: detail.messageId,
  inReplyTo: detail.inReplyTo,
  references: detail.references,
  sourceThreadId: detail.sourceThreadId,
  sentAt: detail.sentAt,
  threadKey: detail.threadKey,
});

/**
 * Gives every message its thread key (decisions #8, #20). Messages are threaded by their reply
 * headers: a message joins every message its In-Reply-To and References name. Only a message with no
 * reply headers (a thread's first message, or a reply from a client that strips them) falls back to
 * the Source's thread id, joining the messages there. A thread keeps the key it already had (the one
 * of its earliest message that has one), so threading again after more mail arrives (a parent after
 * its replies, a message bridging two threads) changes as few saved keys as it can; a new thread is
 * keyed by the first message of its conversation as its earliest message names it: `mid:<the first
 * id in its References, or its In-Reply-To, or its own Message-ID>`, else `src:<Source thread id>`,
 * else `key:<its key>`. The grouping never depends on the order messages come in.
 */
export function threadMessages(messages: readonly ThreadingMessage[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    // Path compression.
    for (let at = node; at !== root; ) {
      const next = parent.get(at) as string;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    // The smaller name roots the set, so the result doesn't depend on order.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const nodeOf = (message: ThreadingMessage) =>
    message.messageId ? `id:${message.messageId}` : `key:${message.key}`;

  for (const message of messages) {
    const node = nodeOf(message);
    if (!parent.has(node)) parent.set(node, node);
    const replyTo = [message.inReplyTo, ...message.references].filter((id): id is string => !!id);
    for (const id of replyTo) union(node, `id:${id}`);
    if (replyTo.length === 0 && message.sourceThreadId) union(node, `src:${message.sourceThreadId}`);
  }

  // Each set's messages, earliest first (then by key, for ties).
  const sets = new Map<string, ThreadingMessage[]>();
  for (const message of messages) {
    const root = find(nodeOf(message));
    sets.set(root, [...(sets.get(root) ?? []), message]);
  }
  const keys = new Map<string, string>();
  for (const members of sets.values()) {
    const ordered = [...members].sort((a, b) => a.sentAt - b.sentAt || a.key.localeCompare(b.key));
    const earliest = ordered[0] as ThreadingMessage;
    const kept = ordered.find((message) => message.threadKey)?.threadKey;
    // The conversation's first message, as far as the earliest one present knows: the first id in its
    // References (or its In-Reply-To), else itself. A reply threaded on its own is then keyed as its
    // whole conversation will be, so its parents arriving later rarely change it.
    const root = earliest.references[0] ?? earliest.inReplyTo ?? earliest.messageId;
    const key =
      kept ??
      (root
        ? `mid:${root}`
        : earliest.sourceThreadId
          ? `src:${earliest.sourceThreadId}`
          : `key:${earliest.key}`);
    for (const message of members) keys.set(message.key, key);
  }
  return keys;
}
