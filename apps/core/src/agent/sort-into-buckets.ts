// "Sort into Buckets" (#141, decisions #16, #19, #31): Ares sorts the mail the Bucket Rules miss. Each
// email lands in the right Bucket ("Sorted by Ares", his reason in the activity log) or, when he isn't
// sure, stays Unsorted with his dashed suggested Bucket, Confirm and Change. A Quick job at low
// thinking (#31: sharpened Bucket descriptions lifted GLM-5.3-Flash from 50% to 81% at low thinking):
// no tools, a reply that must fit OUTPUT.
//
// - Runs when mail arrives (and on the idle catch-up, and as the backfill's `due` runs while the
//   machine stays idle, agent/index.ts). It looks only at the latest message of each inbox thread
//   from the last SORT_DAYS days (a thread's Bucket is its latest message's, so older messages are
//   never sent), that has no Bucket yet (a Rule's or the User's sorting is never his to change), no
//   suggestion of his waiting, and that he hasn't looked at already. Gmail mail only once the User
//   has allowed it for that Account (mayReadMail). Nothing at all with Organise Off in Email. At most
//   MAX_EMAILS a run, newest first: when mail arrives, only that mail; on the idle catch-up, the
//   backfill or a request, the rest of what is in scope (a new Account's download). The
//   catch-up and the backfill (no mail just arrived) respect the monthly cap: once the month's spend
//   reaches it, only arriving mail is sorted (Quick calls carry on past the cap, #19), and the rest
//   of a download waits for next month or a higher cap.
// - Each email gets a call of its own, in a data block of its own (ADR 0004): with one outside Item
//   in a prompt, sorting it acts on that email alone, so it can follow the Autonomy settings. With it
//   go the User's Buckets with their descriptions (the User's own material) and what Ares knows about
//   mail like it (#74, memory-context.ts): the User's earlier answers to his sorting ("Mail from
//   receipts@stripe.com belongs in Receipts"), found by its sender, its words and (#73) its meaning.
//   The email is described by its headers (from, to, cc, date, subject, mailing list), a few facts
//   Commander knows (sent by the User, an unsubscribe link, an invitation, its thread) and its text
//   trimmed to a budget, quoted history left out: never its HTML, never its attachments.
// - The reply names a Bucket by its name (or "unsorted") with a confidence; the name is checked
//   against the Buckets the User has now, and anything else is dropped. Each sort is a proposal
//   (Organise / "Sort into Buckets", in the Email Section) to the gate, an `edit-fields` change of
//   the email's Bucket (Commander's own field: nothing reaches Gmail or Outlook), which sorts it as
//   Ares or keeps it as a suggestion. An email with the warning mark only ever gets a suggestion.
import {
  addressName,
  BUCKET_FIELD,
  type Bucket,
  decide,
  type EmailAddress,
  type EmailDetail,
  type Item,
  mayReadMail,
  SORT_DAYS,
  SORT_INTO_BUCKETS,
  senderDomains,
  sortingFingerprint,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import { type MeaningLookup, recall } from './memory-context';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';

// At most this many emails a run, one call each; the rest wait for the next trigger.
export const MAX_EMAILS = 20;
// The most of an email's text that goes in: about 400 tokens.
export const MAX_TEXT = 1_500;
const MAX_ADDRESSES = 6;
const MAX_REASON_WORDS = 14;
const MAX_REASON_CHARS = 140;
const DAY_MS = 24 * 60 * 60_000;

export const OUTPUT = z.object({
  // One of the Buckets' names exactly as listed, or "unsorted".
  bucket: z.string().trim().min(1).max(80),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(600).optional(),
});
type Output = z.infer<typeof OUTPUT>;

type Candidate = { ref: string; item: Item; fingerprint: string };
type Input = JobInput & { candidates: Candidate[] };

const INSTRUCTIONS = `You are Ares. You sort the User's incoming email into their Buckets: what to do with each email.

The data holds the User's Buckets (each with its name and the User's own description of what belongs in it), then the email to sort, labelled E1, with its sender, recipients, date, subject, mailing list, a few facts about it and its text.

It may also hold what Ares knows about mail like it: the User's answers to his earlier sorting (examples: "Mail from receipts@stripe.com belongs in Receipts, not Newsletters") and the User's preferences.

Decide which one Bucket the email belongs in, by the Buckets' descriptions. Read each description closely: it is the User's own rule for that Bucket. An example about the same sender, domain or mailing list is the User's own answer: sort the email the same way. If none fits, or you can't tell, say "unsorted".

Reply with only this JSON object: {"bucket":"Receipts","confidence":0.9,"reason":"…"}
- bucket: one of the Buckets' names exactly as listed, or "unsorted".
- confidence: how sure you are, from 0 to 1. 0.9 or more only when the email plainly belongs there by its Bucket's description (or an example about the same sender); 0.5 to 0.8 when it is likely; below 0.5 when it is a guess.
- reason: why, in a few plain words of your own (fewer than 12), as you would say it to the User: "Shipping update from a shop". No full stop.`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const pad = (n: number) => String(n).padStart(2, '0');
// "Wednesday 7 October 2026, 08:00", in the User's local time.
function dateText(at: number): string {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Gmail's category labels, as the User knows them.
const CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

// A reason as the activity log keeps it: one line, a few words, no closing full stop.
function cleanReason(reason: string | undefined): string | null {
  const words = (reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .split(' ')
    .filter(Boolean);
  if (!words.length) return null;
  const text =
    words.length > MAX_REASON_WORDS ? `${words.slice(0, MAX_REASON_WORDS - 2).join(' ')}…` : words.join(' ');
  return cut(text, MAX_REASON_CHARS);
}

// Where quoted history starts in a reply's text: "On Mon, Dana wrote:", an Outlook reply header, or a
// forwarded message's banner. Everything from there on is the earlier message.
const QUOTE_START = [
  /^On .{0,300}wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^_{10,}\s*$/,
  /^From: .+$/,
];

/** The lines of an email's text its sender wrote: quoted history and quoted lines left out. */
export function ownLines(text: string): string[] {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // History after something the sender wrote; a message that is only a forward keeps its banner on.
    if (kept.some((each) => each.trim()) && QUOTE_START.some((pattern) => pattern.test(trimmed))) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  return kept;
}

/** An email's text as Ares reads it: quoted history and quoted lines left out, cut to MAX_TEXT. */
export function trimmedText(text: string, max = MAX_TEXT): string {
  return cut(ownLines(text).join('\n'), max);
}

const addressText = (address: EmailAddress) => {
  const name = address.name?.trim();
  return name && name !== address.address ? `${name} <${address.address}>` : address.address;
};

function addresses(list: readonly EmailAddress[]): string {
  const shown = list.slice(0, MAX_ADDRESSES).map(addressText);
  const more = list.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

const emailOf = (item: Item | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

/**
 * Ares's suggested Buckets that no longer stand: their email was sorted by the User or a Rule since
 * (both always win over him), is gone, or is no longer its thread's latest message (a reply arrived,
 * so the thread's Bucket is the reply's to have). The Agent dismisses them.
 */
export const staleSortingSuggestions = (itemStore: ItemStore): number[] =>
  itemStore.emailSorting.staleSuggestions();

export function sortIntoBucketsJob(
  itemStore: ItemStore,
  {
    maxItems = MAX_EMAILS,
    now = Date.now,
    meaning,
  }: { maxItems?: number; now?: () => number; meaning?: MeaningLookup } = {},
): AgentJob<Input, Output> {
  const waiting = () =>
    new Set(
      itemStore.autonomy
        .proposals({ action: SORT_INTO_BUCKETS, statuses: ['pending'], limit: 1000 })
        .map((proposal) => proposal.itemId),
    );

  // Whether the month's spend has reached the User's cap (in their local time).
  function overCap(): boolean {
    const cap = itemStore.models.settings().monthlyCapUsd;
    if (cap === null) return false;
    const date = new Date(now());
    return itemStore.models.spentSince(new Date(date.getFullYear(), date.getMonth(), 1).getTime()) >= cap;
  }

  // Whether the User's Autonomy settings have sorting Off in Email.
  const off = () =>
    decide(
      { action: SORT_INTO_BUCKETS, actionKind: 'organise', section: 'email', confidence: 1, chained: false },
      itemStore.autonomy.settings(),
    ) === 'off';

  // An email Ares may sort (besides being its thread's latest, in the inbox, lately): one with no
  // Bucket at all, no suggestion of his waiting, from an Account whose mail he may read.
  function candidate(item: Item | undefined, pending = waiting()): item is Item {
    const email = emailOf(item);
    return (
      !!item &&
      !!email &&
      item.deletedAt === null &&
      !email.bucket &&
      !pending.has(item.id) &&
      mayReadMail(itemStore.models.settings(), item.source, item.account)
    );
  }

  // Facts about the email's thread that only Commander knows: how many messages, how many the User
  // wrote, and the Bucket the User put it in before this message came (their own sorting).
  function threadFacts(item: Item, email: EmailDetail): string[] {
    if (!item.account) return [];
    const messages = itemStore.emailThread(item.account, email.threadKey)?.messages ?? [];
    if (messages.length < 2) return [];
    const mine = messages.filter((each) => emailOf(each.item)?.sentByMe).length;
    const earlier = messages
      .slice(0, -1)
      .map((each) => emailOf(each.item)?.bucket)
      .findLast((bucket) => bucket?.sortedBy === 'user' && bucket.bucketId);
    const before = earlier?.bucketId
      ? itemStore.buckets().find((each) => each.id === earlier.bucketId)
      : null;
    return [
      `Its thread: ${messages.length} messages${mine ? `, ${mine} of them from the User` : ', none from the User'}`,
      ...(before ? [`The User had put this thread in ${before.name} before this message came`] : []),
    ];
  }

  function factsOf(item: Item): string {
    const email = emailOf(item) as EmailDetail;
    const text = itemStore.emailBody(item.id)?.text ?? email.snippet;
    const categories = email.labels.flatMap((label) => (CATEGORIES[label.id] ? [CATEGORIES[label.id]] : []));
    const files = email.attachments.filter((attachment) => !attachment.inline).length;
    const thread = threadFacts(item, email);
    return [
      `From: ${email.from ? addressText(email.from) : '(unknown sender)'}`,
      ...(email.to.length ? [`To: ${addresses(email.to)}`] : []),
      ...(email.cc.length ? [`Cc: ${addresses(email.cc)}`] : []),
      `Date: ${dateText(email.sentAt)}`,
      `Subject: ${email.subject || '(no subject)'}`,
      ...(email.listId ? [`Mailing list: ${email.listId}`] : []),
      ...(email.sentByMe ? ['Sent by the User'] : []),
      ...(email.listUnsubscribe ? ['It has an unsubscribe link'] : []),
      ...(email.hasInvitation ? ['It carries a calendar invitation'] : []),
      ...(categories.length ? [`Gmail category: ${categories.join(', ')}`] : []),
      ...(files ? [`Attachments: ${files} (not shown)`] : []),
      ...thread,
      `Text: ${trimmedText(text) || '(no text)'}`,
    ].join('\n');
  }

  function bucketsText(buckets: readonly Bucket[]): string {
    return buckets.map((bucket) => `${bucket.name}: ${bucket.description || '(no description)'}`).join('\n');
  }

  return {
    job: SORT_INTO_BUCKETS,
    name: 'Sort into Buckets',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: SORT_INTO_BUCKETS,
      actionKind: 'organise',
      section: 'email',
      hint: 'Emails no Bucket Rule sorts, into the Bucket their description fits. Nothing changes in Gmail or Outlook',
    },
    triggers: { 'items-arrived': true, idle: true },

    gather({ triggers, seen }) {
      if (off()) return null;
      const pending = waiting();
      const arrived = new Set(triggers.flatMap((trigger) => ('itemIds' in trigger ? trigger.itemIds : [])));
      // Catching up (nothing arrived, nobody asked) waits once the month's cap is reached.
      const asked = triggers.some((trigger) => trigger.kind === 'request');
      if (!arrived.size && !asked && overCap()) return null;
      // Mail that just arrived is sorted at once; the rest of what is in scope only on the catch-up,
      // the backfill or a request (a new Account's download waits for the machine to be idle).
      const inScope = itemStore.emailSorting.scope(now() - SORT_DAYS * DAY_MS);
      const ordered = arrived.size ? inScope.filter((item) => arrived.has(item.id)) : inScope;
      const candidates: Candidate[] = [];
      for (const item of ordered) {
        if (candidates.length >= maxItems) break;
        const fingerprint = sortingFingerprint(item);
        if (!candidate(item, pending) || seen(item.id, fingerprint)) continue;
        candidates.push({ ref: 'E1', item, fingerprint });
      }
      return {
        items: candidates.map(({ item, fingerprint }) => ({ itemId: item.id, fingerprint })),
        candidates,
      };
    },

    // One email per call: see the top of this file.
    batch: (input) =>
      input.candidates.map((one) => ({
        items: [{ itemId: one.item.id, fingerprint: one.fingerprint }],
        candidates: [one],
      })),

    async prompt(input) {
      const recalled = await Promise.all(
        input.candidates.map(async ({ item }) => {
          const email = emailOf(item) as EmailDetail;
          const sender = email.from?.address.trim().toLowerCase() ?? '';
          const text = [
            sender,
            ...senderDomains(email),
            email.listId ?? '',
            addressName(email.from),
            email.subject,
            cut(email.snippet, 200),
          ].join(' ');
          return recall(itemStore, {
            text,
            handles: sender ? [sender] : [],
            kinds: ['example', 'preference'],
            meaning: await meaning?.(text),
          });
        }),
      );
      const data: PromptData[] = [
        { label: 'Buckets', from: 'user-settings', text: bucketsText(itemStore.buckets()) },
        ...recalled.flat(),
        ...input.candidates.map(({ ref, item }) => ({
          label: `${ref} · Email`,
          from: item,
          text: factsOf(item),
        })),
      ];
      return { instructions: INSTRUCTIONS, data };
    },

    output: OUTPUT,

    proposals(output, input) {
      const [offered] = input.candidates;
      if (!offered) return { proposals: [], dropped: [] };
      const name = output.bucket.trim().toLocaleLowerCase();
      if (name === 'unsorted') return { proposals: [], dropped: [] };
      const bucket = itemStore.buckets().find((each) => each.name.toLocaleLowerCase() === name);
      if (!bucket)
        return { proposals: [], dropped: [`it chose ${output.bucket}, which is none of the Buckets`] };
      // The email may have been sorted (or changed) while Ares was thinking.
      const item = itemStore.get(offered.item.id)?.item;
      if (!candidate(item) || sortingFingerprint(item) !== offered.fingerprint) {
        return { proposals: [], dropped: [`${offered.ref} changed while Ares was looking at it`] };
      }
      return {
        proposals: [
          {
            itemId: item.id,
            section: 'email' as const,
            itemActions: [
              {
                type: 'edit-fields' as const,
                itemId: item.id,
                fields: { [BUCKET_FIELD]: { bucketId: bucket.id, sortedBy: 'ares' as const } },
              },
            ],
            confidence: output.confidence,
            reason: cleanReason(output.reason) ?? `Looks like ${bucket.name}`,
            // An email that tried to steer him only ever gets a suggestion (ADR 0004).
            ...(item.injectionWarning && { chained: true }),
          },
        ],
        dropped: [],
      };
    },
  };
}
