import {
  type EmailDetail,
  type OutlookCatalog,
  type SourceItem,
  threadingOf,
  threadMessages,
} from '@commander/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimited, type SourceCatalog, type SyncPage, type SyncProgress } from '../source';
import { createOutlookSource, OUTLOOK_CADENCE, type OutlookCursor } from './outlook-source';
import expired from './recorded/expired.json';
import firstSync from './recorded/first-sync.json';
import incremental from './recorded/incremental.json';
import throttled from './recorded/throttled.json';

// The Outlook mail adapter (#136) against recorded Microsoft Graph v1.0 responses (shaped as Graph
// answers), each recording also pinning down the request Commander sends for it, in order, with its
// body: the folder list, the first sync's 30 days across pages, later syncs' delta with new, changed,
// moved and removed messages, a delta link Outlook no longer accepts, and throttling.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const msg = (name: string) => `AAMkAGI2-msg-${name}=`;
const F = {
  inbox: 'AAMkAGI2-fld-inbox=',
  receipts: 'AAMkAGI2-fld-receipts=',
  sent: 'AAMkAGI2-fld-sentitems=',
  archive: 'AAMkAGI2-fld-archive=',
  deleted: 'AAMkAGI2-fld-deleteditems=',
  projects: 'AAMkAGI2-fld-projects=',
};
const INBOX = { id: F.inbox, name: 'Inbox', wellKnown: 'inbox' };

let held: Map<string, SourceItem>;
let catalogs: SourceCatalog[];
let progress: (SyncProgress | null)[];
let checkpoints: OutlookCursor[];
let sent: { method: string; path: string; authorization: string | null; prefer: string | null }[];

beforeEach(() => {
  held = new Map();
  catalogs = [];
  progress = [];
  checkpoints = [];
  sent = [];
});

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    sent.push({ method, path, authorization: headers.get('authorization'), prefer: headers.get('prefer') });
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(next.request.body);
    const { status, headers: answer, body } = next.response;
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: answer });
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

const exchanges = (recorded: unknown) => structuredClone(recorded) as Exchange[];

async function sync(fetch: typeof globalThis.fetch, cursor: unknown = null) {
  const pages: SyncPage[] = [];
  const source = createOutlookSource({ graphUrl: () => GRAPH, fetch, now: () => NOW });
  const stored = (ids: string[]) =>
    ids.flatMap((id) => {
      const item = held.get(id);
      return item
        ? [
            {
              externalId: id,
              title: item.title,
              people: item.people ?? [],
              status: item.status ?? 'open',
              detail: item.detail ?? null,
            },
          ]
        : [];
    });
  const result = await source.sync({
    account: ACCOUNT,
    cursor,
    mode: 'full',
    connectedAt: NOW,
    stored,
    heldIds: () => [...held.keys()],
    checkpoint: (next) => checkpoints.push(structuredClone(next) as OutlookCursor),
    progress: (next) => progress.push(next),
    saveCatalog: (catalog) => catalogs.push(catalog),
    accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
    save: (page) => {
      pages.push(page);
      for (const item of page.items) held.set(item.externalId, item);
      for (const id of page.deleted) held.delete(id);
    },
    signal: new AbortController().signal,
  });
  return {
    cursor: result.cursor as OutlookCursor,
    cost: result.cost,
    pages,
    items: pages.flatMap((page) => page.items),
    deleted: pages.flatMap((page) => page.deleted),
  };
}

const detailOf = (id: string) => held.get(id)?.detail as EmailDetail;

async function afterFirstSync() {
  const { cursor } = await sync(replay(exchanges(firstSync)).fetch);
  sent = [];
  catalogs = [];
  progress = [];
  checkpoints = [];
  return cursor;
}

describe('the first sync', () => {
  it('lists every folder into the catalog, then downloads each synced folder’s 30 days, the Inbox first and newest first, page by page', async () => {
    const recorded = replay(exchanges(firstSync));
    const { cursor, cost, pages } = await sync(recorded.fetch);

    expect(recorded.remaining()).toBe(0);
    expect(cost.requests).toBe(19);
    expect(OUTLOOK_CADENCE).toEqual({ defaultMinutes: 15, choices: [5, 10, 15, 30, 60] });
    expect(sent.every((each) => each.authorization === 'Bearer eyJ0eXAiOi.recorded')).toBe(true);
    // Every request asks for immutable ids, so a moved message keeps its id.
    expect(sent.every((each) => each.prefer?.includes('IdType="ImmutableId"'))).toBe(true);
    // Junk Email, Outbox and Conversation History are never read. Drafts are read for the drafts made
    // elsewhere (#138), every one of them, however old.
    for (const skipped of ['junkemail', 'outbox', 'conversationhistory'])
      expect(sent.some((each) => each.path.includes(`fld-${skipped}`))).toBe(false);
    expect(sent.at(-1)?.path).toContain('fld-drafts=/messages/delta');
    expect(sent.at(-1)?.path).toContain('receivedDateTime ge 1970-01-01T00:00:00.000Z');

    const [catalog] = catalogs as [OutlookCatalog];
    expect(catalog.kind).toBe('outlook');
    expect(
      catalog.folders.map(({ name, wellKnown, system, synced }) => [name, wellKnown, system, synced]),
    ).toEqual([
      ['Inbox', 'inbox', true, true],
      ['Inbox / Receipts', null, false, true],
      ['Sent Items', 'sentitems', true, true],
      ['Archive', 'archive', true, true],
      ['Deleted Items', 'deleteditems', true, false],
      ['Junk Email', 'junkemail', true, false],
      ['Drafts', 'drafts', true, false],
      ['Outbox', 'outbox', true, false],
      ['Projects', null, false, true],
      ['Conversation History', 'conversationhistory', false, false],
    ]);

    // Newest first, the Inbox first; Deleted Items' own mail isn't downloaded.
    expect(pages.map((page) => page.items.map((item) => item.title))).toEqual([
      ['Staging certificate', 'RE: Q4 offsite dates'],
      ['Q4 offsite dates', 'Weekly digest: café edition'],
      ['RE: Q4 offsite dates'],
      ['Invoice 4411'],
      ['Design review: onboarding'],
    ]);
    expect(held.has(msg('old-trash'))).toBe(false);
    expect(progress).toEqual([
      { done: 0, total: 7 },
      { done: 2, total: 7 },
      { done: 4, total: 7 },
      { done: 5, total: 7 },
      { done: 6, total: 7 },
      { done: 7, total: 7 },
      null,
    ]);
    // Each page checkpointed, so a first sync that stops resumes from the page it reached.
    expect(checkpoints.some((each) => each.folders[F.inbox]?.link?.includes('inbox-page-2'))).toBe(true);

    expect(cursor).toMatchObject({
      v: 1,
      windowStart: NOW - 30 * 24 * 60 * 60_000,
      me: 'sam@contoso.test',
      wellKnown: { inbox: F.inbox, archive: F.archive, sentitems: F.sent, deleteditems: F.deleted },
      removed: {},
    });
    expect(cursor.wellKnown.syncissues).toBeUndefined();
    expect(cursor.backfill).toBeUndefined();
    expect(
      Object.entries(cursor.folders).map(([id, mark]) => [
        id,
        mark.ready,
        mark.link?.split('$deltatoken=')[1],
      ]),
    ).toEqual([
      [F.inbox, true, 'inbox-1'],
      [F.sent, true, 'sent-1'],
      [F.archive, true, 'archive-1'],
      [F.receipts, true, 'receipts-1'],
      [F.projects, true, 'projects-1'],
      [F.deleted, true, 'deleted-1'],
      ['AAMkAGI2-fld-drafts=', true, 'drafts-1'],
    ]);
  });

  it('maps each message into the email detail Gmail’s mail shares', async () => {
    await sync(replay(exchanges(firstSync)).fetch);

    expect(held.get(msg('offsite-2'))).toMatchObject({
      kind: 'email',
      status: 'open',
      title: 'RE: Q4 offsite dates',
    });
    expect(detailOf(msg('offsite-2'))).toMatchObject({
      messageId: '<offsite-2@mail.northwind.test>',
      inReplyTo: '<sam-reply-1@contoso.test>',
      references: ['<offsite-1@mail.northwind.test>', '<sam-reply-1@contoso.test>'],
      sourceThreadId: 'AAQkAGI2-conv-offsite=',
      from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
      to: [{ name: 'Sam Rivera', address: 'sam@contoso.test' }],
      read: false,
      starred: true,
      inInbox: true,
      folder: INBOX,
      labels: [],
      sentByMe: false,
      sentAt: Date.parse('2026-10-02T15:40:11Z'),
    });
    // The User's own reply: no internet headers, so its Message-ID is Graph's internetMessageId.
    expect(detailOf(msg('sam-reply-1'))).toMatchObject({
      messageId: '<sam-reply-1@contoso.test>',
      inReplyTo: null,
      sentByMe: true,
      inInbox: false,
      folder: { id: F.sent, name: 'Sent Items', wellKnown: 'sentitems' },
      labels: [],
    });
    expect(held.get(msg('invoice'))?.status).toBe('archived');
    expect(detailOf(msg('design-review'))).toMatchObject({
      hasInvitation: true,
      folder: { id: F.projects, name: 'Projects', wellKnown: null },
      labels: [{ id: F.projects, name: 'Projects' }],
    });
    // An event message is read again with its event (#144): what finds it in the calendar.
    expect(detailOf(msg('design-review')).invitation).toEqual({
      method: 'request',
      uid: '040000008200E00074C5B7101A82E00800000000D3B2C4DC9A1F0D01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90',
      eventId: 'AAMkAGI2-evt-design-review=',
      title: 'Design review: onboarding',
      start: Date.parse('2026-10-07T13:00:00Z'),
      end: Date.parse('2026-10-07T14:00:00Z'),
      allDay: false,
    });
    expect(detailOf(msg('digest'))).toMatchObject({
      categories: ['Newsletters'],
      listUnsubscribe: '<mailto:unsubscribe@news.northwind.test>, <https://news.northwind.test/u/38>',
      listId: 'Northwind Weekly <weekly.news.northwind.test>',
    });
    // Attachments' metadata, inline images (by Content-ID) too; never their bytes.
    expect(detailOf(msg('certificate')).attachments).toEqual([
      {
        name: 'staging.csr',
        type: 'application/pkcs10',
        size: 1187,
        partId: 'AAMkAGI2-att-certificate-csr=',
        inline: false,
      },
    ]);
    expect(detailOf(msg('offsite-1')).attachments).toEqual([
      {
        name: 'image001.png',
        type: 'image/png',
        size: 4310,
        partId: 'AAMkAGI2-att-offsite-logo=',
        inline: true,
        // As a cid: URL names it (normaliseContentId).
        contentId: 'image001.png@01db1a2b.3c4d5e60',
      },
    ]);
    // Bodies as Gmail's are kept: Outlook's HTML as it came, its text converted from it.
    const body = held.get(msg('offsite-1'))?.body;
    expect(body?.html).toContain('<p class="MsoNormal">');
    expect(body?.html).toContain('cid:image001.png@01DB1A2B.3C4D5E60');
    expect(body?.textFromHtml).toBe(true);
    expect(body?.text).toContain('Which dates work for you for the Q4 offsite?');
    expect(body?.text).not.toContain('MsoNormal');
    expect(held.get(msg('certificate'))?.body).toEqual({
      text: 'The staging certificate expires on Friday. Can you renew it?\nThe CSR is attached.\n\nPriya',
      html: null,
      textFromHtml: false,
      truncated: false,
    });
  });

  it('threads as the header threading function does, with conversationId where the headers say nothing', async () => {
    await sync(replay(exchanges(firstSync)).fetch);

    const keys = threadMessages(
      [...held.values()].map((item) => threadingOf(item.externalId, item.detail as EmailDetail)),
    );
    const offsite = keys.get(msg('offsite-1'));
    expect(keys.get(msg('offsite-2'))).toBe(offsite);
    expect(keys.get(msg('sam-reply-1'))).toBe(offsite);
    const others = [msg('certificate'), msg('digest'), msg('invoice'), msg('design-review')].map((id) =>
      keys.get(id),
    );
    expect(new Set([offsite, ...others]).size).toBe(5);
  });

  it('stops when Microsoft throttles it (Retry-After), and resumes from the page it reached', async () => {
    const all = exchanges(firstSync);
    const stopped = [...all.slice(0, 10), exchanges([throttled.page])[0] as Exchange];
    const error = await sync(replay(stopped).fetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(37_000);
    const reached = checkpoints.at(-1) as OutlookCursor;
    expect(reached.folders[F.inbox]).toEqual({
      link: "https://graph.test/v1.0/me/mailFolders('AAMkAGI2-fld-inbox=')/messages/delta?$skiptoken=inbox-page-2",
      ready: false,
    });
    expect(reached.backfill).toEqual({ done: 2, total: 7 });
    expect(held.size).toBe(2);

    // The next sync lists the folders again and carries on from the Inbox's second page.
    const resumed = replay([...all.slice(3, 6), ...all.slice(10)]);
    const { cursor } = await sync(resumed.fetch, reached);
    expect(resumed.remaining()).toBe(0);
    expect(held.size).toBe(7);
    expect(cursor.folders[F.inbox]?.ready).toBe(true);
    expect(progress.at(-1)).toBeNull();
  });
});

describe('later syncs', () => {
  it('bring new, changed, moved and removed mail through each folder’s delta link', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(exchanges(incremental.changes));
    const result = await sync(recorded.fetch, cursor);

    expect(recorded.remaining()).toBe(0);
    expect(result.cost.requests).toBe(10);
    // A draft made in Outlook (#138): kept as a draft, never part of a thread or the inbox.
    expect(held.get('AAMkAGI2-msg-draft-lunch=')).toMatchObject({
      title: 'Lunch next week?',
      status: 'archived',
    });
    expect(detailOf('AAMkAGI2-msg-draft-lunch=')).toMatchObject({
      draft: true,
      inInbox: false,
      to: [{ name: 'Priya Patel', address: 'priya@contoso.test' }],
    });
    // A reply arrived.
    expect(detailOf(msg('offsite-3'))).toMatchObject({
      read: false,
      inInbox: true,
      inReplyTo: '<offsite-2@mail.northwind.test>',
    });
    // Read and unflagged in Outlook.
    expect(detailOf(msg('offsite-2'))).toMatchObject({ read: true, starred: false });
    // Moved to Projects: the same Item, filed there now.
    expect(held.get(msg('digest'))?.status).toBe('archived');
    expect(detailOf(msg('digest'))).toMatchObject({
      inInbox: false,
      folder: { id: F.projects, name: 'Projects', wellKnown: null },
      labels: [{ id: F.projects, name: 'Projects' }],
    });
    // Moved to Deleted Items: in Trash, remembering the folder it came from.
    expect(detailOf(msg('certificate'))).toMatchObject({
      inTrash: true,
      folder: INBOX,
      inInbox: true,
      read: true,
    });
    // Moved to Junk Email: gone from every synced folder, so a tombstone.
    expect(result.deleted).toEqual([msg('invoice')]);
    expect(result.cursor.removed).toEqual({});
    expect(result.cursor.folders[F.inbox]?.link).toContain('inbox-2');
    expect(result.cursor.folders[F.deleted]?.link).toContain('deleted-2');

    // Taken out of Deleted Items again: back in the Inbox, out of Trash; what Commander never held
    // being emptied from Deleted Items changes nothing.
    const back = replay(exchanges(incremental.restored));
    const later = await sync(back.fetch, result.cursor);
    expect(back.remaining()).toBe(0);
    expect(detailOf(msg('certificate')).inTrash).toBeUndefined();
    expect(detailOf(msg('certificate'))).toMatchObject({ folder: INBOX, inInbox: true });
    expect(later.deleted).toEqual([]);
  });

  it('re-syncs a folder’s window when Outlook no longer accepts its delta link, tombstoning what it no longer lists', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay(exchanges(expired));
    const result = await sync(recorded.fetch, cursor);

    expect(recorded.remaining()).toBe(0);
    expect(result.deleted).toEqual([msg('digest')]);
    expect(result.cursor.folders[F.inbox]).toMatchObject({ ready: true });
    expect(result.cursor.folders[F.inbox]?.link).toContain('inbox-fresh');
    // Attachments Commander already knows aren't listed again.
    expect(sent.some((each) => each.path === '/$batch')).toBe(false);
    expect(held.has(msg('certificate'))).toBe(true);
  });

  it('asks more plainly where Graph refuses a query (400), rather than stopping the sync', async () => {
    const all = exchanges(firstSync);
    const refused = (message: string) => ({
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: { error: { code: 'BadRequest', message } },
    });
    type Batch = { requests: { url: string }[] };
    type Answers = { responses: { status: number; body: unknown }[] };
    // The counts are refused: the download goes on, with no total to show.
    for (const at of [6, 7])
      for (const answer of ((all[at] as Exchange).response.body as Answers).responses)
        Object.assign(answer, refused('$count is not supported here.'));
    // The Inbox's first round with internet headers is refused, then asked for without them.
    const inbox = all[8] as Exchange;
    const withHeaders: Exchange = {
      request: { ...inbox.request },
      response: refused("Could not find a property named 'internetMessageHeaders'."),
    };
    inbox.request.path = inbox.request.path.replace(',internetMessageHeaders', '');
    // The certificate's attachments with Content-IDs are refused, then listed with what every one has.
    const listing = all[9] as Exchange;
    const withContentIds: Exchange = structuredClone(listing);
    for (const answer of (withContentIds.response.body as Answers).responses)
      Object.assign(answer, refused("Could not find a property named 'contentId'."));
    for (const request of (listing.request.body as Batch).requests)
      request.url = request.url.replace(',contentId', '');
    const recorded = replay([
      ...all.slice(0, 8),
      withHeaders,
      all[8],
      withContentIds,
      ...all.slice(9),
    ] as Exchange[]);

    const { cursor } = await sync(recorded.fetch);

    expect(recorded.remaining()).toBe(0);
    expect(held.size).toBe(7);
    expect(detailOf(msg('certificate')).attachments.map((each) => each.name)).toEqual(['staging.csr']);
    expect(cursor.folders[F.inbox]?.ready).toBe(true);
  });

  it('waits as long as Microsoft asks when Outlook is unavailable (503 with Retry-After)', async () => {
    const cursor = await afterFirstSync();
    const error = await sync(replay(exchanges([throttled.folders])).fetch, cursor).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterMs).toBe(120_000);
  });
});
