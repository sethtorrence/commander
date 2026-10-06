import {
  CANCEL_SEND_FIELD,
  DELETE_FIELD,
  DRAFT_FIELD,
  type EmailDetail,
  type OutgoingMessage,
  pendingEventExternalId,
  SEND_FIELD,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type FieldChange, WriteRejected } from '../source';
import { UPLOAD_CHUNK } from './compose';
import { createOutlookSource } from './outlook-source';
import compose from './recorded/compose.json';
import write from './recorded/write.json';

// Writing email through Outlook (#138), against recorded Microsoft Graph v1.0 responses: a reply's
// draft made from the message it answers, attachments (in the request up to 3 MB, larger ones through
// an upload session), sending, and the never-twice rule for a send whose earlier attempt has an unknown
// outcome. Each recording pins down the requests, in order, with their bodies; every write starts by
// looking up the mailbox's own folders (the recorded batch organising writes share).

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
const recorded = compose as unknown as Record<keyof typeof compose, Exchange[]>;
const lookUp = (write as unknown as { archive: Exchange[] }).archive.slice(0, 3);

const GRAPH = 'https://graph.test/v1.0';
let accounts = 0;
const MADE_AT = Date.UTC(2026, 9, 7, 9);
const COMMANDER = '7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6';
const ORIGINAL = 'AAMkAGI2-msg-offsite-2=';
const DRAFT = 'AAMkAGI2-msg-draft-commander=';
const SENT = 'AAMkAGI2-msg-sent-commander=';
const PLACEHOLDER = pendingEventExternalId(COMMANDER);
const PDF = {
  id: '0b5d4c3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
  name: 'plan.pdf',
  type: 'application/pdf',
  size: 9,
};
const DECK = {
  id: '1c6e5d4b-3a2f-4e1d-8c9b-8a7f6e5d4c3b',
  name: 'deck.pdf',
  type: 'application/pdf',
  size: 5_242_880,
};

function replay(exchanges: Exchange[]) {
  const queue = [...lookUp, ...exchanges];
  const uploads: { range: string | null; size: number; authorization: string | null }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    const path = full.startsWith(GRAPH) ? decodeURIComponent(full.slice(GRAPH.length)) : full;
    const method = init?.method ?? 'GET';
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    const headers = new Headers(init?.headers);
    if (method === 'PUT') {
      const body = init?.body as Uint8Array;
      uploads.push({
        range: headers.get('content-range'),
        size: body.byteLength,
        authorization: headers.get('authorization'),
      });
    } else expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(next.request.body);
    const { status, headers: answer, body } = next.response;
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
      status,
      headers: answer,
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, uploads, remaining: () => queue.length };
}

function message(fields: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    commanderId: COMMANDER,
    messageId: `<${COMMANDER}@contoso.test>`,
    mode: 'reply',
    from: { name: 'Sam Rivera', address: 'sam@contoso.test' },
    to: [{ name: 'Dana Whitfield', address: 'dana@northwind.test' }],
    cc: [],
    bcc: [],
    subject: 'RE: Q4 offsite dates',
    html: '<div dir="ltr"><div>Thursday works for me.</div></div>',
    text: 'Thursday works for me.',
    attachments: [],
    inReplyTo: '<offsite-2@mail.northwind.test>',
    references: ['<offsite-1@mail.northwind.test>', '<offsite-2@mail.northwind.test>'],
    sourceThreadId: 'AAQkAGI2-conv-offsite=',
    replyToExternalId: ORIGINAL,
    ...fields,
  };
}

const change = (field: string, value: unknown, attemptedAt?: number): FieldChange => ({
  field,
  value,
  synced: null,
  madeAt: MADE_AT,
  ...(attemptedAt !== undefined ? { attemptedAt } : {}),
});

async function writeTo(exchanges: Exchange[], externalId: string, changes: FieldChange[]) {
  const recording = replay(exchanges);
  const source = createOutlookSource({ graphUrl: () => GRAPH, fetch: recording.fetch, now: () => MADE_AT });
  accounts += 1;
  const result = await source.write?.({
    account: `outlook:fake-tenant-0001:compose-${accounts}`,
    externalId,
    changes,
    stored: () => [],
    accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
    attachment: async (id) => {
      if (id === PDF.id) return new TextEncoder().encode('%PDF-1.7\n');
      if (id === DECK.id) return new Uint8Array(DECK.size).fill(7);
      throw new Error(`No attachment ${id}`);
    },
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

const detailOf = (result: Awaited<ReturnType<typeof writeTo>>['result']) =>
  result?.item?.detail as EmailDetail;

describe('drafts in Outlook', () => {
  it('makes a reply’s draft from the message it answers, so Outlook threads it, marked with Commander’s id', async () => {
    const { result, remaining } = await writeTo(recorded.draftReply, PLACEHOLDER, [
      change(DRAFT_FIELD, message()),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: DRAFT, commanderItemId: COMMANDER, status: 'archived' });
    expect(detailOf(result)).toMatchObject({
      draft: true,
      inInbox: false,
      // Outlook's own Message-ID for it, which the sent copy keeps.
      messageId: '<PH0PR11MB5000-commander-reply@PH0PR11MB5000.namprd11.prod.outlook.com>',
    });
  });

  it('updates the draft Outlook holds', async () => {
    const { result, remaining } = await writeTo(recorded.draftUpdate, DRAFT, [
      change(DRAFT_FIELD, message()),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item?.externalId).toBe(DRAFT);
  });

  it('discards a draft', async () => {
    const { result, remaining } = await writeTo(recorded.discard, DRAFT, [
      change(DELETE_FIELD, { commanderId: COMMANDER, messageId: '<x@y>' }),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toBeNull();
  });
});

describe('sending through Outlook', () => {
  it('sends the draft with its attachment, and hands back the copy in Sent Items', async () => {
    const { result, remaining } = await writeTo(recorded.sendWithAttachment, DRAFT, [
      change(SEND_FIELD, message({ attachments: [PDF] })),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: SENT, commanderItemId: COMMANDER });
    expect(detailOf(result)).toMatchObject({ sentByMe: true, inInbox: false });
    expect(detailOf(result).draft).toBeUndefined();
    expect(detailOf(result).attachments).toEqual([
      {
        name: 'plan.pdf',
        type: 'application/pdf',
        size: 9,
        partId: 'AAMkAGI2-att-plan-sent=',
        inline: false,
      },
    ]);
  });

  it('uploads attachments over 3 MB through an upload session, in chunks, without the User’s token', async () => {
    const { result, uploads, remaining } = await writeTo(recorded.sendNewLarge, PLACEHOLDER, [
      change(
        SEND_FIELD,
        message({
          mode: 'new',
          subject: 'Plans',
          inReplyTo: null,
          references: [],
          replyToExternalId: null,
          attachments: [DECK],
        }),
      ),
    ]);

    expect(remaining()).toBe(0);
    expect(uploads).toEqual([
      { range: `bytes 0-${UPLOAD_CHUNK - 1}/${DECK.size}`, size: UPLOAD_CHUNK, authorization: null },
      {
        range: `bytes ${UPLOAD_CHUNK}-${DECK.size - 1}/${DECK.size}`,
        size: DECK.size - UPLOAD_CHUNK,
        authorization: null,
      },
    ]);
    // Outlook is still filing it in Sent Items: the draft comes back as sent, under its Message-ID.
    expect(result?.item).toMatchObject({ externalId: DRAFT, commanderItemId: COMMANDER });
    expect(detailOf(result)).toMatchObject({ sentByMe: true, folder: { wellKnown: 'sentitems' } });
  });

  it('never sends twice: an earlier attempt found in Sent Items counts as sent', async () => {
    const { result, remaining } = await writeTo(recorded.sendAlreadySent, DRAFT, [
      change(SEND_FIELD, message(), MADE_AT + 1_000),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: SENT, commanderItemId: COMMANDER });
  });

  it('never sends twice: a draft gone from Outlook since an earlier attempt counts as sent', async () => {
    const [sentItems, outbox, draftRead] = recorded.sendNotYetSent as [Exchange, Exchange, Exchange];
    const gone = {
      request: draftRead.request,
      response: {
        status: 404,
        headers: {},
        body: { error: { code: 'ErrorItemNotFound', message: 'Not found.' } },
      },
    };
    const { result, remaining } = await writeTo([sentItems, outbox, gone], DRAFT, [
      change(SEND_FIELD, message(), MADE_AT + 1_000),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toBeNull();
  });

  it('sends once an earlier attempt is known not to have got there', async () => {
    const { result, remaining } = await writeTo(recorded.sendNotYetSent, DRAFT, [
      change(SEND_FIELD, message(), MADE_AT + 1_000),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item?.externalId).toBe(SENT);
  });

  it('stops at once when Outlook refuses the message, with its reason', async () => {
    const outcome = await writeTo(recorded.sendRefused, DRAFT, [change(SEND_FIELD, message())]).catch(
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(WriteRejected);
    expect((outcome as Error).message).toBe(
      "Outlook wouldn’t make this change: At least one recipient isn't valid.",
    );
  });
});

describe('send later held by Microsoft (#139)', () => {
  const OUTBOX = 'AAMkAGI2-msg-outbox-commander=';
  const AT_EIGHT = Date.UTC(2026, 9, 8, 8);

  it('sends the draft with the deferred-send property, and hands back the copy Exchange holds, still unsent', async () => {
    const { result, remaining } = await writeTo(recorded.sendDeferred, DRAFT, [
      change(SEND_FIELD, message({ deferUntil: AT_EIGHT })),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: OUTBOX, commanderItemId: COMMANDER });
    // A draft in Commander, in no thread, until Exchange sends it at its time.
    expect(detailOf(result)).toMatchObject({ draft: true, inInbox: false, folder: { wellKnown: 'outbox' } });
  });

  it('cancels it before its time: taken out of the Outbox', async () => {
    const { result, remaining } = await writeTo(recorded.cancelHeld, PLACEHOLDER, [
      change(CANCEL_SEND_FIELD, { commanderId: COMMANDER, messageId: '<x@y>' }),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toBeNull();
  });

  it('a cancel too late finds it sent, and hands back the sent message: nothing goes again', async () => {
    const { result, remaining } = await writeTo(recorded.cancelTooLate, PLACEHOLDER, [
      change(CANCEL_SEND_FIELD, { commanderId: COMMANDER, messageId: '<x@y>' }),
      change(SEND_FIELD, message({ deferUntil: AT_EIGHT + 86_400_000 })),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: SENT, commanderItemId: COMMANDER });
    expect(detailOf(result).draft).toBeUndefined();
  });

  it('changes its time: out of the Outbox, then made and held again for the new time', async () => {
    const { result, remaining } = await writeTo(recorded.rescheduleHeld, PLACEHOLDER, [
      change(CANCEL_SEND_FIELD, { commanderId: COMMANDER, messageId: '<x@y>' }),
      change(SEND_FIELD, message({ deferUntil: AT_EIGHT + 86_400_000 })),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toMatchObject({ externalId: OUTBOX, commanderItemId: COMMANDER });
    expect(detailOf(result).draft).toBe(true);
  });
});
