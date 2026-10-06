import {
  EMAIL_HTML_MAX,
  EMAIL_TEXT_MAX,
  type EmailAddress,
  type EmailAttachment,
  type EmailBody,
  type EmailDetail,
  type EmailFolder,
  emailStatus,
  isSystemFolder,
  normaliseContentId,
  normaliseMessageId,
  parseMessageIds,
  type SourceItem,
  threadMessages,
} from '@commander/domain';
import { decodeHeader } from '../gmail/message';
import { teamsText as htmlText } from '../teams/html';
import type { GraphAttachment, GraphMessage } from './shapes';

// A Graph message (as a folder's delta lists it) as an email Item (#136), in the detail Gmail's mail
// shares: its reply headers (from `internetMessageHeaders`, so threading needs no request per message;
// `internetMessageId` when Outlook left the headers out, as it does for the User's own sent mail), its
// `conversationId` as the Source's thread, `isRead`, its flag as starred, the folder it is filed in
// (in the Inbox means open, anywhere else archived), its categories and its attachments' metadata.
// Bodies come as Graph sends them (HTML, or text) and are kept as Gmail's are: the HTML unrendered for
// the sandboxed reader (ADR 0004), and an HTML-only message's text converted from it.

// What mapping a message needs to know of the Account.
export type MessageContext = {
  // Every folder Commander knows, by id, with its name (a path) and which of Outlook's own it is.
  folders: ReadonlyMap<string, EmailFolder>;
  // The Inbox's id.
  inbox: string | null;
  // Sent Items' id.
  sent: string | null;
  // The mailbox's own address (its mail), for telling the User's messages apart.
  me: string | null;
};

const EVENT_MESSAGE = '#microsoft.graph.eventMessage';

const headerOf = (message: GraphMessage, name: string): string | null => {
  const wanted = name.toLowerCase();
  return message.internetMessageHeaders.find((header) => header.name.toLowerCase() === wanted)?.value ?? null;
};

function addressOf(recipient: GraphMessage['from']): EmailAddress | null {
  const address = recipient?.emailAddress?.address?.trim();
  if (!address) return null;
  const name = recipient?.emailAddress?.name?.trim();
  return { name: name && name !== address ? name : null, address };
}

const addressesOf = (list: GraphMessage['toRecipients']) =>
  list.flatMap((each) => {
    const address = addressOf(each);
    return address ? [address] : [];
  });

const timeOf = (value: string | null | undefined): number => {
  const at = Date.parse(value ?? '');
  return Number.isNaN(at) ? 0 : Math.max(0, at);
};

/** A message's bodies as Commander keeps them (see the domain's emailBody). */
export function outlookBody(body: GraphMessage['body']): EmailBody {
  const content = (body?.content ?? '').replace(/\r\n?/g, '\n');
  const isHtml = (body?.contentType ?? '').toLowerCase() === 'html';
  let html = isHtml && content.trim() ? content : null;
  let text = (isHtml ? (html !== null ? htmlText(html) : '') : content).trimEnd();
  let truncated = false;
  if (text.length > EMAIL_TEXT_MAX) {
    text = text.slice(0, EMAIL_TEXT_MAX);
    truncated = true;
  }
  if (html !== null && html.length > EMAIL_HTML_MAX) {
    html = null;
    truncated = true;
  }
  return { text, html, textFromHtml: isHtml && content.trim() !== '', truncated };
}

/** Whether the message's HTML shows inline parts (`cid:`), whose metadata Graph lists only on asking. */
export const showsInlineParts = (message: GraphMessage) =>
  (message.body?.contentType ?? '').toLowerCase() === 'html' && /\bcid:/i.test(message.body?.content ?? '');

/** An attachment's metadata as the detail keeps it; null for a link to a file elsewhere (OneDrive). */
export function attachmentOf(attachment: GraphAttachment): EmailAttachment | null {
  if ((attachment['@odata.type'] ?? '').endsWith('referenceAttachment')) return null;
  const contentId = attachment.contentId ? normaliseContentId(attachment.contentId) : '';
  return {
    name: attachment.name?.trim() || 'attachment',
    type: attachment.contentType?.trim() || 'application/octet-stream',
    size: Math.max(0, Math.round(attachment.size ?? 0)),
    partId: attachment.id,
    inline: attachment.isInline === true,
    ...(contentId ? { contentId } : {}),
  };
}

/** The folder a message is filed in, as the detail names it. */
export function folderOf(id: string | null | undefined, context: MessageContext): EmailFolder | null {
  if (!id) return null;
  return context.folders.get(id) ?? { id, name: 'Folder', wellKnown: null };
}

/** The folder fields of a detail filed in `folder`: where it is, whether that's the inbox, its label. */
export function filedIn(folder: EmailFolder | null): Pick<EmailDetail, 'folder' | 'inInbox' | 'labels'> {
  return {
    folder,
    inInbox: folder?.wellKnown === 'inbox',
    labels: folder && !isSystemFolder(folder) ? [{ id: folder.id, name: folder.name }] : [],
  };
}

/**
 * The email Item for a Graph message, with its bodies, filed in its parent folder. `attachments`: its
 * attachments' metadata, as listed (none when it has none). Its thread key is the message's own until
 * the Item store threads it among the Account's mail.
 */
export function readOutlookMessage(
  message: GraphMessage,
  context: MessageContext,
  attachments: readonly EmailAttachment[],
): SourceItem {
  const from = addressOf(message.from) ?? addressOf(message.sender);
  const to = addressesOf(message.toRecipients);
  const cc = addressesOf(message.ccRecipients);
  const bcc = addressesOf(message.bccRecipients);
  const replyTo = addressesOf(message.replyTo);
  const subject = (message.subject ?? '').trim();
  const messageId = normaliseMessageId(headerOf(message, 'Message-ID') ?? message.internetMessageId);
  const inReplyTo = parseMessageIds(headerOf(message, 'In-Reply-To'))[0] ?? null;
  const references = parseMessageIds(headerOf(message, 'References'));
  const folder = folderOf(message.parentFolderId, context);
  const me = context.me?.toLowerCase() ?? null;
  const sentAt = timeOf(message.receivedDateTime) || timeOf(message.sentDateTime);
  const listId = headerOf(message, 'List-Id');
  const detail: EmailDetail = {
    kind: 'email',
    messageId,
    inReplyTo,
    references,
    threadKey: '',
    sourceThreadId: message.conversationId ?? null,
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    sentAt,
    snippet: (message.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
    read: message.isRead !== false,
    starred: message.flag?.flagStatus === 'flagged',
    ...filedIn(folder),
    sentByMe: (!!folder && folder.id === context.sent) || (!!me && from?.address.toLowerCase() === me),
    categories: [...message.categories],
    attachments: [...attachments],
    hasInvitation: message['@odata.type'] === EVENT_MESSAGE,
    listUnsubscribe: headerOf(message, 'List-Unsubscribe'),
    listId: listId ? decodeHeader(listId) : null,
  };
  detail.threadKey =
    threadMessages([
      { key: message.id, messageId, inReplyTo, references, sourceThreadId: detail.sourceThreadId, sentAt },
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
    body: outlookBody(message.body),
  };
}
