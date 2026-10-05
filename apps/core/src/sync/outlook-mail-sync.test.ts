import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type EmailDetail,
  type ItemAction,
  type SourceItem,
  type ThreadAction,
  threadActionFields,
} from '@commander/domain';
import { createOutlookSource, type SourceCatalog } from '@commander/sources';
import firstSync from '@commander/sources/src/outlook/recorded/first-sync.json';
import incremental from '@commander/sources/src/outlook/recorded/incremental.json';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';

// Outlook mail's adapter (#136) saving into a real Item store, wired as the Core wires it: its threads
// sit in the one inbox beside Gmail's, threaded across folders (a reply in Sent Items joins its
// conversation); its folders are the views and Move to folder's choices; a message moved between
// folders keeps its Item, filing and history; and organising it queues each synced field for Outlook,
// shown at once and undone field by field (ADR 0003).

type Exchange = {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown };
};

const GRAPH = 'https://graph.test/v1.0';
const NOW = Date.UTC(2026, 9, 3, 12);
const ACCOUNT = 'outlook:fake-tenant-0001:6f1c2a40-0000-4000-8000-00000000a001';
const GMAIL_ACCOUNT = 'google:104512345678901234567';
const PROJECTS = 'AAMkAGI2-fld-projects=';
const RECEIPTS = 'AAMkAGI2-fld-receipts=';
const user: ActionContext = { by: { kind: 'user' } };

let dir: string;
let store: ItemStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-outlook-mail-'));
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => NOW,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Answers each request with the next recording, in order.
function answering(exchanges: Exchange[]) {
  const queue = structuredClone(exchanges);
  return (async (url: string | URL | Request) => {
    const path = decodeURIComponent(String(url).slice(GRAPH.length));
    const next = queue.shift();
    if (next?.request.path !== path) throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(next.response.body), { status: next.response.status });
  }) as typeof globalThis.fetch;
}

async function sync(exchanges: Exchange[], cursor: unknown = null) {
  const adapter = createOutlookSource({ graphUrl: () => GRAPH, fetch: answering(exchanges), now: () => NOW });
  const result = await adapter.sync({
    account: ACCOUNT,
    cursor,
    mode: 'full',
    connectedAt: NOW,
    stored: (ids) =>
      store.fromSource({ source: 'outlook', account: ACCOUNT }, ids).map((item) => ({
        externalId: item.externalId ?? '',
        title: item.title,
        people: item.people,
        status: item.status,
        detail: item.detail,
      })),
    heldIds: () => store.externalIds({ source: 'outlook', account: ACCOUNT }),
    saveCatalog: (catalog: SourceCatalog) => store.syncState.saveCatalog(ACCOUNT, 'outlook', catalog, NOW),
    accessToken: async () => ({ token: 'eyJ0eXAiOi.test', kind: 'oauth' }),
    save: (page) => store.saveFromSource({ source: 'outlook', account: ACCOUNT, ...page }),
    signal: new AbortController().signal,
  });
  return result.cursor;
}

const subjects = (query: Parameters<ItemStore['emailThreads']>[0] = {}) =>
  store.emailThreads(query).threads.map((thread) => thread.subject);

const threadOf = (subject: string, view: 'inbox' | 'archive' | 'trash' = 'inbox') => {
  const found = store.emailThreads({ view }).threads.find((thread) => thread.subject === subject);
  if (!found) throw new Error(`No thread ${subject} in ${view}`);
  return found;
};

function act(subject: string, action: ThreadAction, view: 'inbox' | 'archive' | 'trash' = 'inbox') {
  const summary = threadOf(subject, view);
  const thread = store.emailThread(summary.account, summary.threadKey);
  const messages = (thread?.messages ?? []).map(({ item }) => ({
    id: item.id,
    detail: item.detail as EmailDetail,
  }));
  const actions = threadActionFields(action, messages).map(
    ({ itemId, fields }): ItemAction => ({ type: 'edit-fields', itemId, fields }),
  );
  return store.recordAll(actions, user);
}

const queued = () =>
  store.outgoing
    .list()
    .map(({ field }) => field)
    .sort();

describe('Outlook mail in the Item store', () => {
  it('threads a conversation across folders, and lists Outlook’s threads in the one inbox with Gmail’s', async () => {
    await sync(firstSync as Exchange[]);
    const gmail: SourceItem = {
      externalId: '19a4c3d4e5f6a704',
      kind: 'email',
      title: 'From Gmail',
      people: ['alex@gmail.test'],
      status: 'open',
      detail: {
        ...(store.emailThread(ACCOUNT, threadOf('Staging certificate').threadKey)?.messages[0]?.item
          .detail as EmailDetail),
        messageId: '<gmail-1@mail.gmail.test>',
        threadKey: 'key:gmail',
        sourceThreadId: '19a4c3d4e5f6a704',
        subject: 'From Gmail',
        sentAt: NOW - 60_000,
        folder: undefined,
        labels: [{ id: 'INBOX', name: 'Inbox' }],
        attachments: [],
      },
    };
    delete (gmail.detail as EmailDetail).folder;
    store.saveFromSource({ source: 'gmail', account: GMAIL_ACCOUNT, items: [gmail], deleted: [] });

    expect(subjects()).toEqual([
      'From Gmail',
      'Staging certificate',
      'RE: Q4 offsite dates',
      'Weekly digest: café edition',
    ]);
    // The Account switcher narrows to either.
    expect(subjects({ account: ACCOUNT })).toEqual([
      'Staging certificate',
      'RE: Q4 offsite dates',
      'Weekly digest: café edition',
    ]);
    expect(subjects({ account: GMAIL_ACCOUNT })).toEqual(['From Gmail']);
    // Dana's message, the User's reply from Sent Items and Dana's answer: one thread of three.
    const offsite = threadOf('RE: Q4 offsite dates');
    expect(offsite).toMatchObject({
      messageCount: 3,
      unreadCount: 1,
      starred: true,
      senders: ['Dana Whitfield', 'me'],
    });
  });

  it('has the Account’s folders as views and as Move to folder’s choices, Outlook’s own aside', async () => {
    await sync(firstSync as Exchange[]);

    expect(store.emailLabels(ACCOUNT)).toEqual([
      { id: RECEIPTS, name: 'Inbox / Receipts' },
      { id: PROJECTS, name: 'Projects' },
    ]);
    const views = store.emailViews({ account: ACCOUNT }).views;
    expect(views.map((view) => [view.name, view.threads])).toEqual([
      ['Inbox', 3],
      ['Starred', 1],
      ['Snoozed', 0],
      ['Archive', 2],
      ['Trash', 0],
      ['Inbox / Receipts', 0],
      ['Projects', 1],
    ]);
  });

  it('keeps a message’s Item when it moves between folders, and tombstones what left every synced folder', async () => {
    const cursor = await sync(firstSync as Exchange[]);
    const digest = threadOf('Weekly digest: café edition');
    const [digestId] = digest.itemIds;
    store.record({ type: 'update', itemId: digestId as string, changes: { filing: null } }, user);

    await sync(incremental.changes as Exchange[], cursor);

    expect(subjects()).toEqual(['RE: Q4 offsite dates']);
    expect(
      store.emailThreads({ view: `label:${PROJECTS}` }).threads.map((thread) => thread.itemIds),
    ).toContainEqual([digestId]);
    expect(subjects({ view: 'trash' })).toEqual(['Staging certificate']);
    expect(store.fromSource({ source: 'outlook', account: ACCOUNT }, ['AAMkAGI2-msg-invoice='])).toEqual([]);
    expect(threadOf('RE: Q4 offsite dates').messageCount).toBe(4);
  });

  it('sorts an Outlook thread into a Bucket like any other (#137), never queued for Outlook', async () => {
    await sync(firstSync as Exchange[]);
    const [bucket] = store.buckets();
    if (!bucket) throw new Error('No starter Bucket');

    act('Staging certificate', { type: 'bucket', bucketId: bucket.id });

    expect(store.emailThreads({ bucket: bucket.id }).threads.map((thread) => thread.subject)).toEqual([
      'Staging certificate',
    ]);
    expect(threadOf('Staging certificate').bucket).toMatchObject({ bucketId: bucket.id, sortedBy: 'user' });
    expect(queued()).toEqual([]);
  });

  it('organises a thread at once, queueing each message’s fields for Outlook, and undo takes them back', async () => {
    await sync(firstSync as Exchange[]);

    const moved = act('Weekly digest: café edition', {
      type: 'move',
      folder: { id: PROJECTS, name: 'Projects' },
    });
    expect(subjects()).not.toContain('Weekly digest: café edition');
    expect(
      store.emailThreads({ view: `label:${PROJECTS}` }).threads.map((thread) => thread.subject),
    ).toContain('Weekly digest: café edition');
    expect(queued()).toEqual(['folder', 'inbox']);
    store.recordAll(moved.map((entry): ItemAction => ({ type: 'undo', entryId: entry.id })).reverse(), user);
    expect(subjects()).toContain('Weekly digest: café edition');
    expect(queued()).toEqual([]);

    act('Staging certificate', { type: 'trash' });
    expect(subjects({ view: 'trash' })).toEqual(['Staging certificate']);
    act('Staging certificate', { type: 'move-to-inbox' }, 'trash');
    expect(subjects()).toContain('Staging certificate');
    expect(queued()).toEqual([]);
  });
});
