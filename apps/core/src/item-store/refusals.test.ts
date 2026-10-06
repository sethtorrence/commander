import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmailDetail, SourceItem } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, ItemStoreError, openItemStore } from '.';

// Refusals (#201): an Item Ares sent to no model because it holds one of the User's keys or sign-in
// tokens is recorded as skipped (an entry by Ares, which the Update counts) and carries a small note
// while its words stay as they were. Nothing recorded holds the secret.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const KEY = 'zai-e2e-kettle42orchard7violet9';
const T = Date.UTC(2026, 9, 6, 0, 5);
const WHY =
  'Ares skipped Dana Kim’s email: it holds what looks like one of your keys or sign-in tokens. None of it went to a model.';

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-refusals-'));
  clock = T;
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder,
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function email(body: string, subject = 'The new key'): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: '<key@mail.test>',
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<key@mail.test>',
    sourceThreadId: 'g-key',
    from: { name: 'Dana Kim', address: 'dana@northwind.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    sentAt: T,
    snippet: 'Here is the key',
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
  };
  return {
    externalId: 'key',
    kind: 'email',
    title: subject,
    people: ['dana@northwind.test', 'alex@gmail.test'],
    status: 'open',
    detail,
    body: { text: body, html: null, textFromHtml: false, truncated: false },
  };
}

const deliver = (body: string, subject?: string) =>
  store.saveFromSource({ source: 'gmail', account: 'google:alex', items: [email(body, subject)] });
const emailId = () => store.query({ kinds: ['email'] })[0]?.id as string;
const refusals = () => store.activity({ itemId: emailId() }).filter((entry) => entry.action === 'refusal');

describe('refusals', () => {
  it('records an Item Ares skipped as his entry, saying whose it was and why, never the secret', () => {
    deliver(`Here is the key: ${KEY}`);
    const [entry] = store.refusals.record([emailId()], 'Sort into Buckets');

    expect(entry).toMatchObject({ action: 'refusal', by: { kind: 'ares' }, itemId: emailId(), why: WHY });
    expect(refusals()).toHaveLength(1);
    expect(store.get(emailId())?.item.refusal).toEqual({ at: T });
    expect(JSON.stringify(store.activity({}))).not.toContain(KEY);
    expect(store.refusals.recent()).toEqual([
      { itemId: emailId(), entryId: entry?.id, at: T, job: 'Sort into Buckets' },
    ]);
  });

  it('records it once for the same words, and again once they change', () => {
    deliver(`Here is the key: ${KEY}`);
    store.refusals.record([emailId()], 'Sort into Buckets');
    clock += 60_000;
    expect(store.refusals.record([emailId(), emailId()], 'Draft a reply')).toEqual([]);
    expect(refusals()).toHaveLength(1);

    // New words: the note goes, until a job refuses it again.
    deliver(`Here is the key again: ${KEY}`);
    expect(store.get(emailId())?.item.refusal).toBeUndefined();
    expect(store.refusals.record([emailId()], 'Sort into Buckets')).toHaveLength(1);
    expect(refusals()).toHaveLength(2);
    expect(store.get(emailId())?.item.refusal).toEqual({ at: clock });
  });

  it('keeps the note when the same message arrives again unchanged', () => {
    deliver(`Here is the key: ${KEY}`);
    store.refusals.record([emailId()], 'Sort into Buckets');
    deliver(`Here is the key: ${KEY}`);
    expect(store.get(emailId())?.item.refusal).toEqual({ at: T });
  });

  it('lists the refusals since an activity entry, for the Update, and can’t be undone', () => {
    deliver(`Here is the key: ${KEY}`);
    const after = store.activity({ limit: 1 })[0]?.id as number;
    const [entry] = store.refusals.record([emailId()], null);
    expect(store.refusals.since(after)).toEqual([expect.objectContaining({ id: entry?.id, why: WHY })]);
    expect(store.refusals.since(entry?.id as number)).toEqual([]);
    expect(() =>
      store.record({ type: 'undo', entryId: entry?.id as number }, { by: { kind: 'user' } }),
    ).toThrow(ItemStoreError);
    expect(store.get(emailId())?.item.refusal).toBeDefined();
  });

  it('records nothing for an Item that doesn’t exist', () => {
    expect(store.refusals.record(['no-such-item'], 'Sort into Buckets')).toEqual([]);
  });
});
