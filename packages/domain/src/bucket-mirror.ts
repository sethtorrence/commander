import { z } from 'zod';
import type { EmailDetail, EmailLabel } from './email';

/*
  Buckets in Gmail and Outlook (#142, decision #16). Buckets are Commander's own, and stay so unless
  the User asks otherwise, in two ways, both off by default:

  - **Skip the inbox**, per Bucket (Settings → Buckets): mail landing in it is archived at its Source.
    Sorted there by the User, at once, as their own action; by a Rule or Ares, proposed as Tidy your
    Sources / "Skip the inbox" (Ask by default), archived at once only at Auto.
  - **Mirror Buckets**, per Account (Settings → Accounts): each email's Bucket shows at its Source as
    a `Commander/<Bucket>` label (Gmail) or a "Commander: <Bucket>" category (Outlook), exactly one per
    email, through the `bucket-mirror` synced field. While it is on, a Commander label or category
    changed in Gmail or Outlook moves the email's Bucket, as the User's correction. Switching it on
    sets Tidy your Sources / "Mirror Buckets" to Auto in the Autonomy grid; switching it off stops all
    writing and offers to remove Commander's labels or categories.

  Without mirroring nothing about Buckets is ever written to Gmail or Outlook: the Item store queues
  the `bucket-mirror` field only for an Account that mirrors.
*/

// The synced field: the Bucket name an email shows at its Source (null: none; several names, sorted,
// when the User gave it more than one in Gmail or Outlook, for Commander to put right).
export const BUCKET_MIRROR_FIELD = 'bucket-mirror';
export type MirroredBuckets = string | string[] | null;

// The registered actions (Tidy your Sources).
export const MIRROR_BUCKETS = 'mirror-buckets';
export const SKIP_THE_INBOX = 'skip-the-inbox';

export const GMAIL_MIRROR_PREFIX = 'Commander/';
export const OUTLOOK_MIRROR_PREFIX = 'Commander: ';

export type MirrorSource = 'gmail' | 'outlook';
export const mirrorSource = z.enum(['gmail', 'outlook']);

/** The label (Gmail) or category (Outlook) that shows a Bucket. */
export const mirrorLabelName = (source: MirrorSource, bucketName: string) =>
  `${source === 'gmail' ? GMAIL_MIRROR_PREFIX : OUTLOOK_MIRROR_PREFIX}${bucketName}`;

const strip = (name: string, prefix: string) =>
  name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null;

/** Whether a Gmail label is one of Commander's Bucket labels (by its name). */
export const isMirrorLabel = (label: Pick<EmailLabel, 'name'> & Partial<EmailLabel>) =>
  strip(label.name, GMAIL_MIRROR_PREFIX) !== null;

/** The Bucket name an Outlook category shows, or null for one of the User's own. */
export const bucketOfCategory = (category: string) => strip(category, OUTLOOK_MIRROR_PREFIX);

/** The Bucket name a Gmail label shows, or null for any other label. */
export const bucketOfLabel = (label: Pick<EmailLabel, 'name'>) => strip(label.name, GMAIL_MIRROR_PREFIX);

// Outlook offers 25 preset colours for categories (preset0 to preset24); Buckets take them in order.
export const MIRROR_COLOURS = 25;
export const mirrorColourOf = (order: number) => `preset${order % MIRROR_COLOURS}`;

/** The field's value for these Bucket names: none, one, or several (sorted). */
export function mirroredValue(names: readonly string[]): MirroredBuckets {
  const unique = [...new Set(names)];
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0] as string;
  return unique.sort((a, b) => a.localeCompare(b));
}

/** The Bucket names a message shows at its Source (Gmail labels, or Outlook categories). */
export function mirroredBucketNames(detail: EmailDetail): MirroredBuckets {
  if (detail.folder !== undefined) {
    return mirroredValue((detail.categories ?? []).flatMap((each) => bucketOfCategory(each) ?? []));
  }
  return mirroredValue(detail.labels.flatMap((label) => bucketOfLabel(label) ?? []));
}

/** The Bucket names a field value holds. */
export const namesOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((each) => typeof each === 'string')
      : [];

// The starter Buckets Settings suggests skipping the inbox for.
const SUGGESTED_SKIPS = new Set(['newsletters', 'receipts', 'junk']);
export const suggestsSkippingTheInbox = (bucketId: string) => SUGGESTED_SKIPS.has(bucketId);

// What the sync engine asks of the Source before an Account's writes: labels (categories) to make
// sure of, to rename, and to delete, by the Bucket's name (the adapter adds "Commander/" or
// "Commander: "). `colour`: the Bucket's place, for Outlook's preset colours.
export type MirrorPlan = {
  ensure: { bucketId: string; name: string; colour: number }[];
  rename: { bucketId: string; from: string; to: string; colour: number }[];
  remove: { bucketId: string; name: string }[];
};

// ---------------------------------------------------------------------------------------------
// Mirroring, per Account, as the window sees it

export const bucketMirroring = z.object({
  account: z.string().min(1),
  source: mirrorSource,
  // The User switched Mirror Buckets on.
  enabled: z.boolean(),
  // Paused: Mirror Buckets is below Auto in the Autonomy grid, so nothing is written meanwhile.
  paused: z.boolean(),
  // Removing Commander's labels or categories, as the User asked on switching off.
  removing: z.boolean(),
});
export type BucketMirroring = z.infer<typeof bucketMirroring>;

export const bucketMirroringChange = z.object({
  account: z.string().min(1),
  enabled: z.boolean(),
  // Switching off: also remove Commander's labels or categories from the Account.
  removeLabels: z.boolean().default(false),
});
export type BucketMirroringChange = z.input<typeof bucketMirroringChange>;
