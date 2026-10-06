import type { EmailAddress, OutgoingMessage } from '@commander/domain';
import MailComposer from 'nodemailer/lib/mail-composer';

// A message written in Commander (#138) as RFC 5322 MIME, for Gmail (`messages.send`, `drafts.create`
// and `drafts.update` take the raw message): built with Nodemailer's MIME builder (MIT-0), never by
// hand. The HTML goes with a plain-text alternative, attachments after them (multipart/mixed); the
// reply headers (In-Reply-To, References) thread it, its Message-ID is Commander's, and
// X-Commander-Id names the message's Item, so a retried send can find what an earlier attempt did.
// Bcc stays in the headers: Gmail reads it to deliver, and leaves it off what recipients get.
// Nodemailer never reads a file or a URL here: every part's bytes are handed in.

// The header that names the message's Item in Commander.
export const COMMANDER_ID_HEADER = 'X-Commander-Id';

export type MimeOptions = {
  // The Date header (now, unless given).
  date?: Date;
  // The shared part of the multipart boundaries (random unless given, as tests give it).
  baseBoundary?: string;
};

const nodemailerAddress = (address: EmailAddress) =>
  address.name?.trim() ? { name: address.name.trim(), address: address.address } : address.address;

/** The message as raw MIME, with its attachments' bytes (`files`, by attachment id). */
export async function buildMime(
  message: OutgoingMessage,
  files: ReadonlyMap<string, Uint8Array>,
  { date = new Date(), baseBoundary }: MimeOptions = {},
): Promise<Buffer> {
  const composer = new MailComposer({
    from: nodemailerAddress(message.from),
    to: message.to.map(nodemailerAddress),
    cc: message.cc.map(nodemailerAddress),
    bcc: message.bcc.map(nodemailerAddress),
    subject: message.subject,
    messageId: message.messageId,
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references.length ? { references: message.references } : {}),
    date,
    text: message.text,
    html: message.html,
    headers: { [COMMANDER_ID_HEADER]: message.commanderId },
    attachments: message.attachments.map((attachment) => {
      const bytes = files.get(attachment.id);
      if (!bytes) throw new Error(`The attachment ${attachment.name} is missing`);
      return { filename: attachment.name, contentType: attachment.type, content: Buffer.from(bytes) };
    }),
    disableFileAccess: true,
    disableUrlAccess: true,
    ...(baseBoundary ? { baseBoundary } : {}),
  });
  const node = composer.compile();
  node.keepBcc = true;
  return node.build();
}
