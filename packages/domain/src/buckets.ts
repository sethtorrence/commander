import { z } from 'zod';
import type { EmailDetail } from './email';

/*
  Buckets (#137, decision #16): what to do with an email. The User defines them, from an editable
  starter set, each with a plain description; every email sits in exactly one Bucket or is Unsorted,
  independent of its Project ("Needs reply · TX" is normal). Buckets are views over email, never
  folders: nothing about them reaches Gmail or Outlook unless mirroring is switched on (#142, off by
  default).

  The descriptions are what Ares sorts by (#141), so they are written sharply: #31 found the
  sharpened Needs reply ("…automated emails never need a reply") lifted his accuracy from 50% to 81%.
  Bucket Rules ("mail from stripe.com → Receipts") sort email before he does, and the User's own
  sorting beats both.
*/

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// The starter Buckets keep these ids for good, whatever the User renames them: the Dashboard's band
// rules and the Email tab's count look for Needs reply and Waiting on others by id.
export const NEEDS_REPLY = 'needs-reply';
export const WAITING_ON_OTHERS = 'waiting-on-others';

/** The starter set, in order, as a fresh install has it. */
export const STARTER_BUCKETS: readonly { id: string; name: string; description: string }[] = [
  {
    id: NEEDS_REPLY,
    name: 'Needs reply',
    description: 'A real person is waiting for my reply or decision. Automated emails never need a reply.',
  },
  {
    id: WAITING_ON_OTHERS,
    name: 'Waiting on others',
    description: 'I asked someone for something or sent them something, and I’m waiting for their answer.',
  },
  { id: 'fyi', name: 'FYI', description: 'Worth knowing, with nothing for me to do.' },
  {
    id: 'newsletters',
    name: 'Newsletters',
    description: 'Newsletters, digests, product updates and marketing I signed up for.',
  },
  {
    id: 'receipts',
    name: 'Receipts',
    description: 'Receipts, invoices, orders, shipping updates, bills and statements.',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    description: 'Meeting invitations, changes, cancellations and scheduling replies.',
  },
  {
    id: 'junk',
    name: 'Junk',
    description:
      'Not useful in any way: unsolicited promotions, cold outreach, spam that got through, things I’d delete unread.',
  },
];

// The example the Settings editor gives: Ares sorts by the description, so say it plainly.
export const BUCKET_DESCRIPTION_EXAMPLE = STARTER_BUCKETS[0] as (typeof STARTER_BUCKETS)[number];

export const BUCKET_NAME_MAX = 40;
export const BUCKET_DESCRIPTION_MAX = 500;

export const bucket = z.object({
  id,
  name: z.string().trim().min(1).max(BUCKET_NAME_MAX),
  description: z.string().trim().max(BUCKET_DESCRIPTION_MAX),
  // Its place in the User's order: 0 is the top.
  order: z.number().int().nonnegative(),
  createdAt: timestamp,
});
export type Bucket = z.infer<typeof bucket>;

const bucketDraft = z.object({
  name: z.string().trim().min(1, 'A Bucket needs a name').max(BUCKET_NAME_MAX, 'That name is too long'),
  description: z.string().trim().max(BUCKET_DESCRIPTION_MAX, 'That description is too long'),
});
export type BucketDraft = z.input<typeof bucketDraft>;

const position = z.number().int().nonnegative();
const entryIds = z.array(z.number().int().positive()).max(100_000);

export const bucketAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), bucket: bucketDraft, position: position.optional() }),
  z.object({ type: z.literal('update'), bucketId: id, bucket: bucketDraft.partial() }),
  z.object({ type: z.literal('move'), bucketId: id, position }),
  // Removing a Bucket makes its emails Unsorted and deletes the Rules sorting into it.
  z.object({ type: z.literal('delete'), bucketId: id }),
  // Undoes a delete: the Bucket at the place it had, its emails back (those not moved since), and its
  // Rules — as the delete's answer named them.
  z.object({
    type: z.literal('restore'),
    bucketId: id,
    unsorted: entryIds.default([]),
    rules: z.array(id).default([]),
  }),
]);
export type BucketAction = z.input<typeof bucketAction>;

// What a change did: the Bucket as it is now (null once deleted) and, for a delete, the activity
// entries that made its emails Unsorted and the Rules it took with it, for its Undo.
export const bucketChange = z.object({
  bucket: bucket.nullable(),
  unsorted: z.array(z.number().int().positive()),
  rules: z.array(id),
});
export type BucketChange = z.infer<typeof bucketChange>;

// ---------------------------------------------------------------------------------------------
// An email's Bucket

// How an email came to be in its Bucket, recorded like filing: by a Rule, by Ares, or by the User.
// The User's own sorting is never touched by Rules or Ares.
export const bucketSortedBy = z.enum(['rule', 'ares', 'user']);
export type BucketSortedBy = z.infer<typeof bucketSortedBy>;

// An email's Bucket, kept in its detail. `bucketId` null: Unsorted, by the User's choice. No Bucket
// at all (absent or null): Unsorted, until a Rule or Ares sorts it.
export const emailBucket = z.object({ bucketId: id.nullable(), sortedBy: bucketSortedBy });
export type EmailBucket = z.infer<typeof emailBucket>;

// The field an email's Bucket is edited through (edit-fields), like its synced fields: logged and
// undone field by field, kept through syncs, never queued for the Source (synced-fields.ts).
export const BUCKET_FIELD = 'bucket';

// The thread list's Bucket filter: a Bucket's id, or Unsorted.
export const UNSORTED = 'unsorted';

/** A thread's Bucket: its latest message's (null: Unsorted). */
export function threadBucketOf(details: readonly Pick<EmailDetail, 'sentAt' | 'bucket'>[]): string | null {
  let latest: Pick<EmailDetail, 'sentAt' | 'bucket'> | undefined;
  for (const detail of details) if (!latest || detail.sentAt >= latest.sentAt) latest = detail;
  return latest?.bucket?.bucketId ?? null;
}

/** Whether a thread with this Bucket shows under a Bucket filter (a Bucket's id or Unsorted). */
export const inBucket = (bucketId: string | null, filter: string) =>
  filter === UNSORTED ? bucketId === null : bucketId === filter;
