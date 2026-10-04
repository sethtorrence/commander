import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CoreEmailReaderReply, EmailBody, EmailDetail, SourceItem } from '@commander/domain';
import { type FetchedPart, PartNotFound, type PartRequest, type SourceAdapter } from '@commander/sources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { type EmailReader, setUpEmailReader } from '.';

// The Core's side of the email reader (#134): each message's HTML sanitised for the frame under its
// Account's image rules, the rules themselves, and the message's parts fetched through its Source
// once, then cached in the Account's folder (removed with the Account).

const TOKEN = 'ab'.repeat(16);
const GMAIL = 'google:alex';
const OUTLOOK = 'outlook:sam';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let dir: string;
let store: ItemStore;
let reader: EmailReader;
let fetched: PartRequest[];
let sent: CoreEmailReaderReply[];

function email(id: string, detail: Partial<EmailDetail>, html: string | null): SourceItem {
  const full: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: null,
    from: { name: 'Dana', address: 'Dana@Northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: id,
    sentAt: 1,
    snippet: '',
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...detail,
  };
  const body: EmailBody = { text: 'text', html, textFromHtml: false, truncated: false };
  return { externalId: id, kind: 'email', title: id, people: [], status: 'open', detail: full, body };
}

const NEWSLETTER = '<p>Hi</p><img src="https://cdn.test/a.png"><img src="cid:logo@x">';

function save(source: 'gmail' | 'outlook', account: string, items: SourceItem[]) {
  store.saveFromSource({ source, account, items, deleted: [] });
}
const idOf = (account: string, externalId: string) =>
  store.query({ kinds: ['email'] }).find((item) => item.account === account && item.externalId === externalId)
    ?.id as string;

const fakeSource = (source: 'gmail' | 'outlook'): SourceAdapter => ({
  source,
  cadence: { defaultMinutes: 15, choices: [15] },
  sync: async () => ({ cursor: null, cost: { requests: 0, complexity: 0 } }),
  async fetchPart(request): Promise<FetchedPart> {
    fetched.push(request);
    const part = request.part;
    if (
      ('contentId' in part && part.contentId.toLowerCase() === 'logo@x') ||
      ('partId' in part && part.partId === '1')
    )
      return { partId: '1', name: 'logo.png', type: 'image/png', bytes: PNG };
    if ('partId' in part && part.partId === '2')
      return { partId: '2', name: '../../Agenda.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF') };
    throw new PartNotFound('no such part');
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-email-reader-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
  });
  fetched = [];
  sent = [];
  reader = setUpEmailReader({
    store,
    dataDir: dir,
    accessTokens: { request: async () => ({ token: 'tok', kind: 'oauth' }) },
    adapterFor: (source) => (source === 'gmail' || source === 'outlook' ? fakeSource(source) : undefined),
    accounts: () => [
      {
        account: GMAIL,
        sources: ['gmail', 'google-calendar'],
        name: 'alex@gmail.test',
        needsReconnect: false,
      },
      {
        account: OUTLOOK,
        sources: ['outlook', 'outlook-calendar'],
        name: 'sam@contoso.test',
        needsReconnect: false,
      },
      { account: 'linear:1', sources: ['linear'], name: 'Acme', needsReconnect: false },
    ],
    send: (message) => sent.push(message),
  });
  save('gmail', GMAIL, [
    email('g1', {}, NEWSLETTER),
    email(
      'g2',
      {
        attachments: [
          { name: 'logo.png', type: 'image/png', size: 7, partId: '1', inline: true, contentId: 'logo@x' },
        ],
      },
      NEWSLETTER,
    ),
    email('plain', {}, null),
  ]);
  save('outlook', OUTLOOK, [email('o1', {}, NEWSLETTER), email('o2', {}, NEWSLETTER)]);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const render = async (itemId: string, quotes = false) => {
  const response = await reader.answer({ op: 'render', itemId, quotes, token: TOKEN });
  if (!response.ok || !('render' in response)) throw new Error(JSON.stringify(response));
  return response.render;
};

describe('rendering a message for the frame', () => {
  it('sanitises it, naming its URLs for the token', async () => {
    const result = await render(idOf(GMAIL, 'g1'));
    expect(result.html).toContain(`commander-mail://part/${TOKEN}/logo%40x`);
    expect(result.html).toContain(`commander-mail://image/${TOKEN}/0`);
    expect(result).toMatchObject({
      remoteImages: ['https://cdn.test/a.png'],
      images: 'shown',
      imageCount: 1,
      account: GMAIL,
      sender: 'dana@northwind.test',
    });
  });

  it('shows a Gmail Account’s images by default, and holds them back once it asks first', async () => {
    store.emailImages.setAskFirst(GMAIL, true);
    const held = await render(idOf(GMAIL, 'g1'));
    expect(held).toMatchObject({ images: 'held', imageCount: 1, remoteImages: [] });
    expect(held.html).not.toContain('cdn.test');
  });

  it('holds an Outlook Account’s images back until the message or its sender is trusted', async () => {
    expect(await render(idOf(OUTLOOK, 'o1'))).toMatchObject({ images: 'held', remoteImages: [] });

    expect(await reader.answer({ op: 'show-images', itemId: idOf(OUTLOOK, 'o1') })).toEqual({ ok: true });
    expect(await render(idOf(OUTLOOK, 'o1'))).toMatchObject({ images: 'shown' });
    expect(await render(idOf(OUTLOOK, 'o2'))).toMatchObject({ images: 'held' });

    expect(await reader.answer({ op: 'trust-sender', itemId: idOf(OUTLOOK, 'o2') })).toEqual({ ok: true });
    expect(await render(idOf(OUTLOOK, 'o2'))).toMatchObject({ images: 'shown' });
    expect(store.emailImages.trustedSenders(OUTLOOK)).toEqual(['dana@northwind.test']);

    await reader.answer({ op: 'untrust-sender', account: OUTLOOK, address: 'DANA@northwind.test' });
    expect(await render(idOf(OUTLOOK, 'o2'))).toMatchObject({ images: 'held' });
  });

  it('says there are no images when there are none', async () => {
    save('gmail', GMAIL, [email('g3', {}, '<p>Words only</p><img src="cid:x">')]);
    expect(await render(idOf(GMAIL, 'g3'))).toMatchObject({ images: 'none', imageCount: 0 });
  });

  it('refuses a message without HTML, an Item that isn’t an email, a deleted one, and a bad token', async () => {
    expect(
      await reader.answer({ op: 'render', itemId: idOf(GMAIL, 'plain'), quotes: false, token: TOKEN }),
    ).toEqual({
      ok: false,
      error: 'This message has no HTML.',
    });
    expect((await reader.answer({ op: 'render', itemId: 'nope', quotes: false, token: TOKEN })).ok).toBe(
      false,
    );
    const deleted = idOf(GMAIL, 'g1');
    store.saveFromSource({ source: 'gmail', account: GMAIL, items: [], deleted: ['g1'] });
    expect((await reader.answer({ op: 'render', itemId: deleted, quotes: false, token: TOKEN })).ok).toBe(
      false,
    );
  });
});

describe('the image rules for Settings → Email', () => {
  it('lists every email Account with its rules', async () => {
    store.emailImages.setAskFirst(GMAIL, true);
    store.emailImages.trustSender(OUTLOOK, 'b@x.test');
    expect(await reader.answer({ op: 'image-settings' })).toEqual({
      ok: true,
      accounts: [
        { account: GMAIL, name: 'alex@gmail.test', source: 'gmail', askFirst: true, trustedSenders: [] },
        {
          account: OUTLOOK,
          name: 'sam@contoso.test',
          source: 'outlook',
          askFirst: false,
          trustedSenders: ['b@x.test'],
        },
      ],
    });
    await reader.answer({ op: 'set-ask-first', account: GMAIL, on: false });
    expect(store.emailImages.askFirst(GMAIL)).toBe(false);
  });
});

describe('a message’s parts', () => {
  const part = async (
    request: { itemId: string; partId: string } | { itemId: string; contentId: string },
  ) => {
    const response = await reader.answer({ op: 'part', ...request });
    if (!response.ok || !('part' in response)) throw new Error(JSON.stringify(response));
    return response.part;
  };

  it('fetches an inline image through the Source once, then serves it from the Account’s folder', async () => {
    const first = await part({ itemId: idOf(GMAIL, 'g2'), contentId: 'Logo@X' });
    expect(first).toMatchObject({ name: 'logo.png', type: 'image/png', size: PNG.length });
    expect(readFileSync(first.path)).toEqual(Buffer.from(PNG));
    expect(first.path.startsWith(join(dir, 'email-parts'))).toBe(true);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    const again = await part({ itemId: idOf(GMAIL, 'g2'), partId: '1' });
    expect(again.path).toBe(first.path);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ account: GMAIL, externalId: 'g2', part: { partId: '1' } });
  });

  it('asks the Source by Content-ID when the message was synced before Content-IDs were kept', async () => {
    const found = await part({ itemId: idOf(GMAIL, 'g1'), contentId: 'logo@x' });
    expect(found.name).toBe('logo.png');
    expect(fetched[0]?.part).toEqual({ contentId: 'logo@x' });
    await part({ itemId: idOf(GMAIL, 'g1'), contentId: 'logo@x' });
    expect(fetched).toHaveLength(1);
  });

  it('writes an attachment under a safe name inside the Account’s folder', async () => {
    const found = await part({ itemId: idOf(GMAIL, 'g1'), partId: '2' });
    expect(found.name).toBe('Agenda.pdf');
    expect(found.path.endsWith('/Agenda.pdf')).toBe(true);
    expect(dirname(dirname(found.path)).startsWith(join(dir, 'email-parts'))).toBe(true);
  });

  it('asks the Source about an unknown Content-ID once, and never when the message lists its Content-IDs', async () => {
    const unknown = { itemId: idOf(GMAIL, 'g1'), contentId: 'nope@x' };
    expect((await reader.answer({ op: 'part', ...unknown })).ok).toBe(false);
    expect((await reader.answer({ op: 'part', ...unknown })).ok).toBe(false);
    expect(fetched).toHaveLength(1);
    expect((await reader.answer({ op: 'part', itemId: idOf(GMAIL, 'g2'), contentId: 'other@x' })).ok).toBe(
      false,
    );
    expect(fetched).toHaveLength(1);
  });

  it('writes nothing for a part that arrives after its Account was removed', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = fakeSource('gmail');
    const original = source.fetchPart?.bind(source);
    source.fetchPart = async (request) => {
      await slow;
      return (original as NonNullable<typeof original>)(request);
    };
    reader = setUpEmailReader({
      store,
      dataDir: dir,
      accessTokens: { request: async () => ({ token: 'tok', kind: 'oauth' }) },
      adapterFor: () => source,
      accounts: () => [],
      send: () => {},
    });
    const pending = reader.answer({ op: 'part', itemId: idOf(GMAIL, 'g1'), partId: '2' });
    reader.forget(GMAIL);
    release();
    expect((await pending).ok).toBe(false);
    expect(existsSync(join(dir, 'email-parts'))).toBe(false);
  });

  it('says when there is no such part', async () => {
    expect(await reader.answer({ op: 'part', itemId: idOf(GMAIL, 'g1'), partId: '9' })).toEqual({
      ok: false,
      error: 'no such part',
    });
  });

  it('removes an Account’s cached parts and image rules with the Account', async () => {
    const found = await part({ itemId: idOf(GMAIL, 'g2'), contentId: 'logo@x' });
    const other = await part({ itemId: idOf(OUTLOOK, 'o1'), contentId: 'logo@x' });
    store.emailImages.trustSender(GMAIL, 'a@b.test');
    reader.forget(GMAIL);
    expect(existsSync(found.path)).toBe(false);
    expect(existsSync(other.path)).toBe(true);
    expect(store.emailImages.trustedSenders(GMAIL)).toEqual([]);
  });
});

describe('messages from the main process', () => {
  it('answers a request by its id, and ignores what isn’t for it', async () => {
    expect(reader.handle({ type: 'something-else' })).toBe(false);
    expect(reader.handle({ type: 'email-reader-request', id: 7, request: { op: 'image-settings' } })).toBe(
      true,
    );
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ type: 'email-reader-reply', id: 7, response: { ok: true } });
    expect(reader.handle({ type: 'email-reader-request', id: 8, request: { op: 'render' } })).toBe(true);
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ id: 8, response: { ok: false } });
  });
});
