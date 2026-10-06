import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionContext,
  type Bucket,
  type EmailDetail,
  type ItemAction,
  NEEDS_REPLY,
  type Project,
  type RuleDraft,
  type SourceItem,
  STARTER_BUCKETS,
  type ThreadAction,
  threadActionFields,
  UNSORTED,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ComposeContext, type ItemStore, openItemStore } from '.';

// Buckets in the Item store (#137), on a real database, with mail arriving through saveFromSource as
// Gmail sync saves it: the starter set on a fresh install, Settings → Buckets' changes, an email's
// Bucket (one per email, independent of its Project, kept through syncs), Bucket Rules sorting mail
// as it arrives and re-sorting what is held, and the Email Section's Bucket filter and counts.

const migrationsFolder = join(import.meta.dirname, '../../drizzle');
const ALEX = 'google:alex';
const OUTLOOK = 'microsoft:alex';
const user: ActionContext = { by: { kind: 'user' } };
const T = Date.UTC(2026, 9, 7, 9);
const HOUR = 60 * 60_000;

let dir: string;
let store: ItemStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-buckets-'));
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
    read: false,
    starred: false,
    inInbox: true,
    sentByMe: false,
    labels: [
      { id: 'INBOX', name: 'Inbox' },
      { id: 'UNREAD', name: 'Unread' },
    ],
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

const stripe = (id: string, fields: Partial<EmailDetail> = {}) =>
  email(id, {
    from: { name: 'Stripe', address: 'receipts@stripe.com' },
    subject: `Receipt ${id}`,
    ...fields,
  });

const save = (items: SourceItem[], account = ALEX, source: 'gmail' | 'outlook' = 'gmail') =>
  store.saveFromSource({ source, account, items, deleted: [] });

const itemOf = (externalId: string) => {
  const found = store.query({ kinds: ['email'] }).find((item) => item.externalId === externalId);
  if (!found) throw new Error(`No email ${externalId}`);
  return found;
};
const bucketOf = (externalId: string) => {
  const detail = itemOf(externalId).detail as EmailDetail;
  return detail.bucket ?? null;
};
const threadOf = (externalId: string) => {
  const item = itemOf(externalId);
  return store.emailThread(item.account as string, (item.detail as EmailDetail).threadKey);
};

// What `v` does from the Email Section: moves the whole thread, as one change, by the User.
function moveThread(externalId: string, bucketId: string | null) {
  const thread = threadOf(externalId);
  const messages = (thread?.messages ?? []).map(({ item }) => ({
    id: item.id,
    detail: item.detail as EmailDetail,
  }));
  const action: ThreadAction = { type: 'bucket', bucketId };
  const actions = threadActionFields(action, messages).map(
    ({ itemId, fields }): ItemAction => ({ type: 'edit-fields', itemId, fields }),
  );
  return store.recordAll(actions, user);
}

const bucketRule = (
  bucketId: string,
  field: string,
  value: string,
  op: 'is' | 'contains' = 'is',
): RuleDraft => ({
  target: { kind: 'bucket', bucketId },
  when: { join: 'and', terms: [{ field, op, value, label: value }] },
});

const names = () => store.buckets().map((bucket) => bucket.name);

describe('Buckets', () => {
  it('a fresh install has the seven starter Buckets, in order, with their descriptions', () => {
    expect(store.buckets().map(({ id, name, description }) => ({ id, name, description }))).toEqual(
      STARTER_BUCKETS,
    );
    expect(store.buckets().map((bucket) => bucket.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps the User’s Buckets across restarts, and never puts back one they removed', () => {
    store.changeBucket({ type: 'delete', bucketId: 'junk' });
    store.close();
    store = openItemStore({
      path: join(dir, 'commander.db'),
      snapshotDir: join(dir, 'snapshots'),
      migrationsFolder,
      now: () => clock,
    });
    expect(names()).not.toContain('Junk');
    expect(names()).toHaveLength(6);
  });

  it('renames, edits the description, adds and reorders', () => {
    store.changeBucket({ type: 'update', bucketId: 'fyi', bucket: { name: 'For your information' } });
    store.changeBucket({ type: 'update', bucketId: 'fyi', bucket: { description: 'Good to know.' } });
    const added = store.changeBucket({
      type: 'create',
      bucket: { name: 'Travel', description: 'Flights, hotels and itineraries.' },
    }).bucket as Bucket;
    expect(added).toMatchObject({
      name: 'Travel',
      description: 'Flights, hotels and itineraries.',
      order: 7,
    });
    store.changeBucket({ type: 'move', bucketId: added.id, position: 1 });
    expect(names()).toEqual([
      'Needs reply',
      'Travel',
      'Waiting on others',
      'For your information',
      'Newsletters',
      'Receipts',
      'Calendar',
      'Junk',
    ]);
    expect(store.buckets().find((bucket) => bucket.id === 'fyi')?.description).toBe('Good to know.');
  });

  it('refuses a Bucket without a name, or one named like another', () => {
    expect(() => store.changeBucket({ type: 'create', bucket: { name: ' ', description: '' } })).toThrow(
      /needs a name/,
    );
    expect(() =>
      store.changeBucket({ type: 'create', bucket: { name: 'receipts', description: '' } }),
    ).toThrow(/already/);
  });

  it('removing one makes its emails Unsorted and deletes its Rules; Undo brings all of it back', () => {
    save([stripe('r1'), stripe('r2'), email('d1')]);
    moveThread('r1', 'receipts');
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'gmail.domain', 'stripe.com') });
    store.resort([itemOf('r2').id]);
    expect(bucketOf('r2')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });

    const removed = store.changeBucket({ type: 'delete', bucketId: 'receipts' });
    expect(removed.bucket).toBeNull();
    expect(removed.unsorted).toHaveLength(2);
    expect(removed.rules).toHaveLength(1);
    expect(names()).not.toContain('Receipts');
    expect(bucketOf('r1')).toBeNull();
    expect(bucketOf('r2')).toBeNull();
    expect(store.rules()).toEqual([]);

    store.changeBucket({
      type: 'restore',
      bucketId: 'receipts',
      unsorted: removed.unsorted,
      rules: removed.rules,
    });
    expect(names()[4]).toBe('Receipts');
    expect(bucketOf('r1')).toEqual({ bucketId: 'receipts', sortedBy: 'user' });
    expect(bucketOf('r2')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(store.rules()).toHaveLength(1);
  });
});

describe('an email’s Bucket', () => {
  it('arrives Unsorted when no Rule matches', () => {
    save([email('d1')]);
    expect(bucketOf('d1')).toBeNull();
    expect(store.emailThreads({ bucket: UNSORTED }).threads.map((thread) => thread.subject)).toEqual([
      'Subject d1',
    ]);
  });

  it('moves with its thread, by the User, as one undoable change', () => {
    const first = email('d1', { sentAt: T - 2 * HOUR });
    const second = email('d2', {
      inReplyTo: '<d1@mail.test>',
      references: ['<d1@mail.test>'],
      sourceThreadId: 'g-d1',
      subject: 'Re: Subject d1',
    });
    save([first, second]);
    const entries = moveThread('d2', NEEDS_REPLY);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.by.kind === 'user')).toBe(true);
    expect(bucketOf('d1')).toEqual({ bucketId: NEEDS_REPLY, sortedBy: 'user' });
    expect(bucketOf('d2')).toEqual({ bucketId: NEEDS_REPLY, sortedBy: 'user' });
    // Commander's own: nothing goes to Gmail.
    expect(store.outgoing.list()).toEqual([]);

    store.recordAll(
      entries.reverse().map((entry): ItemAction => ({ type: 'undo', entryId: entry.id })),
      user,
    );
    expect(bucketOf('d1')).toBeNull();
    expect(bucketOf('d2')).toBeNull();
  });

  it('is recorded by whoever sorted it, whatever the change says', () => {
    save([email('d1')]);
    store.record(
      {
        type: 'edit-fields',
        itemId: itemOf('d1').id,
        fields: { bucket: { bucketId: 'fyi', sortedBy: 'user' } },
      },
      { by: { kind: 'ares' } },
    );
    expect(bucketOf('d1')).toEqual({ bucketId: 'fyi', sortedBy: 'ares' });
  });

  it('Ares never moves an email the User or a Rule sorted', () => {
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'gmail.domain', 'stripe.com') });
    save([stripe('r1'), email('d1')]);
    moveThread('d1', 'fyi');
    const ares = { by: { kind: 'ares' as const } };
    const sort = (externalId: string) =>
      store.record(
        {
          type: 'edit-fields',
          itemId: itemOf(externalId).id,
          fields: { bucket: { bucketId: 'junk', sortedBy: 'ares' } },
        },
        ares,
      );
    expect(() => sort('r1')).toThrow(/Rule/);
    expect(() => sort('d1')).toThrow(/by hand/);
    expect(bucketOf('r1')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(bucketOf('d1')).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
  });

  it('must be a Bucket the User has', () => {
    save([email('d1')]);
    expect(() =>
      store.record(
        {
          type: 'edit-fields',
          itemId: itemOf('d1').id,
          fields: { bucket: { bucketId: 'nope', sortedBy: 'user' } },
        },
        user,
      ),
    ).toThrow(/No Bucket/);
  });

  it('is independent of its Project, and both survive a sync', () => {
    const tx = store.changeProject({
      type: 'create',
      project: { name: 'Tactics', code: 'TX', accent: 'blue' },
    }).project as Project;
    save([email('d1')]);
    store.record(
      { type: 'update', itemId: itemOf('d1').id, changes: { filing: { projectId: tx.id, filedBy: 'user' } } },
      user,
    );
    moveThread('d1', NEEDS_REPLY);
    save([email('d1', { read: true, labels: [{ id: 'INBOX', name: 'Inbox' }] })]);
    expect(itemOf('d1').filing).toEqual({ projectId: tx.id, filedBy: 'user' });
    expect(bucketOf('d1')).toEqual({ bucketId: NEEDS_REPLY, sortedBy: 'user' });
    expect((itemOf('d1').detail as EmailDetail).read).toBe(true);
  });
});

describe('Bucket Rules', () => {
  it('sort arriving mail, naming the Rule; Gmail and Outlook alike', () => {
    const { rule } = store.changeRule({
      type: 'create',
      rule: bucketRule('receipts', 'gmail.domain', 'stripe.com'),
    });
    save([stripe('r1')]);
    save([stripe('o1')], OUTLOOK, 'outlook');
    expect(bucketOf('r1')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(bucketOf('o1')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    const [sorted] = store.activity({ itemId: itemOf('r1').id, limit: 1 });
    expect(sorted?.by).toEqual({ kind: 'rule', ruleId: rule?.id });
    expect(sorted?.why).toBe('Rule: from domain is stripe.com');
  });

  it('never touch mail the User sorted by hand, even when it changes at the Source', () => {
    save([stripe('r1')]);
    moveThread('r1', 'fyi');
    const change = store.changeRule({
      type: 'create',
      rule: bucketRule('receipts', 'gmail.domain', 'stripe.com'),
    });
    expect(change.resort).toEqual([]);
    save([stripe('r1', { read: true })]);
    expect(bucketOf('r1')).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
  });

  it('share the one list with Project Rules: the first match per kind of target wins', () => {
    const tx = store.changeProject({
      type: 'create',
      project: { name: 'Tactics', code: 'TX', accent: 'blue' },
    }).project as Project;
    store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tx.id },
        when: {
          join: 'and',
          terms: [{ field: 'gmail.domain', op: 'is', value: 'stripe.com', label: 'stripe.com' }],
        },
      },
    });
    store.changeRule({
      type: 'create',
      rule: bucketRule('receipts', 'gmail.subject', 'receipt', 'contains'),
    });
    store.changeRule({ type: 'create', rule: bucketRule('junk', 'gmail.domain', 'stripe.com') });
    save([stripe('r1'), stripe('r2', { subject: 'Your payout' })]);
    expect(itemOf('r1').filing).toEqual({ projectId: tx.id, filedBy: 'rule' });
    expect(bucketOf('r1')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(bucketOf('r2')).toEqual({ bucketId: 'junk', sortedBy: 'rule' });
    expect(store.rules().map((rule) => rule.target.kind)).toEqual(['project', 'bucket', 'bucket']);
  });

  it('need a Bucket the User has, and email fields', () => {
    expect(() =>
      store.changeRule({ type: 'create', rule: bucketRule('nope', 'gmail.domain', 'stripe.com') }),
    ).toThrow(/No Bucket/);
    expect(() =>
      store.changeRule({ type: 'create', rule: bucketRule('receipts', 'linear.team', 'team-eng') }),
    ).toThrow(/email/);
  });

  it('offer to re-sort held mail with an accurate preview; one undo reverts it', () => {
    save([stripe('r1'), stripe('r2'), stripe('r3'), email('d1')]);
    moveThread('r3', 'fyi');
    // A preview counts only email.
    expect(store.previewRule({ rule: bucketRule('receipts', 'gmail.domain', 'stripe.com') }).count).toBe(3);

    const change = store.changeRule({
      type: 'create',
      rule: bucketRule('receipts', 'gmail.domain', 'stripe.com'),
    });
    expect(change.refile).toEqual([]);
    expect(change.resort.map((each) => each.item.title).sort()).toEqual(['Receipt r1', 'Receipt r2']);
    expect(change.resort[0]).toMatchObject({
      from: null,
      to: { bucketId: 'receipts', sortedBy: 'rule' },
      ruleId: change.rule?.id,
    });
    // Nothing moves until the User says so.
    expect(bucketOf('r1')).toBeNull();

    const entries = store.resort(change.resort.map((each) => each.item.id));
    expect(entries).toHaveLength(2);
    expect(bucketOf('r1')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(bucketOf('r3')).toEqual({ bucketId: 'fyi', sortedBy: 'user' });

    const undone = store.undoResort(entries.map((entry) => entry.id));
    expect(undone).toHaveLength(2);
    expect(bucketOf('r1')).toBeNull();
    expect(bucketOf('r2')).toBeNull();
  });

  it('a Project Rule on an email field files mail too', () => {
    const tx = store.changeProject({ type: 'create', project: { name: 'Acme', code: 'AC', accent: 'blue' } })
      .project as Project;
    save([email('a1', { from: { name: 'Jo', address: 'jo@acme.test' } })]);
    const change = store.changeRule({
      type: 'create',
      rule: {
        target: { kind: 'project', projectId: tx.id },
        when: {
          join: 'and',
          terms: [{ field: 'gmail.domain', op: 'is', value: 'acme.test', label: 'acme.test' }],
        },
      },
    });
    expect(change.refile.map((each) => each.item.title)).toEqual(['Subject a1']);
    expect(change.resort).toEqual([]);
  });
});

describe('the Email Section’s Buckets', () => {
  it('filters threads by Bucket and counts them by Bucket and Project, unread too', () => {
    const tx = store.changeProject({
      type: 'create',
      project: { name: 'Tactics', code: 'TX', accent: 'blue' },
    }).project as Project;
    save([
      stripe('r1'),
      stripe('r2', { read: true, labels: [{ id: 'INBOX', name: 'Inbox' }] }),
      email('d1'),
      email('d2'),
    ]);
    moveThread('r1', 'receipts');
    moveThread('r2', 'receipts');
    moveThread('d1', NEEDS_REPLY);
    store.record(
      { type: 'update', itemId: itemOf('d1').id, changes: { filing: { projectId: tx.id, filedBy: 'user' } } },
      user,
    );

    const receipts = store.emailThreads({ bucket: 'receipts' });
    expect(receipts.threads.map((thread) => thread.subject).sort()).toEqual(['Receipt r1', 'Receipt r2']);
    expect(receipts.threads[0]?.bucket?.bucketId).toBe('receipts');
    expect(receipts.unreadThreads).toBe(1);
    expect(store.emailThreads({ bucket: NEEDS_REPLY }).threads.map((thread) => thread.subject)).toEqual([
      'Subject d1',
    ]);

    const facets = receipts.facets ?? [];
    const sorted = [...facets].sort((a, b) => String(a.bucketId).localeCompare(String(b.bucketId)));
    expect(sorted).toEqual([
      { bucketId: NEEDS_REPLY, projectId: tx.id, threads: 1, unread: 1 },
      { bucketId: null, projectId: null, threads: 1, unread: 1 },
      { bucketId: 'receipts', projectId: null, threads: 2, unread: 1 },
    ]);

    // Combined with a view: archiving one receipt takes it out of the Inbox's counts.
    moveThread('r2', 'receipts');
    const archive = threadActionFields(
      { type: 'archive' },
      (threadOf('r2')?.messages ?? []).map(({ item }) => ({
        id: item.id,
        detail: item.detail as EmailDetail,
      })),
    );
    store.recordAll(
      archive.map(({ itemId, fields }): ItemAction => ({ type: 'edit-fields', itemId, fields })),
      user,
    );
    expect(store.emailThreads({ bucket: 'receipts' }).threads).toHaveLength(1);
    expect(store.emailThreads({ bucket: 'receipts', view: 'archive' }).threads).toHaveLength(1);
  });
});

// The User's reply (#137): their own message becomes the thread's latest, and a thread's Bucket is its
// latest message's, so the reply takes the thread's Bucket as it stands, sorter and all.
describe('A thread keeps its Bucket after the User replies', () => {
  const ALEX_ADDRESS = { name: 'Alex Kim', address: 'alex@gmail.test' };
  const DANA = { name: 'Dana Whitfield', address: 'dana@northwind.test' };
  const composer: ComposeContext = { by: { kind: 'user' }, source: 'gmail', from: ALEX_ADDRESS };

  // A reply sent from Commander's composer.
  const replyFromCommander = (externalId: string) =>
    store.compose.send(
      {
        mode: 'reply',
        account: ALEX,
        replyToItemId: itemOf(externalId).id,
        to: [DANA],
        cc: [],
        bcc: [],
        subject: `Re: Subject ${externalId}`,
        body: [{ type: 'paragraph', runs: [{ text: 'Thursday works.' }] }],
        attachments: [],
      },
      composer,
      clock,
    ).itemId;

  // A reply the User sent in Gmail, as its sync brings it.
  const sentInGmail = (id: string, to: string, fields: Partial<EmailDetail> = {}) =>
    email(id, {
      from: ALEX_ADDRESS,
      to: [DANA],
      sentByMe: true,
      inReplyTo: `<${to}@mail.test>`,
      references: [`<${to}@mail.test>`],
      sourceThreadId: `g-${to}`,
      subject: `Re: Subject ${to}`,
      sentAt: clock,
      read: true,
      inInbox: false,
      labels: [{ id: 'SENT', name: 'Sent' }],
      ...fields,
    });

  const summaryOf = (externalId: string) =>
    store.emailThreads().threads.find((thread) => thread.itemIds.includes(itemOf(externalId).id));
  const detailOfId = (itemId: string) => store.get(itemId)?.item.detail as EmailDetail | undefined;
  const bucketOfId = (itemId: string) => detailOfId(itemId)?.bucket ?? null;

  it('a reply sent from the composer keeps the Bucket the User sorted the thread into', () => {
    save([email('d1')]);
    moveThread('d1', 'fyi');
    clock += HOUR;
    const sent = replyFromCommander('d1');

    expect(bucketOfId(sent)).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
    const thread = summaryOf('d1');
    expect(thread?.latest.id).toBe(sent);
    expect(thread?.bucket).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
    expect(store.emailThreads({ bucket: 'fyi' }).threads.map((each) => each.latest.id)).toEqual([sent]);
    expect(store.emailThreads({ bucket: UNSORTED }).threads).toEqual([]);

    // Its sync (the Source's copy of the sent message) leaves it there.
    const synced = sentInGmail('s1', 'd1', {
      messageId: detailOfId(sent)?.messageId ?? null,
    });
    store.saveFromSource({
      source: 'gmail',
      account: ALEX,
      items: [{ ...synced, commanderItemId: sent }],
      deleted: [],
    });
    expect(bucketOfId(sent)).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
  });

  it('keeps a Rule’s or Ares’s sort as theirs, so the precedence still holds', () => {
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'gmail.domain', 'stripe.com') });
    save([stripe('r1'), email('d1')]);
    store.record(
      {
        type: 'edit-fields',
        itemId: itemOf('d1').id,
        fields: { bucket: { bucketId: 'fyi', sortedBy: 'ares' } },
      },
      { by: { kind: 'ares' } },
    );
    clock += HOUR;
    const toStripe = replyFromCommander('r1');
    const toDana = replyFromCommander('d1');

    expect(bucketOfId(toStripe)).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(bucketOfId(toDana)).toEqual({ bucketId: 'fyi', sortedBy: 'ares' });
    expect(summaryOf('r1')?.bucket).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(summaryOf('d1')?.bucket).toEqual({ bucketId: 'fyi', sortedBy: 'ares' });
  });

  it('a reply synced in as sent by the User keeps the thread’s Bucket too', () => {
    store.changeRule({ type: 'create', rule: bucketRule('receipts', 'gmail.domain', 'stripe.com') });
    save([stripe('r1')]);
    clock += HOUR;
    save([sentInGmail('s1', 'r1')]);

    expect(bucketOf('s1')).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    expect(summaryOf('r1')?.latest.externalId).toBe('s1');
    expect(store.emailThreads({ bucket: 'receipts' }).threads).toHaveLength(1);
  });

  it('an Unsorted thread stays Unsorted, and one the User took out of its Bucket stays out', () => {
    save([email('d1'), email('d2')]);
    moveThread('d2', 'fyi');
    moveThread('d2', null);
    clock += HOUR;
    save([sentInGmail('s1', 'd1')]);
    const sent = replyFromCommander('d2');

    expect(bucketOf('s1')).toBeNull();
    expect(bucketOfId(sent)).toEqual({ bucketId: null, sortedBy: 'user' });
    expect(store.emailThreads({ bucket: UNSORTED }).threads).toHaveLength(2);
  });

  it('a new message of the User’s own, in no thread, has no Bucket', () => {
    save([email('d1')]);
    moveThread('d1', 'fyi');
    save([email('s1', { from: ALEX_ADDRESS, to: [DANA], sentByMe: true, inInbox: false, labels: [] })]);
    expect(bucketOf('s1')).toBeNull();
  });

  it('moving the thread after a reply moves it all, and Undo brings it back', () => {
    save([email('d1')]);
    moveThread('d1', 'fyi');
    clock += HOUR;
    const sent = replyFromCommander('d1');

    const moved = moveThread('d1', 'receipts');
    expect(bucketOf('d1')).toEqual({ bucketId: 'receipts', sortedBy: 'user' });
    expect(bucketOfId(sent)).toEqual({ bucketId: 'receipts', sortedBy: 'user' });
    expect(summaryOf('d1')?.bucket).toEqual({ bucketId: 'receipts', sortedBy: 'user' });

    store.recordAll(
      [...moved].reverse().map((entry): ItemAction => ({ type: 'undo', entryId: entry.id })),
      user,
    );
    expect(bucketOfId(sent)).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
    expect(summaryOf('d1')?.bucket).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
  });

  it('replying never archives the thread, even in a Bucket that skips the inbox', () => {
    save([email('d1')]);
    moveThread('d1', 'fyi');
    store.changeBucket({ type: 'update', bucketId: 'fyi', bucket: { skipInbox: true } });
    clock += HOUR;
    const sent = replyFromCommander('d1');
    // Sent to herself too: the copy that lands in the inbox stays there.
    save([sentInGmail('s1', 'd1', { inInbox: true, labels: [{ id: 'INBOX', name: 'Inbox' }] })]);

    expect(bucketOfId(sent)).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
    expect(bucketOf('s1')).toEqual({ bucketId: 'fyi', sortedBy: 'user' });
    expect((itemOf('d1').detail as EmailDetail).inInbox).toBe(true);
    expect((itemOf('s1').detail as EmailDetail).inInbox).toBe(true);
    expect(store.emailThreads({ view: 'inbox', bucket: 'fyi' }).threads).toHaveLength(1);
  });

  it('Ares learns nothing from the User’s own reply when they move a thread he sorted', () => {
    save([email('d1')]);
    store.record(
      {
        type: 'edit-fields',
        itemId: itemOf('d1').id,
        fields: { bucket: { bucketId: 'fyi', sortedBy: 'ares' } },
      },
      { by: { kind: 'ares' } },
    );
    clock += HOUR;
    save([sentInGmail('s1', 'd1')]);
    expect(bucketOf('s1')).toEqual({ bucketId: 'fyi', sortedBy: 'ares' });

    moveThread('d1', 'receipts');
    expect(
      store.emailSorting
        .feedback()
        .map(({ itemId, kind, suggested, chosen }) => ({ itemId, kind, suggested, chosen })),
    ).toEqual([{ itemId: itemOf('d1').id, kind: 'correction', suggested: 'fyi', chosen: 'receipts' }]);
  });
});
