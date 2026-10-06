import {
  BUCKET_MIRROR_FIELD,
  type EmailDetail,
  type MirrorPlan,
  mirroredBucketNames,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import type { FieldChange, StoredItem } from '../source';
import { createOutlookSource } from './outlook-source';
import mirror from './recorded/mirror.json';
import write from './recorded/write.json';

// Mirror Buckets in Outlook (#142), against recorded Microsoft Graph v1.0 responses: an email's
// `bucket-mirror` field kept as exactly one "Commander: <Bucket>" category beside the User's own, in one
// PATCH of its categories (a change made in Outlook since, later than Commander's, winning); and an
// Account's category plan in the mailbox's master list: made with Outlook's preset colours (wrapping
// after 25), a renamed Bucket's made anew and the old one deleted (categories can't be renamed), a
// removed Bucket's deleted, and the colours left out, without holding anything up, when Commander may
// not change the master list (MailboxSettings.ReadWrite not granted).

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};
const recorded = mirror as unknown as Record<keyof typeof mirror, Exchange[]>;
const writes = write as unknown as Record<keyof typeof write, Exchange[]>;

const GRAPH = 'https://graph.test/v1.0';
const MADE_AT = Date.UTC(2026, 9, 7, 9);
const OFFSITE = 'AAMkAGI2-msg-offsite-2=';
const INBOX = { id: 'AAMkAGI2-fld-inbox=', name: 'Inbox', wellKnown: 'inbox' };

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges];
  const sent: { method: string; path: string }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const method = init?.method ?? 'GET';
    sent.push({ method, path });
    const next = queue.shift();
    if (next?.request.path !== path || next.request.method !== method)
      throw new Error(`Unexpected ${method} ${path}, wanted ${next?.request.method} ${next?.request.path}`);
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(next.request.body);
    const { status, headers, body } = next.response;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, remaining: () => queue.length };
}

function stored(categories: string[]): StoredItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${OFFSITE}@mail.test>`,
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
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    folder: INBOX,
    labels: [],
    categories,
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  return { externalId: OFFSITE, title: detail.subject, people: [], status: 'open', detail };
}

const change = (value: unknown, synced: unknown): FieldChange => ({
  field: BUCKET_MIRROR_FIELD,
  value,
  synced,
  madeAt: MADE_AT,
});

let accounts = 0;

// A fresh adapter whose mailbox is known (the archive recording looks up Outlook's own folders first).
async function adapter() {
  let current: typeof globalThis.fetch = globalThis.fetch;
  const source = createOutlookSource({
    graphUrl: () => GRAPH,
    fetch: (url, init) => current(url, init),
    now: () => MADE_AT + 60_000,
  });
  const account = `outlook:t:mirror-${++accounts}`;
  const prime = replay(writes.archive);
  current = prime.fetch;
  await source.write?.({
    account,
    externalId: OFFSITE,
    changes: [{ field: 'inbox', value: false, synced: true, madeAt: MADE_AT }],
    stored: () => [stored([])],
    accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { source, account, use: (fetch: typeof globalThis.fetch) => (current = fetch) };
}

async function writeTo(exchanges: Exchange[], item: StoredItem, changes: FieldChange[]) {
  const { source, account, use } = await adapter();
  const recording = replay(exchanges);
  use(recording.fetch);
  const result = await source.write?.({
    account,
    externalId: item.externalId,
    changes,
    stored: () => [item],
    accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording, detail: result?.item?.detail as EmailDetail };
}

async function carryOut(exchanges: Exchange[], plan: Partial<MirrorPlan>) {
  const recording = replay(exchanges);
  const source = createOutlookSource({ graphUrl: () => GRAPH, fetch: recording.fetch, now: () => MADE_AT });
  const result = await source.mirrorBuckets?.({
    account: `outlook:t:plan-${++accounts}`,
    plan: { ensure: [], rename: [], remove: [], ...plan },
    accessToken: async () => ({ token: 'eyJ0eXAiOi.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

describe('an email’s Bucket category in Outlook', () => {
  it('adds the Bucket’s category beside the User’s own, in one PATCH', async () => {
    const { detail, remaining, result } = await writeTo(recorded.mirror, stored(['Blue category']), [
      change('FYI', null),
    ]);
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
    expect(detail.categories).toEqual(['Blue category', 'Commander: FYI']);
    expect(mirroredBucketNames(detail)).toBe('FYI');
  });

  it('keeps exactly one: the others Commander made come off', async () => {
    const { detail, remaining } = await writeTo(
      recorded.mirrorMove,
      stored(['Commander: FYI', 'Commander: Newsletters', 'Blue category']),
      [change('Receipts', ['FYI', 'Newsletters'])],
    );
    expect(remaining()).toBe(0);
    expect(detail.categories).toEqual(['Blue category', 'Commander: Receipts']);
  });

  it('takes it off when the email shows no Bucket (removing the categories)', async () => {
    const { detail, remaining } = await writeTo(
      recorded.mirrorOff,
      stored(['Blue category', 'Commander: FYI']),
      [change(null, 'FYI')],
    );
    expect(remaining()).toBe(0);
    expect(detail.categories).toEqual(['Blue category']);
  });

  it('leaves a category changed in Outlook later than the User’s change as Outlook has it', async () => {
    const { result, sent, remaining } = await writeTo(recorded.mirrorSuperseded, stored(['Commander: FYI']), [
      change('Receipts', 'FYI'),
    ]);
    expect(remaining()).toBe(0);
    expect(sent.map((each) => each.method)).toEqual(['GET']);
    expect(result?.superseded).toEqual([
      { field: BUCKET_MIRROR_FIELD, by: null, at: Date.parse('2026-10-07T09:30:00Z') },
    ]);
  });
});

describe('an Account’s Bucket categories in Outlook', () => {
  it('makes, renames (anew, then the old one deleted) and deletes categories in the master list', async () => {
    const { result, remaining, sent } = await carryOut(recorded.plan, {
      rename: [{ bucketId: 'newsletters', from: 'Newsletters', to: 'News', colour: 3 }],
      ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }],
      remove: [{ bucketId: 'junk', name: 'Junk' }],
    });
    expect(remaining()).toBe(0);
    expect(result?.problems).toEqual([]);
    // The User's own category is never touched.
    expect(sent.some((each) => each.path.endsWith('/cat-blue'))).toBe(false);
  });

  it('wraps Outlook’s 25 preset colours', async () => {
    const { remaining } = await carryOut(recorded.planWraps, {
      ensure: [{ bucketId: 'travel', name: 'Travel', colour: 26 }],
    });
    expect(remaining()).toBe(0);
  });

  it('leaves the colours out without holding anything up when Commander may not change the master list', async () => {
    const { result, remaining } = await carryOut(recorded.planWithoutPermission, {
      ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }],
    });
    expect(remaining()).toBe(0);
    expect(result?.problems).toEqual([
      'Outlook wouldn’t let Commander change its categories (Grant access in Settings → Accounts gives it MailboxSettings.ReadWrite), so they show without colours.',
    ]);
  });
});
