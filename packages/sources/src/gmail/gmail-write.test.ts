import type { EmailDetail } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { type FieldChange, type StoredItem, WriteRejected } from '../source';
import { createGmailSource } from './gmail-source';
import write from './recorded/write.json';

// Organising mail through Gmail (#135), against recorded Gmail API v1 responses: archive, read, star,
// labels and Trash, per message and per thread (a thread's messages each written), sent only when
// Gmail doesn't have them yet, with a change made in Gmail since Commander last saw the message
// winning, per field. Each recording pins down the requests, in order, with their bodies.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const recorded = write as unknown as Record<keyof typeof write, Exchange[]>;

const GMAIL = 'https://gmail.test';
const ACCOUNT = 'google:104512345678901234567';
const M = '19a4c3d4e5f6a704';
const M1 = '19a1f0c2d3e4f501';
// When the User made the change: Wednesday 7 October 2026, 09:00 UTC; written a little later.
const MADE_AT = Date.UTC(2026, 9, 7, 9);
const NOW = MADE_AT + 60_000;

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GMAIL.length));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path, body });
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(body).toEqual(next.request.body);
    const { status, headers, body: answer } = next.response;
    return new Response(JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, remaining: () => queue.length };
}

const label = (id: string, name = id) => ({ id, name });
const NAMES: Record<string, string> = {
  INBOX: 'Inbox',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  TRASH: 'Trash',
  IMPORTANT: 'Important',
  CATEGORY_PERSONAL: 'Personal',
  Label_1: 'Receipts',
};

function stored(id: string, labels: string[], sourceVersion: string | null): StoredItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<offsite-1@mail.northwind.test>',
    sourceThreadId: M1,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Re: Q4 offsite dates',
    sentAt: MADE_AT - 86_400_000,
    snippet: '',
    read: !labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    inInbox: labels.includes('INBOX'),
    sentByMe: false,
    labels: labels.map((each) => label(each, NAMES[each] ?? each)),
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...(labels.includes('TRASH') ? { inTrash: true } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
  return { externalId: id, title: detail.subject, people: [], status: 'open', detail };
}

const change = (field: string, value: unknown, synced: unknown): FieldChange => ({
  field,
  value,
  synced,
  madeAt: MADE_AT,
});

async function writeTo(exchanges: Exchange[], item: StoredItem, changes: FieldChange[]) {
  const recording = replay(exchanges);
  const source = createGmailSource({ gmailUrl: () => GMAIL, fetch: recording.fetch, now: () => NOW });
  const result = await source.write?.({
    account: ACCOUNT,
    externalId: item.externalId,
    changes,
    stored: (ids) => (ids.includes(item.externalId) ? [item] : []),
    accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

const detailOf = (result: Awaited<ReturnType<typeof writeTo>>['result']) =>
  result?.item?.detail as EmailDetail;

describe('writing to Gmail', () => {
  it('archives a message: INBOX comes off, and the Item comes back as Gmail now has it', async () => {
    const item = stored(M, ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'], '5009');

    const { result, remaining } = await writeTo(recorded.archive, item, [change('inbox', false, true)]);

    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
    expect(result?.item).toMatchObject({ externalId: M, status: 'archived' });
    expect(detailOf(result)).toMatchObject({ inInbox: false, read: false, sourceVersion: '5012' });
    // messages.get (minimal) twice and messages.modify, in Gmail's quota units.
    expect(result?.cost).toEqual({ requests: 3, complexity: 5 + 5 + 5 });
  });

  it('sends read, star and labels together, in one modify', async () => {
    const item = stored(M, ['UNREAD', 'INBOX', 'Label_1'], '5009');

    const { result, remaining } = await writeTo(recorded.several, item, [
      change('read', true, false),
      change('starred', true, false),
      change('label:Label_1', null, label('Label_1', 'Receipts')),
      change('label:Label_2', label('Label_2', 'Travel'), null),
    ]);

    expect(remaining()).toBe(0);
    expect(detailOf(result)).toMatchObject({ read: true, starred: true, inInbox: true });
    expect(detailOf(result).labels).toEqual([
      label('INBOX', 'Inbox'),
      label('STARRED', 'Starred'),
      label('Label_2', 'Travel'),
    ]);
  });

  it('moves a message to Trash, and back to the inbox (untrash, then INBOX)', async () => {
    const trashed = await writeTo(recorded.trash, stored(M, ['CATEGORY_PERSONAL', 'INBOX'], '5009'), [
      change('trash', true, false),
    ]);
    expect(trashed.remaining()).toBe(0);
    expect(detailOf(trashed.result)).toMatchObject({ inTrash: true });
    expect(trashed.result?.item?.status).toBe('archived');

    const back = await writeTo(recorded.moveToInbox, stored(M, ['TRASH', 'CATEGORY_PERSONAL'], '5014'), [
      change('trash', false, true),
      change('inbox', true, false),
    ]);
    expect(back.remaining()).toBe(0);
    expect(detailOf(back.result).inTrash).toBeUndefined();
    expect(detailOf(back.result).inInbox).toBe(true);
  });

  it('writes a thread’s change to each of its messages', async () => {
    const recording = replay(recorded.thread);
    const source = createGmailSource({ gmailUrl: () => GMAIL, fetch: recording.fetch, now: () => NOW });
    for (const item of [stored(M1, ['IMPORTANT', 'INBOX'], '5009'), stored(M, ['UNREAD', 'INBOX'], '5009')]) {
      const result = await source.write?.({
        account: ACCOUNT,
        externalId: item.externalId,
        changes: [change('inbox', false, true)],
        stored: () => [item],
        accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
        signal: new AbortController().signal,
      });
      expect((result?.item?.detail as EmailDetail | undefined)?.inInbox).toBe(false);
    }
    expect(recording.remaining()).toBe(0);
  });

  it('lets a change made in Gmail since Commander last saw the message win, per field', async () => {
    // Commander last saw the message at history 5009; Gmail has changed it since.
    const item = stored(M, ['UNREAD', 'INBOX'], '5009');

    const { result, remaining } = await writeTo(recorded.newerInGmail, item, [
      change('inbox', false, true),
      change('read', true, false),
    ]);

    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([{ field: 'inbox', by: null, at: NOW }]);
    expect(detailOf(result)).toMatchObject({ inInbox: true, read: true });
  });

  it('sends nothing Gmail already has', async () => {
    const item = stored(M, ['CATEGORY_PERSONAL'], '5012');

    const { result, sent } = await writeTo(recorded.already, item, [change('inbox', false, true)]);

    expect(sent.map((each) => each.method)).toEqual(['GET']);
    expect(result?.superseded).toEqual([]);
    expect(detailOf(result).inInbox).toBe(false);
  });

  it('stops as Couldn’t sync when Gmail no longer has the message, or refuses the change', async () => {
    const item = stored(M, ['INBOX'], '5009');

    await expect(writeTo(recorded.gone, item, [change('inbox', false, true)])).rejects.toBeInstanceOf(
      WriteRejected,
    );
    const refused = await writeTo(recorded.refused, item, [
      change('label:Label_9', label('Label_9'), null),
    ]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WriteRejected);
    expect((refused as Error).message).toBe('Gmail refused this change: Invalid label: Label_9');
  });

  it('refuses a field it doesn’t know', async () => {
    await expect(
      writeTo([], stored(M, ['INBOX'], '5009'), [change('subject', 'New subject', 'Old')]),
    ).rejects.toBeInstanceOf(WriteRejected);
  });
});
