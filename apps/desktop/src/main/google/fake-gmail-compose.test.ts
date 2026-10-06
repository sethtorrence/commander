import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EmailDetail, OutgoingMessage, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mimeHeader } from '../../../../../packages/sources/src/email-send/parse-mime';
import { createGmailSource } from '../../../../../packages/sources/src/gmail/gmail-source';
import type { FieldChange, SyncPage } from '../../../../../packages/sources/src/source';
import { createFakeGmail, type FakeGmail } from './fake-gmail';

// The fake Gmail's writing side (#138) against Commander's own Gmail adapter: a draft saved, updated
// and listed; a reply sent with an attachment into its thread, its draft removed; and the sent message
// synced back as Gmail would show it. What the end-to-end tests rely on, checked without a window.

const ME = 'alex@gmail.test';
const COMMANDER = '7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6';
const PDF = {
  id: '0b5d4c3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
  name: 'plan.pdf',
  type: 'application/pdf',
  size: 9,
};

let gmail: FakeGmail;
let server: Server;
let base: string;

beforeEach(async () => {
  gmail = createFakeGmail();
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    void gmail.handle(request, response, url, ME);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function message(fields: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    commanderId: COMMANDER,
    messageId: `<${COMMANDER}@gmail.test>`,
    mode: 'reply',
    from: { name: 'Alex Kim', address: ME },
    to: [{ name: 'Dana Whitfield', address: 'dana@northwind.test' }],
    cc: [],
    bcc: [],
    subject: 'Re: Q4 offsite dates',
    html: '<div dir="ltr"><div>Thursday works.</div></div>',
    text: 'Thursday works.',
    attachments: [],
    inReplyTo: '<offsite-1@mail.northwind.test>',
    references: ['<offsite-1@mail.northwind.test>'],
    sourceThreadId: 'thread-offsite',
    replyToExternalId: 'm1',
    ...fields,
  };
}

const source = () => createGmailSource({ gmailUrl: () => base });
const write = (externalId: string, changes: FieldChange[]) =>
  source().write?.({
    account: 'google:alex',
    externalId,
    changes,
    accessToken: async () => ({ token: 't', kind: 'oauth' }),
    attachment: async () => new TextEncoder().encode('%PDF-1.7\n'),
    signal: new AbortController().signal,
  });
const change = (field: string, value: unknown): FieldChange => ({
  field,
  value,
  synced: null,
  madeAt: Date.now(),
});

describe('the fake Gmail’s writing side', () => {
  it('saves a draft, sends it with its attachment into its thread, and removes the draft', async () => {
    const saved = await write(`commander:${COMMANDER}`, [change('draft', message())]);
    const draftId = saved?.item?.externalId as string;
    expect(draftId).toMatch(/^draft:r-/);
    expect(gmail.drafts(ME)).toEqual([expect.objectContaining({ subject: 'Re: Q4 offsite dates' })]);

    const sent = await write(draftId, [change('send', message({ attachments: [PDF] }))]);

    expect(gmail.drafts(ME)).toEqual([]);
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0]?.threadId).toBe('thread-offsite');
    expect(mimeHeader(gmail.sent[0]?.mime as never, 'In-Reply-To')).toBe('<offsite-1@mail.northwind.test>');
    expect(sent?.item).toMatchObject({ commanderItemId: COMMANDER });
    const detail = sent?.item?.detail as EmailDetail;
    expect(detail).toMatchObject({
      sentByMe: true,
      sourceThreadId: 'thread-offsite',
      messageId: `<${COMMANDER}@gmail.test>`,
    });
    expect(detail.attachments).toEqual([
      expect.objectContaining({ name: 'plan.pdf', size: 9, inline: false }),
    ]);
  });

  it('syncs the sent message back, and lists drafts made in Gmail', async () => {
    const pages: SyncPage[] = [];
    const held = new Map<string, SourceItem>();
    const sync = (cursor: unknown) =>
      source().sync({
        account: 'google:alex',
        cursor,
        mode: 'full',
        connectedAt: Date.now(),
        heldIds: () => [...held.keys()],
        stored: (ids) =>
          ids.flatMap((id) => {
            const item = held.get(id);
            return item
              ? [
                  {
                    externalId: id,
                    title: item.title,
                    people: [],
                    status: 'open' as const,
                    detail: item.detail ?? null,
                  },
                ]
              : [];
          }),
        accessToken: async () => ({ token: 't', kind: 'oauth' }),
        save: (page) => {
          pages.push(page);
          for (const item of page.items) held.set(item.externalId, item);
          for (const id of page.deleted) held.delete(id);
        },
        signal: new AbortController().signal,
      });
    const first = await sync(null);
    gmail.saveDraft(ME, {
      from: ME,
      to: 'dana@northwind.test',
      subject: 'Lunch?',
      text: 'Are you free',
      date: Date.now(),
    });
    await write(`commander:${COMMANDER}`, [change('send', message({ mode: 'new', sourceThreadId: null }))]);
    await sync(first.cursor);

    const items = [...held.values()];
    expect(items.find((item) => (item.detail as EmailDetail).draft)?.title).toBe('Lunch?');
    expect(items.find((item) => (item.detail as EmailDetail).sentByMe)?.title).toBe('Re: Q4 offsite dates');
  });
});
