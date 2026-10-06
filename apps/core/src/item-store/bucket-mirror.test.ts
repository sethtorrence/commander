import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  BUCKET_MIRROR_FIELD,
  type EmailDetail,
  MIRROR_BUCKETS,
  type RuleDraft,
  type SourceItem,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Buckets in Gmail and Outlook (#142) in the Item store, on a real database, with mail arriving
// through saveFromSource as Gmail and Outlook sync save it: Mirror Buckets off by default (nothing
// about Buckets is ever queued for the Source), switched on per Account (every held email's Bucket
// queued once, the grid's Mirror Buckets at Auto), each sort, undo, rename and removal following,
// labels changed at the Source taken as the User's corrections, switching off with or without
// removing the labels; and Skip the inbox for the User's own sorts.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const GMAIL = 'google:alex';
const OUTLOOK = 'outlook:tenant:alex';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 7, 9);
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-mirror-'));
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

function email(id: string, fields: Partial<EmailDetail> = {}): SourceItem {
  const detail: EmailDetail = {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: `mid:<${id}@mail.test>`,
    sourceThreadId: `g-${id}`,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [{ name: 'Alex Kim', address: 'alex@gmail.test' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    sentAt: T - HOUR,
    snippet: `Snippet ${id}`,
    read: true,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [{ id: 'INBOX', name: 'Inbox' }],
    attachments: [],
    hasInvitation: false,
    listUnsubscribe: null,
    listId: null,
    ...fields,
  };
  return {
    externalId: id,
    kind: 'email',
    title: detail.subject,
    people: [detail.from?.address ?? ''],
    status: detail.inInbox ? 'open' : 'archived',
    detail,
  };
}

const outlookEmail = (id: string, categories: string[] = []) =>
  email(id, {
    labels: [],
    folder: { id: 'AAMk-inbox', name: 'Inbox', wellKnown: 'inbox' },
    categories,
  });

const save = (items: SourceItem[], account = GMAIL, source: 'gmail' | 'outlook' = 'gmail') =>
  store.saveFromSource({ source, account, items, deleted: [] });

const itemOf = (externalId: string) => {
  const found = store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId);
  if (!found) throw new Error(`No email ${externalId}`);
  return found;
};
const detailOf = (externalId: string) => itemOf(externalId).detail as EmailDetail;
const bucketOf = (externalId: string) => detailOf(externalId).bucket ?? null;
// What is queued for the Source about an email's Bucket label.
const mirrorQueued = (externalId: string) =>
  store.outgoing
    .forItem(itemOf(externalId).id)
    .filter((row) => row.field === BUCKET_MIRROR_FIELD)
    .map((row) => row.value);
const anyMirrorQueued = () => store.outgoing.list().filter((change) => change.field === BUCKET_MIRROR_FIELD);

const sort = (externalId: string, bucketId: string | null, context: ActionContext = user) =>
  store.record(
    {
      type: 'edit-fields',
      itemId: itemOf(externalId).id,
      fields: { bucket: { bucketId, sortedBy: 'user' } },
    },
    context,
  );

const bucketRule = (bucketId: string, value: string): RuleDraft => ({
  target: { kind: 'bucket', bucketId },
  when: { join: 'and', terms: [{ field: 'gmail.domain', op: 'is', value, label: value }] },
});

const mirrorOn = (account = GMAIL, source: 'gmail' | 'outlook' = 'gmail') =>
  store.bucketMirror.set({ account, source, enabled: true });

describe('Mirror Buckets is off by default', () => {
  it('never queues anything about Buckets for Gmail or Outlook: the User’s sorts, Rules’, undo', () => {
    save([email('m1'), email('m2', { from: { name: 'Stripe', address: 'receipts@stripe.com' } })]);
    save([outlookEmail('o1')], OUTLOOK, 'outlook');
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'stripe.com') });
    store.resort([itemOf('m2').id]);
    const entry = sort('m1', 'fyi');
    sort('o1', 'newsletters');
    store.record({ type: 'undo', entryId: entry.id }, user);

    expect(store.bucketMirror.list()).toEqual([]);
    expect(store.bucketMirror.mirrors(GMAIL)).toBe(false);
    expect(anyMirrorQueued()).toEqual([]);
    expect(store.bucketMirror.plan(GMAIL)).toBeNull();
  });

  it('refuses an edit naming the Bucket label itself: only Commander keeps it, and only when mirroring', () => {
    save([email('m1')]);
    expect(() =>
      store.record(
        { type: 'edit-fields', itemId: itemOf('m1').id, fields: { [BUCKET_MIRROR_FIELD]: 'FYI' } },
        user,
      ),
    ).toThrow(/Bucket label/);
  });

  it('takes no notice of Commander labels changed in Gmail', () => {
    save([email('m1')]);
    sort('m1', 'fyi');
    save([
      email('m1', {
        labels: [
          { id: 'INBOX', name: 'Inbox' },
          { id: 'Label_7', name: 'Commander/Receipts' },
        ],
      }),
    ]);
    expect(bucketOf('m1')).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
  });
});

describe('switching Mirror Buckets on', () => {
  it('sets Mirror Buckets to Auto in the grid and queues every held email’s Bucket, once', () => {
    save([email('m1'), email('m2'), email('m3', { inTrash: true })]);
    sort('m1', 'fyi');
    sort('m3', 'fyi');

    const state = mirrorOn();

    expect(state).toEqual({ account: GMAIL, source: 'gmail', enabled: true, paused: false, removing: false });
    expect(store.autonomy.settings().actions[MIRROR_BUCKETS]).toBe('auto');
    expect(mirrorQueued('m1')).toEqual(['FYI']);
    // Unsorted mail shows nothing; mail in Trash is left alone.
    expect(mirrorQueued('m2')).toEqual([]);
    expect(mirrorQueued('m3')).toEqual([]);
    expect(store.bucketMirror.plan(GMAIL)).toEqual({
      ensure: [{ bucketId: 'fyi', name: 'FYI', colour: 2 }],
      rename: [],
      remove: [],
    });
  });

  it('never labels a draft, which isn’t a message at the Source yet (#138)', () => {
    save([email('d1', { draft: true, inInbox: false, labels: [{ id: 'DRAFT', name: 'Drafts' }] })]);
    sort('d1', 'fyi');
    mirrorOn();
    sort('d1', 'receipts');
    expect(mirrorQueued('d1')).toEqual([]);
  });

  it('follows each sort with the Bucket’s name, and an undo with the name before', () => {
    save([email('m1')]);
    mirrorOn();
    const entry = sort('m1', 'newsletters');
    expect(mirrorQueued('m1')).toEqual(['Newsletters']);
    expect(detailOf('m1').labels.map((label) => label.name)).toContain('Commander/Newsletters');

    store.record({ type: 'undo', entryId: entry.id }, user);
    // Back to what Gmail has (no label): nothing left to send.
    expect(mirrorQueued('m1')).toEqual([]);
  });

  it('follows a Rule’s sort too', () => {
    save([email('m1')]);
    mirrorOn();
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'stripe.com') });
    save([email('m2', { from: { name: 'Stripe', address: 'receipts@stripe.com' } })]);
    expect(bucketOf('m2')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(mirrorQueued('m2')).toEqual(['Receipts']);
  });

  it('pauses while Mirror Buckets is below Auto in the grid', () => {
    save([email('m1')]);
    mirrorOn();
    store.autonomy.saveSettings({
      ...store.autonomy.settings(),
      actions: { [MIRROR_BUCKETS]: 'ask' },
    });
    sort('m1', 'fyi');
    expect(mirrorQueued('m1')).toEqual([]);
    expect(store.bucketMirror.list()[0]).toMatchObject({ enabled: true, paused: true });
  });

  it('renaming a Bucket shows the new name: the label is renamed, and its emails follow', () => {
    save([email('m1')]);
    mirrorOn();
    sort('m1', 'newsletters');
    const plan = store.bucketMirror.plan(GMAIL);
    if (plan) store.bucketMirror.planDone(GMAIL, plan);

    store.changeBucket({ type: 'update', bucketId: 'newsletters', bucket: { name: 'News' } });

    expect(store.bucketMirror.plan(GMAIL)).toEqual({
      ensure: [],
      rename: [{ bucketId: 'newsletters', from: 'Newsletters', to: 'News', colour: 3 }],
      remove: [],
    });
    expect(mirrorQueued('m1')).toEqual(['News']);
  });

  it('removing a Bucket takes its label off its emails and deletes it', () => {
    save([email('m1')]);
    mirrorOn();
    sort('m1', 'junk');
    const plan = store.bucketMirror.plan(GMAIL);
    if (plan) store.bucketMirror.planDone(GMAIL, plan);

    store.changeBucket({ type: 'delete', bucketId: 'junk' });

    expect(mirrorQueued('m1')).toEqual([]);
    expect(detailOf('m1').labels.map((label) => label.name)).not.toContain('Commander/Junk');
    expect(store.bucketMirror.plan(GMAIL)).toEqual({
      ensure: [],
      rename: [],
      remove: [{ bucketId: 'junk', name: 'Junk' }],
    });
  });
});

describe('corrections from the Source while mirroring', () => {
  const labelled = (id: string, ...names: string[]) =>
    email(id, {
      labels: [
        { id: 'INBOX', name: 'Inbox' },
        ...names.map((name, index) => ({ id: `Label_${index + 10}`, name: `Commander/${name}` })),
      ],
    });

  it('a Commander label changed in Gmail moves the email, as the User', () => {
    save([email('m1')]);
    mirrorOn();
    sort('m1', 'fyi');
    // Gmail answers the write: the label is there.
    save([labelled('m1', 'FYI')]);
    store.outgoing.settle(store.outgoing.forItem(itemOf('m1').id).map((row) => row.id));
    save([labelled('m1', 'FYI')]);

    save([labelled('m1', 'Newsletters')]);

    expect(bucketOf('m1')).toEqual({ bucketId: 'newsletters', sortedBy: 'user' });
    const [latest] = store.activity({ itemId: itemOf('m1').id, limit: 1 });
    expect(latest).toMatchObject({ by: { kind: 'user' }, why: 'Moved to Newsletters in Gmail' });
    // Gmail already shows exactly that one: nothing to send back.
    expect(mirrorQueued('m1')).toEqual([]);
  });

  it('a second Commander label added in Gmail moves it there and takes the first one off', () => {
    save([labelled('m1')]);
    mirrorOn();
    sort('m1', 'fyi');
    store.outgoing.settle(store.outgoing.forItem(itemOf('m1').id).map((row) => row.id));
    save([labelled('m1', 'FYI')]);

    save([labelled('m1', 'FYI', 'Receipts')]);

    expect(bucketOf('m1')).toEqual({ bucketId: 'receipts', sortedBy: 'user' });
    expect(mirrorQueued('m1')).toEqual(['Receipts']);
  });

  it('a Commander category taken off in Outlook leaves the email Unsorted, as the User', () => {
    save([outlookEmail('o1')], OUTLOOK, 'outlook');
    mirrorOn(OUTLOOK, 'outlook');
    sort('o1', 'fyi');
    store.outgoing.settle(store.outgoing.forItem(itemOf('o1').id).map((row) => row.id));
    save([outlookEmail('o1', ['Blue', 'Commander: FYI'])], OUTLOOK, 'outlook');

    save([outlookEmail('o1', ['Blue'])], OUTLOOK, 'outlook');

    expect(bucketOf('o1')).toEqual({ bucketId: null, sortedBy: 'user' });
    const [latest] = store.activity({ itemId: itemOf('o1').id, limit: 1 });
    expect(latest?.why).toBe('Taken out of its Bucket in Outlook');
  });

  it('waits while Commander’s own change is still on its way', () => {
    save([labelled('m1', 'FYI')]);
    mirrorOn();
    sort('m1', 'receipts');
    // A sync still showing the old label, before the write went: the User's sort stands.
    save([labelled('m1', 'Newsletters')]);
    expect(bucketOf('m1')).toEqual({ bucketId: 'receipts', sortedBy: 'user' });
  });

  it('never archives on a correction, even into a Bucket that skips the inbox', () => {
    store.changeBucket({ type: 'update', bucketId: 'newsletters', bucket: { skipInbox: true } });
    save([labelled('m1', 'FYI')]);
    mirrorOn();
    sort('m1', 'fyi');
    store.outgoing.settle(store.outgoing.forItem(itemOf('m1').id).map((row) => row.id));
    save([labelled('m1', 'Newsletters')]);
    expect(bucketOf('m1')?.bucketId).toBe('newsletters');
    expect(detailOf('m1').inInbox).toBe(true);
  });
});

describe('Commander’s labels in the Email Section', () => {
  it('are never shown or offered as the User’s labels: the Bucket chip says it', () => {
    save([
      email('m1', {
        labels: [
          { id: 'INBOX', name: 'Inbox' },
          { id: 'Label_1', name: 'Travel' },
          { id: 'Label_9', name: 'Commander/FYI' },
        ],
      }),
    ]);
    const [thread] = store.emailThreads({ account: GMAIL }).threads;
    expect(thread?.labels?.map((label) => label.name)).toEqual(['Travel']);
    expect(store.emailLabels(GMAIL).map((label) => label.name)).toEqual(['Travel']);
  });
});

describe('switching Mirror Buckets off', () => {
  it('stops writing at once: what was queued goes, and later sorts queue nothing', () => {
    save([email('m1'), email('m2')]);
    mirrorOn();
    sort('m1', 'fyi');

    const state = store.bucketMirror.set({ account: GMAIL, source: 'gmail', enabled: false });

    expect(state).toMatchObject({ enabled: false, removing: false });
    expect(anyMirrorQueued()).toEqual([]);
    sort('m2', 'receipts');
    expect(anyMirrorQueued()).toEqual([]);
    expect(store.bucketMirror.plan(GMAIL)).toBeNull();
    // The grid's override goes with the last Account mirroring.
    expect(store.autonomy.settings().actions[MIRROR_BUCKETS]).toBeUndefined();
  });

  it('removing the labels takes them off every email showing one, and deletes them', () => {
    save([email('m1'), email('m2')]);
    mirrorOn();
    sort('m1', 'fyi');
    const plan = store.bucketMirror.plan(GMAIL);
    if (plan) store.bucketMirror.planDone(GMAIL, plan);
    store.outgoing.settle(store.outgoing.forItem(itemOf('m1').id).map((row) => row.id));
    save([
      email('m1', {
        labels: [
          { id: 'INBOX', name: 'Inbox' },
          { id: 'Label_9', name: 'Commander/FYI' },
        ],
      }),
    ]);

    const state = store.bucketMirror.set({
      account: GMAIL,
      source: 'gmail',
      enabled: false,
      removeLabels: true,
    });

    expect(state).toMatchObject({ enabled: false, removing: true });
    expect(mirrorQueued('m1')).toEqual([null]);
    expect(mirrorQueued('m2')).toEqual([]);
    expect(store.bucketMirror.plan(GMAIL)).toEqual({
      ensure: [],
      rename: [],
      remove: [{ bucketId: 'fyi', name: 'FYI' }],
    });
    // Commander's Bucket stays: only the Source's labels go.
    expect(bucketOf('m1')?.bucketId).toBe('fyi');
  });
});

describe('Skip the inbox', () => {
  it('is off for every starter Bucket', () => {
    expect(store.buckets().filter((bucket) => bucket.skipInbox)).toEqual([]);
  });

  it('archives the User’s sort at once, as part of their change; undo brings it back to the inbox', () => {
    store.changeBucket({ type: 'update', bucketId: 'newsletters', bucket: { skipInbox: true } });
    save([email('m1')]);

    const entry = sort('m1', 'newsletters');

    expect(detailOf('m1')).toMatchObject({ inInbox: false, bucket: { bucketId: 'newsletters' } });
    expect(store.outgoing.forItem(itemOf('m1').id).map((row) => [row.field, row.value])).toEqual([
      ['inbox', false],
    ]);
    store.record({ type: 'undo', entryId: entry.id }, user);
    expect(detailOf('m1').inInbox).toBe(true);
  });

  it('never archives a Rule’s sort by itself: that is a suggestion (the Core’s, through the gate)', () => {
    store.changeBucket({ type: 'update', bucketId: 'receipts', bucket: { skipInbox: true } });
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'stripe.com') });
    save([email('m2', { from: { name: 'Stripe', address: 'receipts@stripe.com' } })]);
    expect(detailOf('m2')).toMatchObject({
      inInbox: true,
      bucket: { bucketId: 'receipts', sortedBy: 'rule' },
    });
  });
});
