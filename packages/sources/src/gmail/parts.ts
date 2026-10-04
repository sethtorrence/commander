import { normaliseContentId } from '@commander/domain';
import { z } from 'zod';
import { type FetchedPart, PartNotFound, type PartRequest, PartTooLarge } from '../source';
import { type GmailClient, MessageGone } from './client';
import { headerOf, leaves, mimeOf } from './message';
import { gmailMessage } from './shapes';

// One part of a Gmail message, for the email reader (#134): an attachment by its part id, or an
// inline image by its Content-ID. The message is read again (`messages.get?format=full`, 20 units)
// for its current structure, since Gmail's attachment ids change between fetches; a small part's
// bytes come with it, a larger one's from `messages.attachments.get` (5 units). Paced with the
// Account's syncs.

const gmailAttachment = z.object({ size: z.number().optional(), data: z.string() });

export async function fetchGmailPart(gmail: GmailClient, request: PartRequest): Promise<FetchedPart> {
  const id = encodeURIComponent(request.externalId);
  let message: z.infer<typeof gmailMessage>;
  try {
    message = await gmail.get('get', `/messages/${id}?format=full`, gmailMessage);
  } catch (error) {
    if (error instanceof MessageGone) throw new PartNotFound('Gmail no longer has this message.');
    throw error;
  }
  const wanted = 'partId' in request.part ? null : normaliseContentId(request.part.contentId);
  const partId = 'partId' in request.part ? request.part.partId : null;
  const part = message.payload
    ? [...leaves(message.payload)].find((leaf) =>
        partId !== null
          ? leaf.partId === partId
          : normaliseContentId(headerOf(leaf, 'Content-ID') ?? '') === wanted,
      )
    : undefined;
  // Only a leaf with a body of its own is a part to fetch (not a multipart, not an empty one).
  if (!part || mimeOf(part).startsWith('multipart/') || (!part.body?.data && !part.body?.attachmentId))
    throw new PartNotFound('This message has no such part.');
  if ((part.body?.size ?? 0) > request.maxBytes) throw new PartTooLarge('This attachment is too large.');
  let data = part.body?.data;
  if (!data) {
    try {
      const attachment = await gmail.get(
        'attachment',
        `/messages/${id}/attachments/${encodeURIComponent(part.body?.attachmentId ?? '')}`,
        gmailAttachment,
      );
      data = attachment.data;
    } catch (error) {
      if (error instanceof MessageGone) throw new PartNotFound('Gmail no longer has this attachment.');
      throw error;
    }
  }
  const bytes = Uint8Array.from(Buffer.from(data, 'base64url'));
  if (bytes.length > request.maxBytes) throw new PartTooLarge('This attachment is too large.');
  return {
    partId: part.partId ?? '',
    name: part.filename || 'attachment',
    type: mimeOf(part) || 'application/octet-stream',
    bytes,
  };
}
