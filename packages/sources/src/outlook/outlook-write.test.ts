import type { EmailDetail, EmailFolder } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type FieldChange, PartNotFound, PartTooLarge, type StoredItem, WriteRejected } from '../source';
import { createOutlookSource } from './outlook-source';
import parts from './recorded/parts.json';
import write from './recorded/write.json';

// Organising and reading Outlook mail (#136), against recorded Microsoft Graph v1.0 responses: read and
// flag as one PATCH; archive, Trash and back, and Move to folder as one move; nothing sent that Outlook
// already has; a change made in Outlook since Commander last synced, later than the User's, winning per
// field; and the reader's attachments and inline images through `$value`. Each recording pins down the
// requests, in order, with their bodies.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown; bodyBase64?: string };
};
const recordedWrites = write as unknown as Record<keyof typeof write, Exchange[]>;
const recordedParts = parts as unknown as Record<keyof typeof parts, Exchange[]>;

const GRAPH = 'https://graph.test/v1.0';
// Each test its own Account, so what one write learnt of the mailbox doesn't carry to the next.
let accounts = 0;
const MADE_AT = Date.UTC(2026, 9, 7, 9);
const OFFSITE = 'AAMkAGI2-msg-offsite-2=';
const CERTIFICATE = 'AAMkAGI2-msg-certificate=';
const INBOX: EmailFolder = { id: 'AAMkAGI2-fld-inbox=', name: 'Inbox', wellKnown: 'inbox' };
const ARCHIVE: EmailFolder = { id: 'AAMkAGI2-fld-archive=', name: 'Archive', wellKnown: 'archive' };
const PROJECTS: EmailFolder = { id: 'AAMkAGI2-fld-projects=', name: 'Projects', wellKnown: null };

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const method = init?.method ?? 'GET';
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(next.request.body);
    const { status, headers, body, bodyBase64 } = next.response;
    const payload = bodyBase64 !== undefined ? Buffer.from(bodyBase64, 'base64') : JSON.stringify(body);
    return new Response(payload, { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

function stored(id: string, fields: Partial<EmailDetail>): StoredItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<offsite-1@mail.northwind.test>',
    sourceThreadId: 'AAQkAGI2-conv-offsite=',
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'RE: Q4 offsite dates',
    sentAt: MADE_AT - 86_400_000,
    snippet: '',
    read: false,
    starred: true,
    inInbox: true,
    sentByMe: false,
    folder: INBOX,
    labels: [],
    categories: [],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return { externalId: id, title: detail.subject, people: [], status: 'open', detail };
}

const change = (field: string, value: unknown, synced: unknown): FieldChange => ({
  field,
  value,
  synced,
  madeAt: MADE_AT,
});

// One adapter per Account, as in the Core: what a write learns of the mailbox serves the next.
const adapters = new Map<
  string,
  { source: ReturnType<typeof createOutlookSource>; use: (fetch: typeof globalThis.fetch) => void }
>();
function adapterFor(account: string) {
  let found = adapters.get(account);
  if (!found) {
    let current: typeof globalThis.fetch = globalThis.fetch;
    const source = createOutlookSource({
      graphUrl: () => GRAPH,
      fetch: (url, init) => current(url, init),
      now: () => MADE_AT + 60_000,
    });
    found = { source, use: (fetch) => (current = fetch) };
    adapters.set(account, found);
  }
  return found;
}

async function writeTo(
  exchanges: Exchange[],
  item: StoredItem,
  changes: FieldChange[],
  account = `outlook:t:${++accounts}`,
) {
  const recording = replay(exchanges);
  const { source, use } = adapterFor(account);
  use(recording.fetch);
  const result = await source.write?.({
    account,
    externalId: item.externalId,
    changes,
    stored: (ids) => (ids.includes(item.externalId) ? [item] : []),
    accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

// Writes after the first know the mailbox's own folders already (the archive test looks them up).
async function primed(account: string) {
  await writeTo(
    recordedWrites.archive,
    stored(OFFSITE, { inInbox: false }),
    [change('inbox', false, true)],
    account,
  );
}

const detailOf = (result: Awaited<ReturnType<typeof writeTo>>['result']) =>
  result?.item?.detail as EmailDetail;

describe('writing to Outlook', () => {
  it('archives a message by moving it to Archive (Outlook’s own folders looked up once), and hands it back as Outlook has it', async () => {
    const item = stored(OFFSITE, { inInbox: false });
    const { result, remaining } = await writeTo(recordedWrites.archive, item, [change('inbox', false, true)]);

    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
    expect(result?.item).toMatchObject({ externalId: OFFSITE, status: 'archived' });
    expect(detailOf(result)).toMatchObject({
      inInbox: false,
      folder: ARCHIVE,
      labels: [],
      read: false,
      starred: true,
    });
    // Three batches of look-ups, the message read, then moved.
    expect(result?.cost.requests).toBe(5);
  });

  it('marks read and flags in one PATCH', async () => {
    const account = 'outlook:t:read';
    await primed(account);
    const item = stored(OFFSITE, { read: true, starred: true });
    const { result, remaining } = await writeTo(
      recordedWrites.readAndFlag,
      item,
      [change('read', true, false), change('starred', true, false)],
      account,
    );
    expect(remaining()).toBe(0);
    expect(detailOf(result)).toMatchObject({ read: true, starred: true, inInbox: true, folder: INBOX });
  });

  it('sends nothing Outlook already has', async () => {
    const account = 'outlook:t:already';
    await primed(account);
    const item = stored(OFFSITE, { read: true, inInbox: false });
    const { result, remaining } = await writeTo(
      recordedWrites.already,
      item,
      [change('read', true, false), change('inbox', false, true)],
      account,
    );
    expect(remaining()).toBe(0);
    expect(result?.cost.requests).toBe(1);
    expect(detailOf(result)).toMatchObject({ folder: ARCHIVE, inInbox: false });
  });

  it('moves a message to a folder (Move to folder)', async () => {
    const account = 'outlook:t:move';
    await primed(account);
    const item = stored(OFFSITE, { read: true, starred: false, inInbox: false, folder: PROJECTS });
    const { result, remaining } = await writeTo(
      recordedWrites.moveToFolder,
      item,
      [change('folder', PROJECTS, INBOX), change('inbox', false, true)],
      account,
    );
    expect(remaining()).toBe(0);
    expect(detailOf(result)).toMatchObject({
      folder: PROJECTS,
      inInbox: false,
      labels: [{ id: PROJECTS.id, name: 'Projects' }],
    });
  });

  it('leaves a field as Outlook has it when Outlook changed it later than the User did', async () => {
    const account = 'outlook:t:newer';
    await primed(account);
    const item = stored(OFFSITE, { read: true, starred: false, inInbox: false, folder: PROJECTS });
    const { result, remaining } = await writeTo(
      recordedWrites.superseded,
      item,
      [change('folder', PROJECTS, INBOX), change('inbox', false, true)],
      account,
    );
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([
      { field: 'folder', by: null, at: Date.parse('2026-10-07T09:30:00Z') },
    ]);
    expect(detailOf(result)).toMatchObject({ folder: ARCHIVE, inInbox: false });
  });

  it('moves a message to Deleted Items and back to the folder it came from', async () => {
    const account = 'outlook:t:trash';
    await primed(account);
    const trashed = stored(CERTIFICATE, { read: true, starred: false, inTrash: true });
    const first = await writeTo(recordedWrites.trash, trashed, [change('trash', true, false)], account);
    expect(first.remaining()).toBe(0);
    expect(detailOf(first.result)).toMatchObject({ inTrash: true, folder: INBOX, inInbox: true });
    expect(first.result?.item?.status).toBe('archived');

    const back = stored(CERTIFICATE, { read: true, starred: false });
    const second = await writeTo(recordedWrites.restore, back, [change('trash', false, true)], account);
    expect(second.remaining()).toBe(0);
    expect(detailOf(second.result).inTrash).toBeUndefined();
    expect(detailOf(second.result)).toMatchObject({ folder: INBOX, inInbox: true });
    expect(second.result?.item?.status).toBe('open');
  });

  it('refuses a change to a message Outlook no longer has, and fields it can’t change', async () => {
    const account = 'outlook:t:gone';
    await primed(account);
    const item = stored('AAMkAGI2-msg-vanished=', {});
    await expect(writeTo(recordedWrites.gone, item, [change('read', true, false)], account)).rejects.toThrow(
      WriteRejected,
    );
    await expect(
      writeTo([], item, [change('label:x', { id: 'x', name: 'X' }, null)], account),
    ).rejects.toThrow(WriteRejected);
  });
});

describe('the reader’s parts from Outlook', () => {
  const fetchPart = (
    exchanges: Exchange[],
    externalId: string,
    part: { partId: string } | { contentId: string },
    maxBytes = 1_000_000,
  ) => {
    const recording = replay(exchanges);
    const source = createOutlookSource({ graphUrl: () => GRAPH, fetch: recording.fetch });
    return {
      done: source.fetchPart?.({
        account: 'outlook:t:parts',
        externalId,
        part,
        maxBytes,
        accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
        signal: new AbortController().signal,
      }),
      ...recording,
    };
  };

  it('fetches an attachment by its id, after checking its size', async () => {
    const { done, remaining } = fetchPart(recordedParts.byPartId, CERTIFICATE, {
      partId: 'AAMkAGI2-att-certificate-csr=',
    });
    const part = await done;
    expect(remaining()).toBe(0);
    expect(part).toMatchObject({
      partId: 'AAMkAGI2-att-certificate-csr=',
      name: 'staging.csr',
      type: 'application/pkcs10',
    });
    expect(Buffer.from(part?.bytes ?? []).toString()).toContain('BEGIN CERTIFICATE REQUEST');
  });

  it('finds an inline image by its Content-ID', async () => {
    const { done, remaining } = fetchPart(recordedParts.byContentId, 'AAMkAGI2-msg-offsite-1=', {
      contentId: '<image001.png@01DB1A2B.3C4D5E60>',
    });
    const part = await done;
    expect(remaining()).toBe(0);
    expect(part).toMatchObject({
      partId: 'AAMkAGI2-att-offsite-logo=',
      name: 'image001.png',
      type: 'image/png',
    });
    expect(part?.bytes.slice(1, 4)).toEqual(new Uint8Array(Buffer.from('PNG')));
  });

  it('refuses a part too large before fetching it, and one Outlook no longer has', async () => {
    const large = fetchPart(
      recordedParts.byPartId,
      CERTIFICATE,
      { partId: 'AAMkAGI2-att-certificate-csr=' },
      100,
    );
    await expect(large.done).rejects.toThrow(PartTooLarge);
    expect(large.remaining()).toBe(1);
    const gone = fetchPart(recordedParts.gone, CERTIFICATE, { partId: 'AAMkAGI2-att-certificate-csr=' });
    await expect(gone.done).rejects.toThrow(PartNotFound);
  });
});
