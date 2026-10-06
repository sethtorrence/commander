import {
  DELETE_FIELD,
  DRAFT_FIELD,
  type EmailAttachment,
  type EmailDetail,
  GRAPH_INLINE_ATTACHMENT_MAX,
  isPendingEventExternalId,
  type OutgoingMessage,
  outgoingMessage,
  SEND_FIELD,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import { WriteRejected, type WriteRequest, type WriteResult } from '../source';
import { type GraphMail, GraphNotFound } from './graph';
import { attachmentOf, type MessageContext, readOutlookMessage } from './message';
import { attachmentsPage, graphMessage } from './shapes';

// Writing email through Outlook (#138, ADR 0003): a message written in Commander reaches Outlook as the
// outgoing changes `draft` (saved to Drafts), `send` and `delete` (a draft discarded), one Item at a
// time, as the User, through Microsoft Graph.
//
// - The draft: a reply or reply all is made with `createReply` / `createReplyAll` from the message it
//   answers, and a forward with `createForward`, so Outlook threads it and sets its reply headers
//   (Graph won't take In-Reply-To or References); new mail with `POST /me/messages`. Its subject,
//   recipients and body (HTML) are then set with a PATCH, which also marks it with Commander's id (an
//   extended property, never sent to anyone). Once Outlook has the draft, the Item's external id is the
//   draft's (immutable) id, and later saves PATCH it.
// - Attachments follow the message's list: each it lacks is added (up to 3 MB in the request, larger
//   ones through an upload session, in chunks), and each it has that the User removed is deleted.
// - `send`: the draft brought up to date, then `POST /me/messages/{id}/send`. Outlook sends it from the
//   Account and files it in Sent Items; the copy there is handed back naming the Item, or (while Outlook
//   is still filing it) the draft as sent, with its internetMessageId, which the next sync matches.
// - `delete`: the draft deleted (one Outlook no longer has is already gone).
//
// Never twice: Graph takes no idempotency key for a send, so a change whose earlier attempt has an
// unknown outcome (`attemptedAt`) first looks for the message by Commander's id in Sent Items and the
// Outbox, and counts as sent when it is there (or when its draft no longer is one); a draft looks for
// Commander's id in Drafts before making another.

// Commander's mark on a message it wrote: the Item's id, in the public strings property set.
export const COMMANDER_MESSAGE_PROPERTY =
  'String {00020329-0000-0000-C000-000000000046} Name CommanderMessage';
// Upload sessions take chunks in multiples of 320 KiB; 10 of those at a time.
export const UPLOAD_CHUNK = 10 * 320 * 1024;

const READ_FIELDS = [
  'id',
  'receivedDateTime',
  'sentDateTime',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'isRead',
  'isDraft',
  'flag',
  'parentFolderId',
  'conversationId',
  'internetMessageId',
  'categories',
  'hasAttachments',
  'lastModifiedDateTime',
].join(',');

const found = z.object({
  value: z
    .array(graphMessage)
    .nullish()
    .transform((value) => value ?? []),
});
const uploadSession = z.object({ uploadUrl: z.string().min(1) });
const nothing = z.unknown();

const messagePath = (id: string) => `/me/messages/${encodeURIComponent(id)}`;

function parseMessage(value: unknown): OutgoingMessage {
  const parsed = outgoingMessage.safeParse(value);
  if (!parsed.success) throw new WriteRejected('Commander couldn’t make sense of this message.');
  return parsed.data;
}

const recipient = (address: OutgoingMessage['to'][number]) => ({
  emailAddress: { address: address.address, ...(address.name ? { name: address.name } : {}) },
});

/** What a PATCH sets on the draft: its subject, recipients, body and Commander's mark. */
const draftFields = (message: OutgoingMessage) => ({
  subject: message.subject,
  body: { contentType: 'html', content: message.html },
  toRecipients: message.to.map(recipient),
  ccRecipients: message.cc.map(recipient),
  bccRecipients: message.bcc.map(recipient),
  singleValueExtendedProperties: [{ id: COMMANDER_MESSAGE_PROPERTY, value: message.commanderId }],
});

export type ComposeContext = {
  context: MessageContext;
  // Outlook's own folders' ids, by well-known name (drafts, sentitems, outbox).
  wellKnown: Readonly<Record<string, string>>;
};

export async function writeOutlookCompose(
  api: GraphMail,
  request: WriteRequest,
  { context, wellKnown }: ComposeContext,
): Promise<Omit<WriteResult, 'cost'>> {
  const find = (field: string) => request.changes.find((change) => change.field === field);
  const send = find(SEND_FIELD);
  const draft = find(DRAFT_FIELD);
  const discard = find(DELETE_FIELD);
  const placeholder = isPendingEventExternalId(request.externalId);
  const attempted = [send, draft, discard].some((change) => change?.attemptedAt != null);

  // The messages in one of Outlook's own folders carrying Commander's mark for this message.
  async function marked(folder: string, commanderId: string) {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${COMMANDER_MESSAGE_PROPERTY}' and ep/value eq '${commanderId}')`;
    const path = `/me/mailFolders/${encodeURIComponent(wellKnown[folder] ?? folder)}/messages?$filter=${encodeURIComponent(filter)}&$select=${READ_FIELDS}`;
    return (await api.send('GET', path, undefined, found)).value;
  }

  // The draft Outlook holds for the message: the Item's, or (after an attempt with an unknown outcome)
  // one carrying Commander's mark.
  async function draftOf(message: OutgoingMessage): Promise<string | null> {
    if (!placeholder) return request.externalId;
    if (!attempted) return null;
    return (await marked('drafts', message.commanderId))[0]?.id ?? null;
  }

  async function read(id: string) {
    return api.send('GET', `${messagePath(id)}?$select=${READ_FIELDS}`, undefined, graphMessage);
  }

  // A new draft for the message: from the message it answers or forwards (its fields set after), or of
  // its own (made with them).
  async function createDraft(message: OutgoingMessage): Promise<{ id: string; complete: boolean }> {
    const action =
      message.mode === 'reply'
        ? 'createReply'
        : message.mode === 'reply-all'
          ? 'createReplyAll'
          : message.mode === 'forward'
            ? 'createForward'
            : null;
    if (action && message.replyToExternalId && !isPendingEventExternalId(message.replyToExternalId)) {
      try {
        const made = await api.send(
          'POST',
          `${messagePath(message.replyToExternalId)}/${action}`,
          {},
          graphMessage,
        );
        return { id: made.id, complete: false };
      } catch (error) {
        // The message it answers is gone from Outlook: it goes as a message of its own.
        if (!(error instanceof GraphNotFound)) throw error;
      }
    }
    const made = await api.send('POST', '/me/messages', draftFields(message), graphMessage);
    return { id: made.id, complete: true };
  }

  // Brings the message's attachments in Outlook in line with its list.
  async function attachmentsFor(id: string, message: OutgoingMessage) {
    const listed = (
      await api.send(
        'GET',
        `${messagePath(id)}/attachments?$select=id,name,contentType,size,isInline`,
        undefined,
        attachmentsPage,
      )
    ).value.filter((each) => !each.isInline);
    const key = (name: string | null | undefined, size: number | null | undefined) =>
      `${name ?? ''}\u0000${size ?? 0}`;
    const wanted = new Map(message.attachments.map((each) => [key(each.name, each.size), each]));
    const present = new Set<string>();
    for (const each of listed) {
      const k = key(each.name, each.size);
      // Outlook counts an attachment's size with its own overhead: matched by name when sizes differ.
      const match = wanted.has(k)
        ? k
        : [...wanted.keys()].find(
            (name) => name.split('\u0000')[0] === (each.name ?? '') && !present.has(name),
          );
      if (match && !present.has(match)) present.add(match);
      else
        await api
          .send('DELETE', `${messagePath(id)}/attachments/${encodeURIComponent(each.id)}`, undefined, nothing)
          .catch((error: unknown) => {
            if (!(error instanceof GraphNotFound)) throw error;
          });
    }
    for (const [k, attachment] of wanted) {
      if (present.has(k)) continue;
      if (!request.attachment) throw new WriteRejected('Commander couldn’t find this message’s attachments.');
      const bytes = await request.attachment(attachment.id);
      if (bytes.byteLength <= GRAPH_INLINE_ATTACHMENT_MAX) {
        await api.send(
          'POST',
          `${messagePath(id)}/attachments`,
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: attachment.name,
            contentType: attachment.type,
            contentBytes: Buffer.from(bytes).toString('base64'),
          },
          nothing,
        );
        continue;
      }
      const session = await api.send(
        'POST',
        `${messagePath(id)}/attachments/createUploadSession`,
        {
          AttachmentItem: {
            attachmentType: 'file',
            name: attachment.name,
            size: bytes.byteLength,
            contentType: attachment.type,
          },
        },
        uploadSession,
      );
      for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK) {
        const end = Math.min(bytes.byteLength, start + UPLOAD_CHUNK);
        await api.upload(session.uploadUrl, bytes.subarray(start, end), start, bytes.byteLength);
      }
    }
  }

  // The draft, made or brought up to date: its id.
  async function saveDraft(message: OutgoingMessage): Promise<string> {
    let id = await draftOf(message);
    if (id) {
      try {
        await api.send('PATCH', messagePath(id), draftFields(message), nothing);
      } catch (error) {
        // Deleted in Outlook meanwhile: made again.
        if (!(error instanceof GraphNotFound)) throw error;
        id = null;
      }
    }
    if (!id) {
      const made = await createDraft(message);
      id = made.id;
      if (!made.complete) await api.send('PATCH', messagePath(id), draftFields(message), nothing);
    }
    await attachmentsFor(id, message);
    return id;
  }

  // The message as Outlook has it now, naming the Item.
  async function itemOf(id: string, commanderId: string, asDraft: boolean): Promise<SourceItem | null> {
    let message: z.infer<typeof graphMessage>;
    try {
      message = await read(id);
    } catch (error) {
      if (error instanceof GraphNotFound) return null;
      throw error;
    }
    return itemFrom(message, commanderId, asDraft);
  }

  async function itemFrom(
    message: z.infer<typeof graphMessage>,
    commanderId: string,
    asDraft: boolean,
  ): Promise<SourceItem> {
    let attachments: EmailAttachment[] = [];
    if (message.hasAttachments) {
      const listed = await api
        .send(
          'GET',
          `${messagePath(message.id)}/attachments?$select=id,name,contentType,size,isInline,contentId`,
          undefined,
          attachmentsPage,
        )
        .catch(() => ({ value: [] }));
      attachments = listed.value.flatMap((each) => attachmentOf(each) ?? []);
    }
    const item = readOutlookMessage(message, context, attachments);
    const detail = item.detail as EmailDetail;
    const next: EmailDetail = asDraft
      ? { ...detail, draft: true, inInbox: false }
      : { ...detail, sentByMe: true };
    if (!asDraft) delete next.draft;
    return { ...item, detail: next, status: 'archived', commanderItemId: commanderId };
  }

  // The sent copy of the message, in Sent Items or still in the Outbox, if Outlook has it.
  async function sentCopy(commanderId: string) {
    for (const folder of ['sentitems', 'outbox']) {
      const [copy] = await marked(folder, commanderId);
      if (copy) return copy;
    }
    return null;
  }

  if (send?.value) {
    const message = parseMessage(send.value);
    if (send.attemptedAt != null) {
      const copy = await sentCopy(message.commanderId);
      if (copy) return { item: await itemFrom(copy, message.commanderId, false), superseded: [] };
      // Its draft no longer a draft: Outlook took it to send.
      const id = await draftOf(message);
      if (id) {
        const held = await read(id).catch((error: unknown) => {
          if (error instanceof GraphNotFound) return null;
          throw error;
        });
        if (held && held.isDraft === false)
          return { item: await itemFrom(held, message.commanderId, false), superseded: [] };
        // The draft Outlook held is gone since the attempt: sending takes it from Drafts, so it is taken
        // as sent rather than sent again (the next sync brings the copy, by its Message-ID).
        if (!held && !placeholder) return { item: null, superseded: [] };
      }
    }
    const id = await saveDraft(message);
    // What Outlook will file in Sent Items, read before it goes (its internetMessageId threads it).
    const before = await read(id);
    await api.send('POST', `${messagePath(id)}/send`, undefined, nothing);
    const copy = await sentCopy(message.commanderId);
    const item = copy
      ? await itemFrom(copy, message.commanderId, false)
      : await itemFrom(
          { ...before, isDraft: false, parentFolderId: wellKnown.sentitems ?? null },
          message.commanderId,
          false,
        );
    return { item, superseded: [] };
  }

  if (discard?.value) {
    const named = z.object({ commanderId: z.string().min(1) }).safeParse(discard.value);
    const ids = placeholder
      ? attempted && named.success
        ? (await marked('drafts', named.data.commanderId)).map((each) => each.id)
        : []
      : [request.externalId];
    for (const id of ids)
      await api.send('DELETE', messagePath(id), undefined, nothing).catch((error: unknown) => {
        if (!(error instanceof GraphNotFound)) throw error;
      });
    return { item: null, superseded: [] };
  }

  if (draft?.value) {
    const message = parseMessage(draft.value);
    const id = await saveDraft(message);
    return { item: await itemOf(id, message.commanderId, true), superseded: [] };
  }

  return { item: null, superseded: [] };
}
