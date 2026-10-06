import {
  DELETE_FIELD,
  DRAFT_FIELD,
  type EmailDetail,
  type OutgoingMessage,
  pendingEventExternalId,
  SEND_FIELD,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { mimeHeader, mimeLeaves, parseMime } from '../email-send/parse-mime';
import { type FieldChange, WriteRejected } from '../source';
import { connectGmail, createPacer, JSON_RAW_MAX } from './client';
import { syncGmailDrafts } from './compose';
import { createGmailSource } from './gmail-source';
import compose from './recorded/compose.json';

// Writing email through Gmail (#138), against recorded Gmail API v1 responses: new mail, replies with
// their thread, drafts saved and discarded, and the never-twice rule for a send whose earlier attempt
// has an unknown outcome. Each recording pins down the requests, in order; a raw message is checked
// as the MIME it decodes to.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const recorded = compose as unknown as Record<keyof typeof compose, Exchange[]>;

const GMAIL = 'https://gmail.test';
const ACCOUNT = 'google:104512345678901234567';
const THREAD = '19a1f0c2d3e4f501';
const SENT = '19b0d1e2f3a4b5c6';
const COMMANDER = '7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6';
const MADE_AT = Date.UTC(2026, 9, 7, 9);
const NOW = MADE_AT + 10_000;
const ATTACHMENT = {
  id: '0b5d4c3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
  name: 'plan.pdf',
  type: 'application/pdf',
  size: 9,
};

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const raws: Buffer[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(GMAIL.length);
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body) as Record<string, unknown> & { message?: { raw?: string } };
      // A raw message is checked as MIME, not as base64.
      if (typeof parsed.raw === 'string') {
        raws.push(Buffer.from(parsed.raw, 'base64url'));
        parsed.raw = '<raw>';
      }
      if (typeof parsed.message?.raw === 'string') {
        raws.push(Buffer.from(parsed.message.raw, 'base64url'));
        parsed.message = { ...parsed.message, raw: '<raw>' };
      }
      body = parsed;
    }
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(body).toEqual(next.request.body);
    const { status, headers, body: answer } = next.response;
    return new Response(answer === null ? null : JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, raws, remaining: () => queue.length };
}

function message(fields: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    commanderId: COMMANDER,
    messageId: `<${COMMANDER}@home.test>`,
    mode: 'reply',
    from: { name: 'Seth Torrence', address: 'seth@home.test' },
    to: [{ name: 'Dana Whitfield', address: 'dana@northwind.test' }],
    cc: [],
    bcc: [],
    subject: 'Re: Q4 offsite dates',
    html: '<div dir="ltr"><div>Thursday works for me.</div></div>',
    text: 'Thursday works for me.',
    attachments: [],
    inReplyTo: '<offsite-2@mail.northwind.test>',
    references: ['<offsite-1@mail.northwind.test>', '<offsite-2@mail.northwind.test>'],
    sourceThreadId: THREAD,
    replyToExternalId: '19a2a1b2c3d4e502',
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

async function write(
  exchanges: Exchange[],
  externalId: string,
  changes: FieldChange[],
  files: Record<string, Uint8Array> = {},
) {
  const recording = replay(exchanges);
  const source = createGmailSource({ gmailUrl: () => GMAIL, fetch: recording.fetch, now: () => NOW });
  const result = await source.write?.({
    account: ACCOUNT,
    externalId,
    changes,
    stored: () => [],
    accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
    attachment: async (id) => {
      const bytes = files[id];
      if (!bytes) throw new Error(`No attachment ${id}`);
      return bytes;
    },
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

const PLACEHOLDER = pendingEventExternalId(COMMANDER);
const detailOf = (result: Awaited<ReturnType<typeof write>>['result']) => result?.item?.detail as EmailDetail;

describe('sending through Gmail', () => {
  it('sends a reply in its Gmail thread, threaded by its headers, and hands back the sent message', async () => {
    const { result, raws, remaining } = await write(recorded.sendReply, PLACEHOLDER, [
      change(SEND_FIELD, message()),
    ]);

    expect(remaining()).toBe(0);
    const sent = parseMime(raws[0] as Buffer);
    expect(mimeHeader(sent, 'In-Reply-To')).toBe('<offsite-2@mail.northwind.test>');
    expect(mimeHeader(sent, 'References')).toBe(
      '<offsite-1@mail.northwind.test> <offsite-2@mail.northwind.test>',
    );
    expect(mimeHeader(sent, 'From')).toBe('Seth Torrence <seth@home.test>');
    expect(mimeHeader(sent, 'Message-ID')).toBe(`<${COMMANDER}@home.test>`);
    expect(mimeHeader(sent, 'X-Commander-Id')).toBe(COMMANDER);
    expect(mimeLeaves(sent).map((part) => part.type)).toEqual(['text/plain', 'text/html']);
    // The sent message, naming its Item, so it shows once in its thread.
    expect(result?.item).toMatchObject({ externalId: SENT, commanderItemId: COMMANDER, kind: 'email' });
    expect(detailOf(result)).toMatchObject({
      sentByMe: true,
      sourceThreadId: THREAD,
      messageId: `<${COMMANDER}@home.test>`,
      inReplyTo: '<offsite-2@mail.northwind.test>',
    });
  });

  it('sends new mail in a thread of its own', async () => {
    const { result, raws } = await write(recorded.sendNew, PLACEHOLDER, [
      change(
        SEND_FIELD,
        message({ mode: 'new', subject: 'Hello', inReplyTo: null, references: [], sourceThreadId: null }),
      ),
    ]);

    const sent = parseMime(raws[0] as Buffer);
    expect(mimeHeader(sent, 'In-Reply-To')).toBeNull();
    expect(mimeHeader(sent, 'Subject')).toBe('Hello');
    expect(result?.item).toMatchObject({ externalId: SENT, commanderItemId: COMMANDER });
  });

  it('sends attachments with the message, and removes the draft Gmail holds', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n');
    const { raws, remaining } = await write(
      recorded.sendFromDraft,
      'draft:r-4719350213',
      [change(DRAFT_FIELD, message()), change(SEND_FIELD, message({ attachments: [ATTACHMENT] }))],
      { [ATTACHMENT.id]: pdf },
    );

    expect(remaining()).toBe(0);
    const sent = parseMime(raws[0] as Buffer);
    expect(sent.type).toBe('multipart/mixed');
    const attached = sent.parts[1];
    expect(attached).toMatchObject({
      type: 'application/pdf',
      filename: 'plan.pdf',
      disposition: 'attachment',
    });
    expect(attached?.body.toString('utf8')).toBe('%PDF-1.7\n');
  });

  it('never sends twice: an earlier attempt found among the sent mail counts as sent', async () => {
    const { result, raws, remaining } = await write(recorded.sendAlreadySent, 'draft:r-4719350213', [
      change(SEND_FIELD, message(), MADE_AT + 1_000),
    ]);

    expect(remaining()).toBe(0);
    expect(raws).toEqual([]);
    expect(result?.item).toMatchObject({ externalId: SENT, commanderItemId: COMMANDER });
  });

  it('sends once an earlier attempt is known not to have got there, and removes any draft it left', async () => {
    const { result, raws, remaining } = await write(recorded.sendNotYetSent, PLACEHOLDER, [
      change(SEND_FIELD, message(), MADE_AT + 1_000),
    ]);

    expect(remaining()).toBe(0);
    expect(raws).toHaveLength(1);
    expect(result?.item).toMatchObject({ externalId: SENT });
  });

  it('sends nothing when it can’t tell whether an earlier attempt got there (more sent mail since than it reads)', async () => {
    const page = (n: number): Exchange => ({
      request: {
        method: 'GET',
        path: `/gmail/v1/users/me/messages?labelIds=SENT&maxResults=25${n ? `&pageToken=p${n}` : ''}`,
      },
      response: {
        status: 200,
        headers: {},
        body: { messages: [{ id: `new-${n}`, threadId: `new-${n}` }], nextPageToken: `p${n + 1}` },
      },
    });
    const meta = (n: number): Exchange => ({
      request: {
        method: 'GET',
        path: `/gmail/v1/users/me/messages/new-${n}?format=metadata&metadataHeaders=X-Commander-Id&metadataHeaders=Message-ID`,
      },
      response: {
        status: 200,
        headers: {},
        body: { id: `new-${n}`, internalDate: String(NOW), payload: { headers: [] } },
      },
    });
    const outcome = await write(
      [0, 1, 2, 3].flatMap((n) => [page(n), meta(n)]),
      PLACEHOLDER,
      [change(SEND_FIELD, message(), MADE_AT + 1_000)],
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(WriteRejected);
    expect((outcome as Error).message).toMatch(/look in Gmail’s Sent mail before sending it again/);
  });

  it('stops at once when Gmail refuses the message, with its reason', async () => {
    const outcome = await write(recorded.sendRefused, PLACEHOLDER, [change(SEND_FIELD, message())]).catch(
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(WriteRejected);
    expect((outcome as Error).message).toBe('Gmail refused to send this message: Invalid To header');
  });

  it('sends a message over 4 MB through Gmail’s upload endpoint', async () => {
    const big = new Uint8Array(JSON_RAW_MAX + 1024).fill(65);
    const requests: { url: string; type: string | null; body: Buffer }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : Buffer.alloc(0);
      requests.push({ url: String(url), type: new Headers(init?.headers).get('content-type'), body });
      if (String(url).includes('/upload/'))
        return Response.json({ id: SENT, threadId: THREAD, labelIds: ['SENT'] });
      return Response.json(recorded.sendReply[1]?.response.body);
    }) as typeof globalThis.fetch;
    const source = createGmailSource({ gmailUrl: () => GMAIL, fetch, now: () => NOW });
    await source.write?.({
      account: ACCOUNT,
      externalId: PLACEHOLDER,
      changes: [change(SEND_FIELD, message({ attachments: [{ ...ATTACHMENT, size: big.length }] }))],
      accessToken: async () => ({ token: 't', kind: 'oauth' }),
      attachment: async () => big,
      signal: new AbortController().signal,
    });

    const [upload] = requests;
    expect(upload?.url).toBe(`${GMAIL}/upload/gmail/v1/users/me/messages/send?uploadType=multipart`);
    expect(upload?.type).toMatch(/^multipart\/related; boundary=/);
    const parts = parseMime(
      Buffer.concat([Buffer.from(`Content-Type: ${upload?.type}\r\n\r\n`), upload?.body ?? Buffer.alloc(0)]),
    );
    expect(parts.parts.map((part) => part.type)).toEqual(['application/json', 'message/rfc822']);
    expect(JSON.parse(parts.parts[0]?.body.toString('utf8') ?? '')).toEqual({ threadId: THREAD });
  });
});

describe('drafts in Gmail', () => {
  it('saves a new draft, which comes back as the Item draft:<id>', async () => {
    const { result, raws, remaining } = await write(recorded.draftCreate, PLACEHOLDER, [
      change(DRAFT_FIELD, message({ text: 'Thursday works' })),
    ]);

    expect(remaining()).toBe(0);
    expect(raws).toHaveLength(1);
    expect(result?.item).toMatchObject({ externalId: 'draft:r-4719350213', commanderItemId: COMMANDER });
    expect(detailOf(result)).toMatchObject({
      draft: true,
      sourceVersion: '19b0aa0000000001',
      inInbox: false,
    });
  });

  it('updates the draft Gmail holds', async () => {
    const { result, remaining } = await write(recorded.draftUpdate, 'draft:r-4719350213', [
      change(DRAFT_FIELD, message({ text: 'Thursday works' })),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item?.externalId).toBe('draft:r-4719350213');
  });

  it('saves it again as a new draft when it was deleted in Gmail', async () => {
    const { result, remaining } = await write(recorded.draftUpdateGone, 'draft:r-4719350213', [
      change(DRAFT_FIELD, message()),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item?.externalId).toBe('draft:r-5000000001');
  });

  it('discards a draft', async () => {
    const { result, remaining } = await write(recorded.discard, 'draft:r-4719350213', [
      change(DELETE_FIELD, { messageId: `<${COMMANDER}@home.test>` }),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.item).toBeNull();
  });

  it('syncs drafts made elsewhere, fetching only those it doesn’t hold as they are', async () => {
    const recording = replay(recorded.syncDrafts);
    const gmail = connectGmail({
      gmailUrl: GMAIL,
      fetch: recording.fetch,
      now: () => NOW,
      pacer: createPacer(
        () => NOW,
        async () => {},
      ),
      accessToken: async () => ({ token: 't', kind: 'oauth' }),
      signal: new AbortController().signal,
    });

    const found = await syncGmailDrafts(
      gmail,
      new Map([
        ['draft:r-4719350213', '19b0aa0000000001'],
        ['draft:r-gone', '19b0aa0000000000'],
      ]),
    );

    expect(recording.remaining()).toBe(0);
    expect(found.deleted).toEqual(['draft:r-gone']);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ externalId: 'draft:r-6000000002', title: 'Lunch next week?' });
    expect(found.items[0]?.detail).toMatchObject({ draft: true, messageId: '<CAB+lunch@mail.gmail.com>' });
  });
});
