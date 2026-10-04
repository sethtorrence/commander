import type { EmailBody, EmailDetail, GmailCatalog, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessToken,
  RateLimited,
  SignInRefused,
  SourceUnavailable,
  type StoredItem,
  type SyncPage,
} from '../source';
import { createGmailSource, GMAIL_CADENCE, type GmailCursor } from './gmail-source';
import { readGmailMessage } from './message';
import expiredHistory from './recorded/expired-history.json';
import firstSync from './recorded/first-sync.json';
import incremental from './recorded/incremental.json';
import rateLimits from './recorded/rate-limits.json';
import stoppedByQuota from './recorded/stopped-by-quota.json';
import type { GmailMessage } from './shapes';

// The Gmail adapter against recorded Gmail API responses (shaped exactly as Gmail answers). Each
// recording also pins down the request Commander must send for it, in order.

type Recorded = { status: number; headers: Record<string, string>; body: unknown };
type Exchange = { request: { path: string }; response: Recorded };

const GMAIL = 'https://gmail.test';
const NOW = Date.UTC(2026, 9, 3, 12);
const DAY = 86_400_000;
const ACCOUNT = 'google:104512345678901234567';
const token: AccessToken = { token: 'ya29.recorded', kind: 'oauth' };

const M1 = '19a1f0c2d3e4f501';
const M2 = '19a2a1b2c3d4e502';
const M3 = '19a3b2c3d4e5f603';
const M4 = '19a4c3d4e5f6a704';
const M5 = '19a6e5f6a7b8c905';
const M7 = '19a8a7b8c9d0e107';
const DRAFT = '19a5d4e5f6a7b8d1';

let clock: number;
let sent: { path: string; at: number; authorization: string | null }[];
// What the Item store holds for the Account, as the adapter's `stored` and `heldIds` read it.
let held: Map<string, SourceItem>;
let unexpected: string[];

beforeEach(() => {
  clock = NOW;
  sent = [];
  held = new Map();
  unexpected = [];
});

afterEach(() => {
  expect(unexpected).toEqual([]);
});

function respond({ status, headers, body }: Recorded) {
  return new Response(body === null ? '' : JSON.stringify(body), { status, headers });
}

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GMAIL.length));
    sent.push({ path, at: clock, authorization: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (next?.request.path !== path) {
      unexpected.push(path);
      throw new Error(`Unexpected request ${path}`);
    }
    return respond(next.response);
  };
  return { fetch: fetch as typeof globalThis.fetch, remaining: () => queue.length };
}

type Run = {
  pages: SyncPage[];
  checkpoints: unknown[];
  progress: ({ done: number; total: number } | null)[];
  catalogs: GmailCatalog[];
};

function gmailSource(fetch: typeof globalThis.fetch) {
  return createGmailSource({
    gmailUrl: () => GMAIL,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

async function sync(
  fetch: typeof globalThis.fetch,
  {
    cursor = null,
    source = gmailSource(fetch),
  }: { cursor?: unknown; source?: ReturnType<typeof gmailSource> } = {},
) {
  const run: Run = { pages: [], checkpoints: [], progress: [], catalogs: [] };
  const result = await source.sync({
    account: ACCOUNT,
    cursor,
    mode: 'full',
    connectedAt: NOW,
    stored: (ids) =>
      ids.flatMap((id): StoredItem[] => {
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
      }),
    heldIds: () => [...held.keys()],
    accessToken: async () => token,
    save: (page) => {
      run.pages.push(page);
      for (const item of page.items) held.set(item.externalId, item);
      for (const id of page.deleted) held.delete(id);
    },
    checkpoint: (next) => run.checkpoints.push(next),
    saveCatalog: (catalog) => run.catalogs.push(catalog as GmailCatalog),
    progress: (next) => run.progress.push(next),
    signal: new AbortController().signal,
  });
  return { result, ...run, items: run.pages.flatMap((page) => page.items) };
}

const detailOf = (id: string) => held.get(id)?.detail as EmailDetail;
const gets = () =>
  sent
    .filter((each) => each.path.includes('/messages/'))
    .map((each) => each.path.split('/messages/')[1]?.split('?')[0]);

async function afterFirstSync() {
  const { result } = await sync(replay(firstSync as Exchange[]).fetch);
  sent = [];
  return result.cursor as GmailCursor;
}

describe('first sync', () => {
  it('downloads the 30 days before the Account was connected, newest first, skipping drafts', async () => {
    const recorded = replay(firstSync as Exchange[]);

    const { result, items } = await sync(recorded.fetch);

    expect(recorded.remaining()).toBe(0);
    expect(items.map((item) => item.externalId)).toEqual([M4, M3, M2, M1]);
    expect(held.has(DRAFT)).toBe(false);
    expect(result.cursor).toEqual({ v: 1, windowStart: NOW - 30 * DAY, historyId: '5000' });
    // Every request carries the borrowed token, and the run reports Gmail's quota units.
    expect(sent.every((each) => each.authorization === 'Bearer ya29.recorded')).toBe(true);
    expect(result.cost).toEqual({ requests: 10, complexity: 1 + 1 + 5 + 5 + 5 * 20 + 2 });
  });

  it('makes email Items with their bodies, Gmail labels and threads', async () => {
    await sync(replay(firstSync as Exchange[]).fetch);

    const receipt = held.get(M3);
    expect(receipt).toMatchObject({
      kind: 'email',
      title: 'Your order #48213 has shipped',
      status: 'archived',
    });
    const body = receipt?.body as EmailBody;
    expect(body.text).toContain('Order #48213 shipped today.');
    expect(body.textFromHtml).toBe(true);
    expect(detailOf(M3).labels.map((label) => label.name)).toEqual(['Updates', 'Receipts']);
    expect(detailOf(M3).listUnsubscribe).toBe('<https://shop.test/unsubscribe/abc>');
    // Dana's question, Alex's reply and Dana's answer are one thread; the receipt is its own.
    expect(new Set([M1, M2, M4].map((id) => detailOf(id).threadKey)).size).toBe(1);
    expect(detailOf(M3).threadKey).not.toBe(detailOf(M1).threadKey);
    expect(held.get(M4)).toMatchObject({
      status: 'open',
      people: ['dana@northwind.test', 'alex@gmail.test'],
    });
    expect(detailOf(M4)).toMatchObject({ read: false, inInbox: true, subject: 'Re: Q4 offsite dates' });
    expect(detailOf(M4).sourceVersion).toBeTruthy();
  });

  it('keeps the Account’s labels, for the label picker', async () => {
    const { catalogs } = await sync(replay(firstSync as Exchange[]).fetch);

    expect(catalogs.at(-1)).toMatchObject({ kind: 'gmail' });
    expect(catalogs.at(-1)?.labels).toContainEqual({ id: 'Label_7', name: 'Receipts', system: false });
    expect(catalogs.at(-1)?.labels).toContainEqual({ id: 'INBOX', name: 'Inbox', system: true });
  });

  it('reports its progress, and saves the newest mail first so it can be read while the rest downloads', async () => {
    const { pages, progress, checkpoints } = await sync(replay(firstSync as Exchange[]).fetch);

    expect(pages[0]?.items[0]?.externalId).toBe(M4);
    expect(progress[0]).toEqual({ done: 0, total: 5 });
    expect(progress.at(-2)).toEqual({ done: 5, total: 5 });
    expect(progress.at(-1)).toBeNull();
    // Before downloading, it notes where it is, so a restart picks up there.
    expect(checkpoints[0]).toEqual({
      v: 1,
      windowStart: NOW - 30 * DAY,
      historyId: '5000',
      backfill: { refresh: false },
    });
  });

  it('stops when Gmail says the per-minute quota is spent, keeping what it saved, and resumes where it stopped', async () => {
    const { stopped, resumed } = stoppedByQuota as { stopped: Exchange[]; resumed: Exchange[] };
    const failure = await sync(replay(stopped).fetch).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimited);
    expect((failure as RateLimited).retryAfterMs).toBe(60_000);
    expect([...held.keys()]).toEqual([M4, M3]);

    // The engine hands the checkpoint back next time: the window is listed again, and only the
    // messages not yet saved are fetched.
    sent = [];
    const checkpoint = { v: 1, windowStart: NOW - 30 * DAY, historyId: '5000', backfill: { refresh: false } };
    const recorded = replay(resumed);
    const { result } = await sync(recorded.fetch, { cursor: checkpoint });

    expect(recorded.remaining()).toBe(0);
    expect(gets()).toEqual([DRAFT, M2, M1]);
    expect([...held.keys()].sort()).toEqual([M1, M2, M3, M4].sort());
    expect(result.cursor).toEqual({ v: 1, windowStart: NOW - 30 * DAY, historyId: '5001' });
  });

  it('paces message fetches to about 250 a minute, after a short burst', async () => {
    const mailbox = Array.from({ length: 300 }, (_, n) => `m${String(n).padStart(4, '0')}`);
    const message = (id: string, n: number) => ({
      id,
      threadId: id,
      labelIds: ['INBOX'],
      snippet: `Message ${n}`,
      internalDate: String(NOW - n * 60_000),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: `Message ${n}` },
          { name: 'From', value: 'a@b.test' },
          { name: 'Message-ID', value: `<${id}@b.test>` },
        ],
        body: { data: Buffer.from(`Body ${n}`).toString('base64url') },
      },
    });
    const fetch = (async (url: string | URL | Request) => {
      const path = decodeURIComponent(String(url).slice(GMAIL.length));
      sent.push({ path, at: clock, authorization: null });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'INBOX' }] });
      if (path.endsWith('/profile')) return json({ emailAddress: 'alex@gmail.test', historyId: '9' });
      if (path.includes('/history')) return json({ historyId: '9' });
      const one = /\/messages\/(m\d+)/.exec(path)?.[1];
      if (one) return json(message(one, mailbox.indexOf(one)));
      return json({ messages: mailbox.map((id) => ({ id, threadId: id })) });
    }) as typeof globalThis.fetch;

    const { pages } = await sync(fetch);

    const times = sent.filter((each) => each.path.includes('/messages/m')).map((each) => each.at - NOW);
    expect(times).toHaveLength(300);
    // The newest mail is saved within seconds.
    expect(pages[0]?.items[0]?.externalId).toBe('m0000');
    expect(times[9]).toBeLessThan(2_000);
    // No minute ever sees more than Gmail's 6,000 units per user (20 a message), nor much over 250.
    for (const start of times) {
      const inMinute = times.filter((time) => time >= start && time < start + 60_000).length;
      expect(inMinute * 20).toBeLessThanOrEqual(6_000);
      expect(inMinute).toBeLessThanOrEqual(275);
    }
    // And it doesn't dawdle: 300 messages take a little over a minute.
    expect(times.at(-1)).toBeLessThan(75_000);
  });
});

describe('after the first sync', () => {
  it('applies Gmail’s history: new mail, read, starred, archived, deleted and trashed', async () => {
    const cursor = await afterFirstSync();
    const recorded = replay((incremental as { incremental: Exchange[] }).incremental);

    const { result, pages } = await sync(recorded.fetch, { cursor });

    expect(recorded.remaining()).toBe(0);
    expect(gets()).toEqual([M5]);
    expect(held.get(M5)).toMatchObject({ title: 'Staging certificate', status: 'open' });
    expect(detailOf(M4).read).toBe(true);
    expect(detailOf(M1)).toMatchObject({ starred: true, inInbox: false });
    expect(held.get(M1)?.status).toBe('archived');
    // A deleted message becomes a tombstone; one moved to Trash stays, in Trash (#135).
    expect(pages.flatMap((page) => page.deleted)).toEqual([M3]);
    expect(detailOf(M2)).toMatchObject({ inTrash: true, inInbox: false });
    expect(held.get(M2)?.status).toBe('archived');
    // Each changed message carries the history Commander last saw it at.
    expect(detailOf(M4).sourceVersion).toBe('5002');
    // Label changes don't touch the bodies kept beside the Item.
    expect(pages.flatMap((page) => page.items).find((item) => item.externalId === M4)?.body).toBeUndefined();
    expect(result.cursor).toEqual({ ...cursor, historyId: '5009' });
  });

  it('saves nothing when nothing changed', async () => {
    const cursor = { v: 1, windowStart: NOW - 30 * DAY, historyId: '5009' };
    const recorded = replay((incremental as { quiet: Exchange[] }).quiet);

    const { result, pages } = await sync(recorded.fetch, { cursor });

    expect(pages).toEqual([]);
    expect(result.cursor).toEqual(cursor);
    expect(result.cost).toEqual({ requests: 1, complexity: 2 });
  });

  it('raises RateLimited on Gmail’s 403 quota answer and on a 429, honouring Retry-After', async () => {
    const cursor = { v: 1, windowStart: NOW - 30 * DAY, historyId: '5009' };
    const { throttled, tooMany } = rateLimits as { throttled: Exchange[]; tooMany: Exchange[] };

    const quota = await sync(replay(throttled).fetch, { cursor }).catch((error: unknown) => error);
    const busy = await sync(replay(tooMany).fetch, { cursor }).catch((error: unknown) => error);

    expect(quota).toBeInstanceOf(RateLimited);
    expect((quota as RateLimited).message).toBe('Gmail asked Commander to slow down.');
    expect(busy).toBeInstanceOf(RateLimited);
    expect((busy as RateLimited).retryAfterMs).toBe(120_000);
  });

  it('re-reads the same window when Gmail’s history has expired, fetching only what it doesn’t hold', async () => {
    // Held: M1, M2, M4 and M5 as last synced (M4 still unread, M1 still in the inbox).
    await afterFirstSync();
    held.delete(M3);
    const m5 = (incremental as { incremental: Exchange[] }).incremental[3]?.response.body as GmailMessage;
    held.set(M5, readGmailMessage(m5, new Map()));
    const cursor = { v: 1, windowStart: NOW - 30 * DAY, historyId: '5009' };
    const recorded = replay(expiredHistory as Exchange[]);

    const { result, pages } = await sync(recorded.fetch, { cursor });

    expect(recorded.remaining()).toBe(0);
    expect(gets()).toEqual([M7]);
    expect(held.get(M7)).toMatchObject({ title: 'Venue booked' });
    // Labels come back from cheap label listings, not by fetching each message again.
    expect(detailOf(M4).read).toBe(true);
    expect(detailOf(M1)).toMatchObject({ inInbox: false, starred: true });
    expect(pages.flatMap((page) => page.deleted)).toEqual([M2]);
    expect(result.cursor).toEqual({ v: 1, windowStart: NOW - 30 * DAY, historyId: '7100' });
  });
});

describe('Gmail’s other answers', () => {
  const cursor = { v: 1, windowStart: NOW - 30 * DAY, historyId: '5009' };
  const answering = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;

  it('turns a refused sign-in into SignInRefused, and Gmail being down into SourceUnavailable', async () => {
    await expect(sync(answering(401), { cursor })).rejects.toBeInstanceOf(SignInRefused);
    await expect(
      sync(answering(403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }), {
        cursor,
      }),
    ).rejects.toBeInstanceOf(SignInRefused);
    await expect(sync(answering(503), { cursor })).rejects.toBeInstanceOf(SourceUnavailable);
  });

  it('offers checks every 5, 10, 15, 30 or 60 minutes, 15 by default', () => {
    expect(GMAIL_CADENCE).toEqual({ defaultMinutes: 15, choices: [5, 10, 15, 30, 60] });
  });
});
