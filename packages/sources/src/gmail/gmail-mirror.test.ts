import {
  BUCKET_MIRROR_FIELD,
  type EmailDetail,
  type MirrorPlan,
  mirroredBucketNames,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import type { FieldChange, StoredItem } from '../source';
import { createGmailSource } from './gmail-source';
import mirror from './recorded/mirror.json';
import write from './recorded/write.json';

// Mirror Buckets in Gmail (#142), against recorded Gmail API v1 responses: an email's `bucket-mirror`
// field kept as exactly one `Commander/<Bucket>` label beside the User's own (made when Gmail hasn't
// got it yet, the others taken off, a change made in Gmail since winning), and an Account's label plan:
// labels made under a `Commander` parent, renamed with their Bucket, deleted with it, and the parent
// gone only once it is empty and on no message. Each recording pins down the requests, in order.

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};
const recorded = mirror as unknown as Record<keyof typeof mirror, Exchange[]>;
const writes = write as unknown as Record<keyof typeof write, Exchange[]>;

const GMAIL = 'https://gmail.test';
const ACCOUNT = 'google:104512345678901234567';
const M = '19a4c3d4e5f6a704';
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
    return new Response(status === 204 ? null : JSON.stringify(answer), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, remaining: () => queue.length };
}

const NAMES: Record<string, string> = {
  INBOX: 'Inbox',
  CATEGORY_PERSONAL: 'Personal',
  Label_1: 'Receipts',
  Label_20: 'Commander/FYI',
  Label_22: 'Commander/Newsletters',
};

function stored(labels: string[], sourceVersion: string): StoredItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${M}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<offsite-1@mail.northwind.test>',
    sourceThreadId: '19a1f0c2d3e4f501',
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Weekly digest',
    sentAt: MADE_AT - 86_400_000,
    snippet: '',
    read: true,
    starred: false,
    inInbox: labels.includes('INBOX'),
    sentByMe: false,
    labels: labels.map((id) => ({ id, name: NAMES[id] ?? id })),
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    sourceVersion,
  };
  return { externalId: M, title: detail.subject, people: [], status: 'open', detail };
}

const change = (value: unknown, synced: unknown): FieldChange => ({
  field: BUCKET_MIRROR_FIELD,
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
    stored: () => [item],
    accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording, detail: result?.item?.detail as EmailDetail };
}

async function carryOut(exchanges: Exchange[], plan: Partial<MirrorPlan>) {
  const recording = replay(exchanges);
  const source = createGmailSource({ gmailUrl: () => GMAIL, fetch: recording.fetch, now: () => NOW });
  const result = await source.mirrorBuckets?.({
    account: ACCOUNT,
    plan: { ensure: [], rename: [], remove: [], ...plan },
    accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
    signal: new AbortController().signal,
  });
  return { result, ...recording };
}

describe('an email’s Bucket label in Gmail', () => {
  it('puts the Bucket’s label on, and the Item comes back with it', async () => {
    const { detail, remaining, result } = await writeTo(
      recorded.mirror,
      stored(['INBOX', 'CATEGORY_PERSONAL'], '5009'),
      [change('FYI', null)],
    );
    expect(remaining()).toBe(0);
    expect(result?.superseded).toEqual([]);
    expect(detail.labels).toContainEqual({ id: 'Label_20', name: 'Commander/FYI' });
    expect(mirroredBucketNames(detail)).toBe('FYI');
    expect(detail.sourceVersion).toBe('5012');
  });

  it('makes the label first when Gmail hasn’t got it', async () => {
    const { detail, remaining } = await writeTo(
      recorded.mirrorCreates,
      stored(['INBOX', 'CATEGORY_PERSONAL'], '5009'),
      [change('FYI', null)],
    );
    expect(remaining()).toBe(0);
    expect(detail.labels).toContainEqual({ id: 'Label_21', name: 'Commander/FYI' });
  });

  it('keeps exactly one: the others Commander made come off, the User’s own labels stay', async () => {
    const { detail, remaining } = await writeTo(
      recorded.mirrorMove,
      stored(['INBOX', 'Label_20', 'Label_22'], '5009'),
      [change('Receipts', ['FYI', 'Newsletters'])],
    );
    expect(remaining()).toBe(0);
    expect(detail.labels).toEqual([
      { id: 'INBOX', name: 'Inbox' },
      { id: 'Label_23', name: 'Commander/Receipts' },
    ]);
  });

  it('takes the label off when the email shows no Bucket (removing the labels)', async () => {
    const { detail, remaining } = await writeTo(
      recorded.mirrorOff,
      stored(['INBOX', 'Label_1', 'Label_20'], '5009'),
      [change(null, 'FYI')],
    );
    expect(remaining()).toBe(0);
    expect(detail.labels).toEqual([
      { id: 'INBOX', name: 'Inbox' },
      { id: 'Label_1', name: 'Receipts' },
    ]);
  });

  it('leaves a Bucket label changed in Gmail since as Gmail has it: the newer change wins', async () => {
    const { result, sent, remaining } = await writeTo(
      recorded.mirrorNewerInGmail,
      stored(['INBOX', 'Label_20'], '5009'),
      [change('Receipts', 'FYI')],
    );
    expect(remaining()).toBe(0);
    expect(sent.some((each) => each.method === 'POST')).toBe(false);
    expect(result?.superseded).toEqual([{ field: BUCKET_MIRROR_FIELD, by: null, at: NOW }]);
  });

  it('takes a label’s new name once its Bucket was renamed, with nothing to send', async () => {
    const { detail, sent, remaining } = await writeTo(
      recorded.mirrorRenamed,
      stored(['INBOX', 'Label_22'], '5012'),
      [change('News', 'Newsletters')],
    );
    expect(remaining()).toBe(0);
    expect(sent.map((each) => each.method)).toEqual(['GET', 'GET']);
    expect(detail.labels).toContainEqual({ id: 'Label_22', name: 'Commander/News' });
  });

  it('never takes a label still on its way for one Gmail has (a sync reading history meanwhile)', async () => {
    const recording = replay(recorded.historyWithStandIn);
    const source = createGmailSource({ gmailUrl: () => GMAIL, fetch: recording.fetch, now: () => NOW });
    // Commander holds the message with its new Bucket label on top, not yet written.
    const item = stored(['INBOX'], '5009');
    const detail = item.detail as EmailDetail;
    detail.labels.push({ id: 'Commander/FYI', name: 'Commander/FYI' });
    const saved: EmailDetail[] = [];
    await source.sync({
      account: ACCOUNT,
      cursor: { v: 1, windowStart: NOW - 30 * 86_400_000, historyId: '6000' },
      mode: 'full',
      stored: () => [item],
      heldIds: () => [M],
      accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
      save: (page) => saved.push(...page.items.map((each) => each.detail as EmailDetail)),
      signal: new AbortController().signal,
    });
    expect(recording.remaining()).toBe(0);
    expect(saved[0]?.labels.map((label) => label.id)).toEqual(['INBOX', 'STARRED']);
    expect(mirroredBucketNames(saved[0] as EmailDetail)).toBeNull();
  });

  it('never asks for or changes labels for an ordinary change (mirroring off writes no Bucket label)', async () => {
    const recording = replay(writes.archive);
    const source = createGmailSource({ gmailUrl: () => GMAIL, fetch: recording.fetch, now: () => NOW });
    await source.write?.({
      account: ACCOUNT,
      externalId: M,
      changes: [{ field: 'inbox', value: false, synced: true, madeAt: MADE_AT }],
      stored: () => [stored(['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'], '5009')],
      accessToken: async () => ({ token: 'ya29.recorded', kind: 'oauth' }),
      signal: new AbortController().signal,
    });
    expect(recording.sent.filter((each) => each.path.includes('/labels'))).toEqual([]);
  });
});

describe('an Account’s Bucket labels in Gmail', () => {
  it('renames a Bucket’s label, makes a new one and deletes a removed Bucket’s', async () => {
    const { remaining, result } = await carryOut(recorded.plan, {
      rename: [{ bucketId: 'newsletters', from: 'Newsletters', to: 'News', colour: 3 }],
      ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }],
      remove: [{ bucketId: 'junk', name: 'Junk' }],
    });
    expect(remaining()).toBe(0);
    expect(result?.problems).toEqual([]);
    // labels.list, labels.patch, labels.create and labels.delete, in Gmail's quota units.
    expect(result?.cost).toEqual({ requests: 4, complexity: 1 + 5 + 5 + 5 });
  });

  it('makes the Commander parent first, so the labels nest under it', async () => {
    const { remaining } = await carryOut(recorded.planCreatesParent, {
      ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }],
    });
    expect(remaining()).toBe(0);
  });

  it('renaming onto a label that is already there deletes the old one', async () => {
    const { remaining } = await carryOut(recorded.planRenameOntoExisting, {
      rename: [{ bucketId: 'newsletters', from: 'Newsletters', to: 'News', colour: 3 }],
    });
    expect(remaining()).toBe(0);
  });

  it('deletes the parent once its last label goes, unless a message carries it', async () => {
    const plan = { remove: [{ bucketId: 'fyi', name: 'FYI' }] };
    expect((await carryOut(recorded.planRemoveAll, plan)).remaining()).toBe(0);
    expect((await carryOut(recorded.planRemoveKeepsUsedParent, plan)).remaining()).toBe(0);
  });

  it('never touches a label that isn’t Commander’s', async () => {
    const { sent } = await carryOut(recorded.plan, {
      rename: [{ bucketId: 'newsletters', from: 'Newsletters', to: 'News', colour: 3 }],
      ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }],
      remove: [{ bucketId: 'junk', name: 'Junk' }],
    });
    expect(sent.some((each) => each.path.endsWith('/labels/Label_1'))).toBe(false);
  });
});
