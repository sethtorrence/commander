import {
  DELETE_FIELD,
  DRAFT_FIELD,
  type EmailDetail,
  isPendingEventExternalId,
  type OutgoingMessage,
  outgoingMessage,
  SEND_FIELD,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import { buildMime, COMMANDER_ID_HEADER } from '../email-send/mime';
import { WriteRejected, type WriteRequest, type WriteResult } from '../source';
import { DraftGone, type GmailClient, JSON_RAW_MAX, MessageGone } from './client';
import { readGmailMessage } from './message';
import { gmailMessage, gmailMessageList } from './shapes';

// Writing email through Gmail (#138, ADR 0003): a message written in Commander reaches Gmail as the
// outgoing changes `draft` (saved to Drafts), `send` and `delete` (a draft discarded), one Item at a
// time, as the User.
//
// - `draft`: the message as raw MIME (mime.ts) through `drafts.create`, or `drafts.update` once Gmail
//   has the draft (the Item's external id is then `draft:<draft id>`); Gmail answers with the draft,
//   which is handed back naming the Item (`commanderItemId`) so the Item store gives it that id.
// - `send`: `messages.send` with the Gmail thread of the message replied to (threadId), then the draft,
//   if Gmail has one, deleted. The sent message comes back as Gmail has it, naming the Item, so it shows
//   once in its thread and the next sync finds it under the same id.
// - `delete`: `drafts.delete` (a draft Gmail no longer has is already gone).
//
// Never twice: Gmail takes no idempotency key, so a change whose earlier attempt has an unknown outcome
// (`attemptedAt`: it timed out, the connection dropped, Commander quit mid-way) first looks for what that
// attempt did. A send looks through the newest sent mail since the attempt for the message's
// X-Commander-Id (or Message-ID) and, finding it, counts as sent without sending again; a draft looks
// for one carrying the message's Message-ID before making another. Raw messages over 4 MB go through
// Gmail's upload endpoint (multipart), up to its 35 MB cap.

// Drafts are the Items `draft:<Gmail draft id>`: a draft's message changes id whenever it is saved.
export const DRAFT_PREFIX = 'draft:';
export const draftExternalId = (draftId: string) => `${DRAFT_PREFIX}${draftId}`;
export const draftIdOf = (externalId: string) =>
  externalId.startsWith(DRAFT_PREFIX) ? externalId.slice(DRAFT_PREFIX.length) : null;

// How far Gmail's clock may be behind this machine's when matching an earlier attempt.
export const CLOCK_SKEW_MS = 5 * 60_000;
// The newest sent messages read back a page at a time when looking for an earlier attempt, and the
// most pages read.
const NEWEST_SENT = 25;
const SENT_PAGES = 4;

const gmailDraft = z.object({
  id: z.string().min(1),
  message: gmailMessage.partial().extend({ id: z.string().min(1) }),
});
const gmailDraftList = z.object({
  drafts: z
    .array(
      z.object({
        id: z.string().min(1),
        message: z.object({ id: z.string().min(1), threadId: z.string().optional() }),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});
const gmailDraftFull = z.object({ id: z.string().min(1), message: gmailMessage });
const sentAnswer = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});
const metadata = z.object({
  id: z.string().min(1),
  internalDate: z.string().optional(),
  payload: z
    .object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() })
    .optional(),
});
const nothing = z.unknown();

const encode = (value: string) => encodeURIComponent(value);

function parseMessage(value: unknown): OutgoingMessage {
  const parsed = outgoingMessage.safeParse(value);
  if (!parsed.success) throw new WriteRejected('Commander couldn’t make sense of this message.');
  return parsed.data;
}

/** A Gmail draft (`drafts.get?format=full`) as the Item `draft:<id>`. */
export function readGmailDraft(draftId: string, message: z.infer<typeof gmailMessage>): SourceItem {
  const item = readGmailMessage(message, new Map());
  const detail = item.detail as EmailDetail;
  return {
    ...item,
    externalId: draftExternalId(draftId),
    // A draft's message id changes whenever it is saved: the version a sync compares.
    detail: { ...detail, draft: true, sourceVersion: message.id, inInbox: false },
    status: 'archived',
  };
}

export async function writeCompose(
  gmail: GmailClient,
  request: WriteRequest,
  now: () => number,
): Promise<Omit<WriteResult, 'cost'>> {
  const find = (field: string) => request.changes.find((change) => change.field === field);
  const send = find(SEND_FIELD);
  const draft = find(DRAFT_FIELD);
  const discard = find(DELETE_FIELD);
  const placeholder = isPendingEventExternalId(request.externalId);
  const knownDraft = draftIdOf(request.externalId);
  // An earlier attempt at saving the draft may have made one Gmail has but Commander doesn't know.
  const draftUnknown = placeholder && [send, draft, discard].some((change) => change?.attemptedAt != null);

  async function files(message: OutgoingMessage): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>();
    for (const attachment of message.attachments) {
      if (!request.attachment) throw new WriteRejected('Commander couldn’t find this message’s attachments.');
      found.set(attachment.id, await request.attachment(attachment.id));
    }
    return found;
  }

  // Drafts Gmail holds with this message's Message-ID (made by an attempt whose answer was lost).
  async function draftsOf(message: Pick<OutgoingMessage, 'messageId'>): Promise<string[]> {
    const q = encode(`rfc822msgid:${message.messageId.replace(/^<|>$/g, '')}`);
    const list = await gmail.get('drafts.list', `/drafts?q=${q}&maxResults=10`, gmailDraftList);
    return (list.drafts ?? []).map((each) => each.id);
  }

  async function deleteDraft(draftId: string) {
    try {
      await gmail.get('drafts.delete', `/drafts/${encode(draftId)}`, nothing, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof DraftGone)) throw error;
    }
  }

  async function deleteDrafts(message: Pick<OutgoingMessage, 'messageId'> | null) {
    const ids = new Set<string>();
    if (knownDraft) ids.add(knownDraft);
    if (draftUnknown && message) for (const id of await draftsOf(message)) ids.add(id);
    for (const id of ids) await deleteDraft(id);
  }

  // The message as Gmail has it, naming the Item.
  async function sentItem(id: string, commanderId: string): Promise<SourceItem | null> {
    try {
      const full = await gmail.get('get', `/messages/${encode(id)}?format=full`, gmailMessage);
      return { ...readGmailMessage(full, new Map()), commanderItemId: commanderId };
    } catch (error) {
      if (error instanceof MessageGone) return null;
      throw error;
    }
  }

  // The message an earlier attempt sent, if it got there: one of the sent messages since the attempt
  // (newest first, page by page until one is older), carrying the message's X-Commander-Id or
  // Message-ID. When the sent mail since is more than it reads, it can't tell, and sends nothing.
  async function alreadySent(message: OutgoingMessage, attemptedAt: number): Promise<string | null> {
    const since = attemptedAt - CLOCK_SKEW_MS;
    let pageToken: string | undefined;
    for (let page = 0; page < SENT_PAGES; page++) {
      const list = await gmail.get(
        'list',
        `/messages?labelIds=SENT&maxResults=${NEWEST_SENT}${pageToken ? `&pageToken=${encode(pageToken)}` : ''}`,
        gmailMessageList,
      );
      for (const { id } of list.messages ?? []) {
        let meta: z.infer<typeof metadata>;
        try {
          meta = await gmail.get(
            'meta',
            `/messages/${encode(id)}?format=metadata&metadataHeaders=${COMMANDER_ID_HEADER}&metadataHeaders=Message-ID`,
            metadata,
          );
        } catch (error) {
          if (error instanceof MessageGone) continue;
          throw error;
        }
        const header = (name: string) =>
          meta.payload?.headers
            ?.find((each) => each.name.toLowerCase() === name.toLowerCase())
            ?.value.trim() ?? null;
        if (header(COMMANDER_ID_HEADER) === message.commanderId || header('Message-ID') === message.messageId)
          return id;
        // Newest first: past the attempt, nothing older can be it.
        const at = Number(meta.internalDate);
        if (Number.isFinite(at) && at < since) return null;
      }
      pageToken = list.nextPageToken;
      if (!pageToken) return null;
    }
    throw new WriteRejected(
      'Commander couldn’t tell whether this message already went: look in Gmail’s Sent mail before sending it again.',
    );
  }

  // Sends raw MIME (or saves it as a draft) as JSON, or through the upload endpoint when large.
  function withRaw<T>(
    call: 'send' | 'drafts.create' | 'drafts.update',
    path: string,
    raw: Buffer,
    metadataOf: (rawField: { raw?: string }) => unknown,
    shape: z.ZodType<T>,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<T> {
    if (raw.byteLength <= JSON_RAW_MAX)
      return gmail.get(call, path, shape, { body: metadataOf({ raw: raw.toString('base64url') }), method });
    return gmail.get(call, path, shape, { body: metadataOf({}), method, upload: raw });
  }

  if (send?.value) {
    const message = parseMessage(send.value);
    const threadId = message.sourceThreadId ? { threadId: message.sourceThreadId } : {};
    const earlier = send.attemptedAt != null ? await alreadySent(message, send.attemptedAt) : null;
    let id = earlier;
    if (!id) {
      const raw = await buildMime(message, await files(message), { date: new Date(now()) });
      const sent = await withRaw(
        'send',
        '/messages/send',
        raw,
        (rawField) => ({ ...rawField, ...threadId }),
        sentAnswer,
      );
      id = sent.id;
    }
    await deleteDrafts(message);
    return { item: await sentItem(id, message.commanderId), superseded: [] };
  }

  if (discard?.value) {
    // Discarding names the message (its Message-ID), for a draft Gmail may hold that Commander never
    // learnt of.
    const named = z.object({ messageId: z.string().min(3) }).safeParse(discard.value);
    const message = named.success ? named.data : draft?.value ? parseMessage(draft.value) : null;
    if (knownDraft) await deleteDraft(knownDraft);
    else if (draftUnknown && message) for (const id of await draftsOf(message)) await deleteDraft(id);
    return { item: null, superseded: [] };
  }

  if (draft?.value) {
    const message = parseMessage(draft.value);
    const raw = await buildMime(message, await files(message), { date: new Date(now()) });
    const threadId = message.sourceThreadId ? { threadId: message.sourceThreadId } : {};
    let draftId = knownDraft ?? (draftUnknown ? ((await draftsOf(message))[0] ?? null) : null);
    let saved: z.infer<typeof gmailDraft> | null = null;
    if (draftId) {
      try {
        saved = await withRaw(
          'drafts.update',
          `/drafts/${encode(draftId)}`,
          raw,
          (rawField) => ({ id: draftId, message: { ...rawField, ...threadId } }),
          gmailDraft,
          'PUT',
        );
      } catch (error) {
        // Deleted (or sent) in Gmail meanwhile: saved again as a new draft.
        if (!(error instanceof DraftGone)) throw error;
      }
    }
    if (!saved)
      saved = await withRaw(
        'drafts.create',
        '/drafts',
        raw,
        (rawField) => ({ message: { ...rawField, ...threadId } }),
        gmailDraft,
      );
    draftId = saved.id;
    let item: SourceItem | null = null;
    try {
      const full = await gmail.get('drafts.get', `/drafts/${encode(draftId)}?format=full`, gmailDraftFull);
      item = { ...readGmailDraft(draftId, full.message), commanderItemId: message.commanderId };
    } catch (error) {
      if (!(error instanceof DraftGone)) throw error;
    }
    return { item, superseded: [] };
  }

  return { item: null, superseded: [] };
}

// ---------------------------------------------------------------------------------------------
// Drafts made elsewhere (sync)

/**
 * Every draft Gmail holds, as Items `draft:<id>`: listed with `drafts.list`, and fetched only where its
 * message changed since Commander last saw it (a draft's message id changes whenever it is saved).
 * Returns them with the external ids of the drafts Commander holds that Gmail no longer has.
 */
export async function syncGmailDrafts(
  gmail: GmailClient,
  held: ReadonlyMap<string, string | null>,
): Promise<{ items: SourceItem[]; deleted: string[] }> {
  const listed: { id: string; messageId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.get(
      'drafts.list',
      `/drafts?maxResults=500${pageToken ? `&pageToken=${encode(pageToken)}` : ''}`,
      gmailDraftList,
    );
    listed.push(...(page.drafts ?? []).map((each) => ({ id: each.id, messageId: each.message.id })));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const items: SourceItem[] = [];
  for (const { id, messageId } of listed) {
    const externalId = draftExternalId(id);
    if (held.has(externalId) && held.get(externalId) === messageId) continue;
    try {
      const full = await gmail.get('drafts.get', `/drafts/${encode(id)}?format=full`, gmailDraftFull);
      items.push(readGmailDraft(id, full.message));
    } catch (error) {
      if (!(error instanceof DraftGone)) throw error;
    }
  }
  const present = new Set(listed.map((each) => draftExternalId(each.id)));
  const deleted = [...held.keys()].filter((externalId) => !present.has(externalId));
  return { items, deleted };
}
