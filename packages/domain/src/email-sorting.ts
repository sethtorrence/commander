import { z } from 'zod';
import { BUCKET_FIELD } from './buckets';
import type { EmailDetail } from './email';
import { domainsOf } from './email-rules';
import type { Item } from './items';
import type { ModelProvider, ModelSettings } from './models';
import type { RuleDraft } from './rules';

/*
  Ares sorts email into Buckets (#141, decisions #16, #19, #31): what the Bucket Rules miss, he sorts
  himself when he is sure ("Sorted by Ares", his reason in the activity log) and otherwise leaves the
  email Unsorted with a dashed suggested Bucket, Confirm and Change. Every answer the User gives him
  is kept as an example, five that point one sender, domain or mailing list at one Bucket make a
  suggested Rule, and now and then he may propose a Bucket the User doesn't have (never adding one
  himself).

  A thread's Bucket is its latest message's (#137), so he sorts a thread by its latest message: older
  messages are never sent. He looks only at threads in the inbox whose latest message is no older
  than SORT_DAYS (a new Account's download), never Trash, and never mail a Rule or the User sorted.
  Sorting changes nothing at the Source: the Bucket is Commander's own field.
*/

// The registered action (and job) "Sort into Buckets": Organise, in the Email Section.
export const SORT_INTO_BUCKETS = 'sort-into-buckets';
// The job that proposes new Buckets from the week's corrections (an Update item, never a change).
export const SUGGEST_BUCKETS = 'suggest-buckets';

// How far back Ares sorts: the 30 days a new Account downloads, by a thread's latest message.
export const SORT_DAYS = 30;

// What Ares's suggested Bucket on an email is: the proposal waiting, and the Bucket it would sort the
// email into. Decorates the email as it is read (Item.bucketSuggestion).
export const bucketSuggestion = z.object({
  proposalId: z.number().int().positive(),
  bucketId: z.string().min(1),
});
export type BucketSuggestion = z.infer<typeof bucketSuggestion>;

/** Whether an `edit-fields` change touches only an email's Bucket: Commander's own field, Organise. */
export const onlyBucketFields = (fields: Record<string, unknown>) => {
  const names = Object.keys(fields);
  return names.length > 0 && names.every((name) => name === BUCKET_FIELD);
};

// One of the User's answers to Ares's sorting: the email, his Bucket, and the User's (null: Unsorted).
export const bucketFeedback = z.object({
  entryId: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  kind: z.enum(['correction', 'confirmation']),
  itemId: z.string().min(1),
  suggested: z.string().min(1),
  chosen: z.string().min(1).nullable(),
});
export type BucketFeedback = z.infer<typeof bucketFeedback>;

// How far Ares has got with the mail in scope, for the Email status line ("Ares is sorting: 400 of
// 3,000"): threads he has sorted or looked at (or that a Rule or the User sorted), of all of them.
export const sortingProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type SortingProgress = z.infer<typeof sortingProgress>;

/** "Ares is sorting: 400 of 3,000", or null when there is nothing left to sort. */
export function sortingLine({ done, total }: SortingProgress): string | null {
  if (total === 0 || done >= total) return null;
  return `Ares is sorting: ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** What Ares judges an email by: when none of it changes, he has nothing new to go on. */
export function sortingFingerprint(item: Pick<Item, 'id' | 'title' | 'detail'>): string {
  const email = item.detail?.kind === 'email' ? item.detail : null;
  return JSON.stringify([
    item.id,
    email?.subject ?? item.title,
    email?.from?.address.toLowerCase() ?? null,
    email?.listId ?? null,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Gmail and the cloud (#19, #141)

// The User's answer for one Gmail Account: whether Ares may send its mail to a cloud model.
export const cloudMailAnswer = z.enum(['allowed', 'declined']);
export type CloudMailAnswer = z.infer<typeof cloudMailAnswer>;

// The company behind each provider, as the consent question names it.
export const MODEL_COMPANIES: Record<ModelProvider, string> = { zai: 'Z.ai' };

/**
 * Whether Ares may read an Account's mail: Gmail only once the User allowed it for that Account
 * (asked once, changeable in Settings → Ares); other mail always. Every model Commander offers today
 * is a cloud model, so the question always applies.
 */
export function mayReadMail(
  settings: Pick<ModelSettings, 'cloudMail'>,
  source: string | null,
  account: string | null,
): boolean {
  if (source !== 'gmail') return true;
  return !!account && settings.cloudMail?.[account] === 'allowed';
}

/** The consent question for a Gmail Account, in plain words naming the model's company. */
export function cloudMailQuestion(address: string, provider: ModelProvider = 'zai'): string {
  const company = MODEL_COMPANIES[provider];
  return `Let Ares read mail from ${address}? To sort it into Buckets, file it into Projects and draft your replies, Commander sends each email’s sender, subject and text (never attachments) to ${company}, the company that runs Ares’s model. Until you allow it, Ares leaves this Account’s mail to your Rules and to you.`;
}

// ---------------------------------------------------------------------------------------------
// Bucket Rule suggestions

// The email fields a Bucket Rule suggestion can be about, most specific first: a mailing list, a
// sender's address, a sender's domain. When two point at the same emails, the more specific is offered.
export const BUCKET_RULE_SUGGESTION_FIELDS = ['gmail.list', 'gmail.from', 'gmail.domain'];

type BucketRuleSuggestionAbout = { field: string; value: string; label: string; bucketId: string };

/** The Rule a Bucket suggestion would make: "from domain is stripe.com", sorting into its Bucket. */
export function bucketRuleSuggestionDraft(about: BucketRuleSuggestionAbout): RuleDraft {
  return {
    target: { kind: 'bucket', bucketId: about.bucketId },
    when: { join: 'and', terms: [{ field: about.field, op: 'is', value: about.value, label: about.label }] },
  };
}

const SENDERS: Record<string, (label: string) => string> = {
  'gmail.from': (label) => `mail from ${label}`,
  'gmail.domain': (label) => `mail from ${label}`,
  'gmail.list': (label) => `mail from the list ${label}`,
};

/** "Always put mail from stripe.com in Receipts?" */
export function bucketRuleSuggestionQuestion(about: { field: string; label: string; name: string }): string {
  const sender = SENDERS[about.field]?.(about.label) ?? `mail with ${about.label}`;
  return `Always put ${sender} in ${about.name}?`;
}

/** "You put 5 emails from stripe.com in Receipts. Always put mail from stripe.com in Receipts?" */
export function bucketRuleSuggestionText(about: {
  field: string;
  label: string;
  name: string;
  count: number;
}): string {
  const from = about.field === 'gmail.list' ? `from the list ${about.label}` : `from ${about.label}`;
  return `You put ${about.count} emails ${from} in ${about.name}. ${bucketRuleSuggestionQuestion(about)}`;
}

// ---------------------------------------------------------------------------------------------
// How an email reads in an example

/**
 * How an example names an email: by its sender's address and mailing list, never its words, nor the
 * sender's display name (anyone can write anything there), so it can go in the User's own block.
 */
export function emailSubject(detail: Pick<EmailDetail, 'from' | 'listId'>): string {
  const address = detail.from?.address.trim().toLowerCase() || 'an unknown sender';
  const list = detail.listId ? (/<([^<>]+)>/.exec(detail.listId)?.[1] ?? detail.listId) : null;
  return `Mail from ${address}${list ? ` (list ${list.trim().toLowerCase()})` : ''}`;
}

/** The sender's domains, most specific first, for an email's words. */
export const senderDomains = (detail: Pick<EmailDetail, 'from'>) =>
  detail.from ? domainsOf(detail.from.address) : [];
