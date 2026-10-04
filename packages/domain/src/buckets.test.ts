import { describe, expect, it } from 'vitest';
import {
  BUCKET_FIELD,
  bucketAction,
  NEEDS_REPLY,
  STARTER_BUCKETS,
  threadBucketOf,
  UNSORTED,
  WAITING_ON_OTHERS,
} from './buckets';
import type { EmailDetail } from './email';
import { threadActionFields } from './email-actions';
import { emailThreadQuery } from './email-threads';
import { syncedFieldsOf, withSyncedFields } from './synced-fields';

// Buckets (#137): what to do with an email. The starter set ships with descriptions written for Ares
// to sort by (#31: sharpened descriptions lifted his accuracy from 50% to 81%), and every email sits in
// exactly one Bucket or is Unsorted.

function detail(id: string, fields: Partial<EmailDetail> = {}): EmailDetail {
  return {
    kind: 'email',
    messageId: `<${id}@mail.test>`,
    inReplyTo: null,
    references: [],
    threadKey: 'mid:<1@mail.test>',
    sourceThreadId: null,
    from: { name: 'Dana Whitfield', address: 'dana@northwind.test' },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Q4 offsite',
    sentAt: 1000,
    snippet: '',
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
}

describe('the starter Buckets', () => {
  it('are the seven, in order, with the sharpened descriptions', () => {
    expect(STARTER_BUCKETS.map((bucket) => bucket.name)).toEqual([
      'Needs reply',
      'Waiting on others',
      'FYI',
      'Newsletters',
      'Receipts',
      'Calendar',
      'Junk',
    ]);
    expect(STARTER_BUCKETS[0]).toEqual({
      id: NEEDS_REPLY,
      name: 'Needs reply',
      description: 'A real person is waiting for my reply or decision. Automated emails never need a reply.',
    });
    expect(STARTER_BUCKETS[1]?.id).toBe(WAITING_ON_OTHERS);
    expect(STARTER_BUCKETS.at(-1)?.description).toBe(
      'Not useful in any way: unsolicited promotions, cold outreach, spam that got through, things I’d delete unread.',
    );
  });

  it('refuses a Bucket without a name', () => {
    expect(bucketAction.safeParse({ type: 'create', bucket: { name: '  ', description: '' } }).success).toBe(
      false,
    );
  });
});

describe('an email’s Bucket', () => {
  it('is a field of its own, kept beside the synced ones', () => {
    const sorted = detail('1', { bucket: { bucketId: 'receipts', sortedBy: 'rule' } });
    expect(syncedFieldsOf(sorted)?.[BUCKET_FIELD]).toEqual({ bucketId: 'receipts', sortedBy: 'rule' });
    const moved = withSyncedFields(sorted, {
      ...syncedFieldsOf(sorted),
      [BUCKET_FIELD]: { bucketId: NEEDS_REPLY, sortedBy: 'user' },
    });
    expect(moved.bucket).toEqual({ bucketId: NEEDS_REPLY, sortedBy: 'user' });
    const unsorted = withSyncedFields(sorted, { ...syncedFieldsOf(sorted), [BUCKET_FIELD]: null });
    expect(unsorted.bucket).toBeUndefined();
  });

  it('of a thread is its latest message’s; none is Unsorted', () => {
    expect(
      threadBucketOf([
        detail('1', { sentAt: 1, bucket: { bucketId: 'receipts', sortedBy: 'rule' } }),
        detail('2', { sentAt: 2, bucket: { bucketId: NEEDS_REPLY, sortedBy: 'user' } }),
      ]),
    ).toBe(NEEDS_REPLY);
    expect(
      threadBucketOf([
        detail('1', { bucket: { bucketId: 'receipts', sortedBy: 'rule' } }),
        detail('2', { sentAt: 2000 }),
      ]),
    ).toBeNull();
    // Moved to Unsorted by hand: still Unsorted.
    expect(threadBucketOf([detail('1', { bucket: { bucketId: null, sortedBy: 'user' } })])).toBeNull();
    expect(threadBucketOf([])).toBeNull();
  });

  it('moves with the whole thread, by the User, leaving out messages already there', () => {
    const messages = [
      { id: 'a', detail: detail('1', { sentAt: 1, bucket: { bucketId: 'receipts', sortedBy: 'user' } }) },
      { id: 'b', detail: detail('2', { sentAt: 2 }) },
    ];
    expect(threadActionFields({ type: 'bucket', bucketId: 'receipts' }, messages)).toEqual([
      { itemId: 'b', fields: { [BUCKET_FIELD]: { bucketId: 'receipts', sortedBy: 'user' } } },
    ]);
    expect(threadActionFields({ type: 'bucket', bucketId: null }, messages)).toEqual([
      { itemId: 'a', fields: { [BUCKET_FIELD]: { bucketId: null, sortedBy: 'user' } } },
      { itemId: 'b', fields: { [BUCKET_FIELD]: { bucketId: null, sortedBy: 'user' } } },
    ]);
  });

  it('can be asked of the thread list, or Unsorted', () => {
    expect(emailThreadQuery.parse({ bucket: UNSORTED }).bucket).toBe(UNSORTED);
    expect(emailThreadQuery.parse({ bucket: 'receipts' }).bucket).toBe('receipts');
  });
});
