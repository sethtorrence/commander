import { describe, expect, it } from 'vitest';
import {
  BUCKET_MIRROR_FIELD,
  isMirrorLabel,
  MIRROR_COLOURS,
  mirrorColourOf,
  mirroredBucketNames,
  mirrorLabelName,
  suggestsSkippingTheInbox,
} from './bucket-mirror';
import { STARTER_BUCKETS } from './buckets';
import type { EmailDetail } from './email';
import { isLocalField, isPickableLabel, isSyncedField, syncedFieldsOf, withSyncedFields } from './index';

const base: EmailDetail = {
  kind: 'email',
  messageId: '<m1@mail.test>',
  inReplyTo: null,
  references: [],
  threadKey: 'mid:<m1@mail.test>',
  sourceThreadId: 'g1',
  from: { name: 'Dana', address: 'dana@northwind.test' },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Weekly digest',
  sentAt: 1,
  snippet: '',
  read: true,
  starred: false,
  inInbox: true,
  sentByMe: false,
  labels: [
    { id: 'INBOX', name: 'Inbox' },
    { id: 'Label_1', name: 'Receipts' },
  ],
  attachments: [],
  hasInvitation: false,
  listUnsubscribe: null,
  listId: null,
};

const gmail = (labels: { id: string; name: string }[]): EmailDetail => ({
  ...base,
  labels: [...base.labels, ...labels],
});
const outlook = (categories: string[]): EmailDetail => ({
  ...base,
  labels: [],
  folder: { id: 'AAMk-inbox', name: 'Inbox', wellKnown: 'inbox' },
  categories,
});

describe('a Bucket’s mirror in Gmail and Outlook (#142)', () => {
  it('is a Commander/<Bucket> label in Gmail and a “Commander: <Bucket>” category in Outlook', () => {
    expect(mirrorLabelName('gmail', 'Needs reply')).toBe('Commander/Needs reply');
    expect(mirrorLabelName('outlook', 'Needs reply')).toBe('Commander: Needs reply');
    expect(isMirrorLabel({ id: 'Label_9', name: 'Commander/FYI' })).toBe(true);
    expect(isMirrorLabel({ id: 'Label_1', name: 'Receipts' })).toBe(false);
    // The User's own label that merely starts with the word isn't one.
    expect(isMirrorLabel({ id: 'Label_3', name: 'Commanders' })).toBe(false);
  });

  it('colours categories from Outlook’s 25 preset colours, wrapping after the 25th', () => {
    expect(MIRROR_COLOURS).toBe(25);
    expect(mirrorColourOf(0)).toBe('preset0');
    expect(mirrorColourOf(24)).toBe('preset24');
    expect(mirrorColourOf(25)).toBe('preset0');
    expect(mirrorColourOf(27)).toBe('preset2');
  });

  it('reads which Buckets a message shows at its Source: none, one, or several (to be put right)', () => {
    expect(mirroredBucketNames(base)).toBeNull();
    expect(mirroredBucketNames(gmail([{ id: 'Label_9', name: 'Commander/FYI' }]))).toBe('FYI');
    expect(
      mirroredBucketNames(
        gmail([
          { id: 'Label_9', name: 'Commander/Newsletters' },
          { id: 'Label_8', name: 'Commander/FYI' },
        ]),
      ),
    ).toEqual(['FYI', 'Newsletters']);
    expect(mirroredBucketNames(outlook(['Blue category', 'Commander: Receipts']))).toBe('Receipts');
    expect(mirroredBucketNames(outlook(['Blue category']))).toBeNull();
  });

  it('suggests skipping the inbox for Newsletters, Receipts and Junk', () => {
    const suggested = STARTER_BUCKETS.filter((bucket) => suggestsSkippingTheInbox(bucket.id)).map(
      (bucket) => bucket.name,
    );
    expect(suggested).toEqual(['Newsletters', 'Receipts', 'Junk']);
  });
});

describe('the bucket-mirror synced field', () => {
  it('is the Bucket a Gmail message shows, and its labels are no label:<id> fields', () => {
    const mail = gmail([{ id: 'Label_9', name: 'Commander/FYI' }]);
    const fields = syncedFieldsOf(mail) ?? {};
    expect(fields[BUCKET_MIRROR_FIELD]).toBe('FYI');
    expect(Object.keys(fields)).not.toContain('label:Label_9');
    expect(isSyncedField('email', BUCKET_MIRROR_FIELD)).toBe(true);
    // It writes back to the Source (only ever while mirroring is on: the Item store sees to that).
    expect(isLocalField('email', BUCKET_MIRROR_FIELD)).toBe(false);
  });

  it('is absent while a message shows no Bucket at its Source', () => {
    expect(Object.keys(syncedFieldsOf(base) ?? {})).not.toContain(BUCKET_MIRROR_FIELD);
  });

  it('puts exactly one Commander label on a Gmail message, keeping the User’s own labels', () => {
    const mail = gmail([
      { id: 'Label_9', name: 'Commander/Newsletters' },
      { id: 'Label_8', name: 'Commander/FYI' },
    ]);
    const one = withSyncedFields(mail, { ...syncedFieldsOf(mail), [BUCKET_MIRROR_FIELD]: 'FYI' });
    expect(one.labels).toEqual([
      { id: 'INBOX', name: 'Inbox' },
      { id: 'Label_1', name: 'Receipts' },
      { id: 'Label_8', name: 'Commander/FYI' },
    ]);
    const none = withSyncedFields(mail, { ...syncedFieldsOf(mail), [BUCKET_MIRROR_FIELD]: null });
    expect(none.labels.map((label) => label.name)).toEqual(['Inbox', 'Receipts']);
  });

  it('stands in a label Gmail hasn’t made yet by its name, until Gmail answers with its id', () => {
    const shown = withSyncedFields(base, { ...syncedFieldsOf(base), [BUCKET_MIRROR_FIELD]: 'Receipts' });
    expect(shown.labels.at(-1)).toEqual({ id: 'Commander/Receipts', name: 'Commander/Receipts' });
    expect(mirroredBucketNames(shown)).toBe('Receipts');
  });

  it('puts exactly one Commander category on an Outlook message beside the User’s own', () => {
    const mail = outlook(['Blue category', 'Commander: Newsletters', 'Commander: FYI']);
    const fields = syncedFieldsOf(mail) ?? {};
    expect(fields[BUCKET_MIRROR_FIELD]).toEqual(['FYI', 'Newsletters']);
    const one = withSyncedFields(mail, { ...fields, [BUCKET_MIRROR_FIELD]: 'Receipts' });
    expect(one.categories).toEqual(['Blue category', 'Commander: Receipts']);
    const none = withSyncedFields(mail, { ...fields, [BUCKET_MIRROR_FIELD]: null });
    expect(none.categories).toEqual(['Blue category']);
  });

  it('never offers a Commander label in the label picker', () => {
    expect(isPickableLabel('Label_9', 'Commander/FYI')).toBe(false);
    expect(isPickableLabel('Commander/FYI')).toBe(false);
    expect(isPickableLabel('Label_1', 'Receipts')).toBe(true);
  });
});
