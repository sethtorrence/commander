import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EmailDetail, OutgoingMessage } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOutlookSource } from '../../../../../packages/sources/src/outlook/outlook-source';
import type { FieldChange } from '../../../../../packages/sources/src/source';
import { createFakeOutlookMail, type FakeMailUser, type FakeOutlookMail } from './fake-outlook-mail';

// The fake Graph's writing side (#138) against Commander's own Outlook adapter: a reply's draft made
// from the message it answers, an attachment over 3 MB through an upload session, the send filed in
// Sent Items, and a draft discarded. What the end-to-end tests rely on, checked without a window.

const USER: FakeMailUser = { id: 'u-sam', displayName: 'Sam Rivera', userPrincipalName: 'sam@contoso.test' };
const COMMANDER = '7f1c2a10-3b4c-4d5e-8f90-a1b2c3d4e5f6';
const DECK = {
  id: '1c6e5d4b-3a2f-4e1d-8c9b-8a7f6e5d4c3b',
  name: 'deck.pdf',
  type: 'application/pdf',
  size: 4 * 1024 * 1024,
};

let mail: FakeOutlookMail;
let server: Server;
let graph: string;
let original: string;

beforeEach(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (mail.handlesUpload(request, url)) return void mail.upload(request, url, response);
    if (mail.handles(request, url)) return void mail.handle(request, url, response, USER);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  graph = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1.0`;
  mail = createFakeOutlookMail(() => graph);
  original = mail.deliver(USER.id, {
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [{ name: 'Sam Rivera', address: USER.userPrincipalName }],
    subject: 'Q4 offsite dates',
    text: 'Which dates work?',
    date: Date.now() - 60_000,
    messageId: '<offsite-1@mail.northwind.test>',
    conversationId: 'AAQkFake-conv-offsite',
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function message(fields: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    commanderId: COMMANDER,
    messageId: `<${COMMANDER}@contoso.test>`,
    mode: 'reply',
    from: { name: 'Sam Rivera', address: USER.userPrincipalName },
    to: [{ name: 'Dana Whitfield', address: 'dana@northwind.test' }],
    cc: [],
    bcc: [],
    subject: 'RE: Q4 offsite dates',
    html: '<div dir="ltr"><div>Thursday works.</div></div>',
    text: 'Thursday works.',
    attachments: [],
    inReplyTo: '<offsite-1@mail.northwind.test>',
    references: ['<offsite-1@mail.northwind.test>'],
    sourceThreadId: 'AAQkFake-conv-offsite',
    replyToExternalId: original,
    ...fields,
  };
}

const write = (externalId: string, changes: FieldChange[]) =>
  createOutlookSource({ graphUrl: () => graph }).write?.({
    account: 'outlook:t:u-sam',
    externalId,
    changes,
    accessToken: async () => ({ token: 't', kind: 'oauth' }),
    attachment: async () => new Uint8Array(DECK.size).fill(1),
    signal: new AbortController().signal,
  });
const change = (field: string, value: unknown): FieldChange => ({
  field,
  value,
  synced: null,
  madeAt: Date.now(),
});

describe('the fake Graph’s writing side', () => {
  it('makes a reply’s draft, uploads a large attachment, and sends it into Sent Items', async () => {
    const saved = await write(`commander:${COMMANDER}`, [change('draft', message())]);
    const draftId = saved?.item?.externalId as string;
    expect(mail.drafts(USER.id)).toEqual([{ id: draftId, subject: 'RE: Q4 offsite dates' }]);
    expect((saved?.item?.detail as EmailDetail | undefined)?.draft).toBe(true);

    const sent = await write(draftId, [change('send', message({ attachments: [DECK] }))]);

    expect(mail.drafts(USER.id)).toEqual([]);
    expect(mail.sent).toEqual([
      expect.objectContaining({
        subject: 'RE: Q4 offsite dates',
        to: ['dana@northwind.test'],
        attachments: [{ name: 'deck.pdf', size: DECK.size }],
        inReplyTo: '<offsite-1@mail.northwind.test>',
        conversationId: 'AAQkFake-conv-offsite',
      }),
    ]);
    expect(sent?.item).toMatchObject({ externalId: mail.sent[0]?.id, commanderItemId: COMMANDER });
    expect(mail.requests.filter((each) => each.startsWith('PUT /fake-upload/'))).toHaveLength(2);
  });

  it('discards a draft', async () => {
    const saved = await write(`commander:${COMMANDER}`, [change('draft', message())]);
    await write(saved?.item?.externalId as string, [
      change('delete', { commanderId: COMMANDER, messageId: 'x' }),
    ]);
    expect(mail.drafts(USER.id)).toEqual([]);
  });
});
