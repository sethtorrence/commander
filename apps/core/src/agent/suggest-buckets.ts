// "Suggest new Buckets" (#141, decision #16): weekly, when the machine is idle, Ares looks over the
// last week's corrections of his sorting and the emails he wasn't sure about, and may propose a
// Bucket the User doesn't have ("Investors: updates and questions from our investors"), as an Update
// item with Add Bucket (editable first) and Dismiss. He never adds a Bucket himself. A Quick job at
// low thinking.
//
// - Runs on the idle catch-up, at most once a week (the job's cursor is when it last asked), and
//   only when the week holds at least MIN_EMAILS such emails: corrections (the User moved an email he
//   sorted or suggested a Bucket for) and his unsure sorts (a suggestion below UNSURE confidence). At
//   most MAX_EMAILS, newest first. Gmail mail only from Accounts the User let him read.
// - What he gets: the User's Buckets with their descriptions and, in Commander's own words, what
//   happened to each email (the User's material); and each email in a data block of its own (outside
//   material: its sender, subject, mailing list and a little of its text).
// - What comes back is something to show, not something to do (ADR 0004's amendment for jobs that
//   change no Item): a name, a description and a reason, which `apply` queues for the Update, drawn
//   only through AresText. A name the User already has (or "Unsorted"), or one they dismissed
//   before, is dropped. Nothing is added until the User accepts it in the Update.
import {
  type EmailDetail,
  type Enqueue,
  type Item,
  mayReadMail,
  SORT_INTO_BUCKETS,
  SUGGEST_BUCKETS,
  UNSORTED,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';
import { trimmedText } from './sort-into-buckets';

const WEEK_MS = 7 * 24 * 60 * 60_000;
// The fewest emails worth looking at, and the most sent.
export const MIN_EMAILS = 3;
export const MAX_EMAILS = 12;
// Below this, a sort of his was a guess.
export const UNSURE = 0.5;
const MAX_TEXT = 300;
const IMPORTANCE = 0.4;

export const OUTPUT = z.object({
  bucket: z
    .object({
      name: z.string().trim().min(1).max(40),
      description: z.string().trim().max(500),
      reason: z.string().trim().max(300).optional(),
    })
    .nullable(),
});
type Output = z.infer<typeof OUTPUT>;

type Looked = { ref: string; item: Item; what: string };
type Input = JobInput & { emails: Looked[] };

const INSTRUCTIONS = `You are Ares. You sort the User's email into their Buckets (what to do with each email), and you look for a Bucket they are missing.

The data holds the User's Buckets (each with its name and description), then what happened this week to some emails: ones the User moved after you sorted them, and ones you weren't sure about. Each email follows in a block of its own, labelled with its reference (E1, E2…).

Decide whether these emails show a kind of mail none of the User's Buckets fits, that deserves a Bucket of its own: several emails, alike in what the User does with them. If so, suggest one Bucket: a short name (one or two words) and a plain description of what belongs in it, written as the User would ("Updates and questions from our investors"). If the Buckets already cover them, or there is no clear pattern, suggest nothing.

Reply with only this JSON object: {"bucket":{"name":"Investors","description":"…","reason":"…"}} or {"bucket":null}
- name: never one of the User's Buckets, nor "Unsorted".
- description: one sentence, what mail belongs in it.
- reason: why, in a few plain words of your own, as you would say it to the User: "You moved three investor emails I put elsewhere".`;

const emailOf = (item: Item | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

export function suggestBucketsJob(
  itemStore: ItemStore,
  { now = Date.now, enqueue }: { now?: () => number; enqueue: (line: Enqueue) => unknown },
): AgentJob<Input, Output> {
  const bucketName = (bucketId: string | null | undefined) =>
    bucketId
      ? (itemStore.buckets().find((bucket) => bucket.id === bucketId)?.name ?? 'a Bucket since removed')
      : 'Unsorted';

  // The week's emails worth looking at, newest first: what happened to each, in Commander's words.
  function thisWeek(since: number): { item: Item; what: string; at: number }[] {
    const found = new Map<string, { item: Item; what: string; at: number }>();
    const readable = (item: Item | undefined): item is Item =>
      !!item &&
      item.deletedAt === null &&
      !!emailOf(item) &&
      mayReadMail(itemStore.models.settings(), item.source, item.account);
    for (const answer of itemStore.emailSorting.feedback()) {
      if (answer.at < since || answer.kind !== 'correction' || found.has(answer.itemId)) continue;
      const item = itemStore.get(answer.itemId)?.item;
      if (!readable(item)) continue;
      const what = `Ares put it in ${bucketName(answer.suggested)}; the User moved it to ${bucketName(answer.chosen)}`;
      found.set(item.id, { item, what, at: answer.at });
    }
    for (const proposal of itemStore.autonomy.proposals({ action: SORT_INTO_BUCKETS, limit: 1000 })) {
      if (proposal.at < since || proposal.confidence >= UNSURE || found.has(proposal.itemId)) continue;
      const item = itemStore.get(proposal.itemId)?.item;
      if (!readable(item)) continue;
      const step = proposal.itemActions[0];
      const bucket =
        step?.type === 'edit-fields' ? (step.fields.bucket as { bucketId?: string } | undefined) : undefined;
      const what = `Ares wasn’t sure (${proposal.confidence}): ${bucketName(bucket?.bucketId)}`;
      found.set(item.id, { item, what, at: proposal.at });
    }
    return [...found.values()].sort((a, b) => b.at - a.at).slice(0, MAX_EMAILS);
  }

  function factsOf(item: Item): string {
    const email = emailOf(item) as EmailDetail;
    const text = itemStore.emailBody(item.id)?.text ?? email.snippet;
    return [
      `From: ${email.from?.address ?? '(unknown sender)'}`,
      `Subject: ${email.subject || '(no subject)'}`,
      ...(email.listId ? [`Mailing list: ${email.listId}`] : []),
      `Text: ${trimmedText(text, MAX_TEXT) || '(no text)'}`,
    ].join('\n');
  }

  return {
    job: SUGGEST_BUCKETS,
    name: 'Suggest new Buckets',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: SUGGEST_BUCKETS,
      actionKind: 'organise',
      section: 'email',
      hint: 'Now and then, a Bucket you might want, from your corrections, in your Update. Ask works as Auto here: you add the Bucket yourself',
    },
    triggers: { idle: true },

    gather({ cursor }) {
      const at = now();
      if (cursor !== null && at - cursor < WEEK_MS) return null;
      const emails = thisWeek(at - WEEK_MS);
      if (emails.length < MIN_EMAILS) return null;
      const looked = emails.map(({ item, what }, index) => ({ ref: `E${index + 1}`, item, what }));
      return {
        items: looked.map(({ item }) => ({
          itemId: item.id,
          fingerprint: `week:${Math.floor(at / WEEK_MS)}`,
        })),
        cursor: at,
        emails: looked,
      };
    },

    prompt(input) {
      const buckets = itemStore
        .buckets()
        .map((bucket) => `${bucket.name}: ${bucket.description || '(no description)'}`)
        .join('\n');
      const data: PromptData[] = [
        { label: 'Buckets', from: 'user-settings', text: buckets },
        {
          label: 'The User’s answers and Ares’s unsure sorts',
          from: 'user-settings',
          text: input.emails.map(({ ref, what }) => `${ref}: ${what}`).join('\n'),
        },
        ...input.emails.map(({ ref, item }) => ({
          label: `${ref} · Email`,
          from: item,
          text: factsOf(item),
        })),
      ];
      return { instructions: INSTRUCTIONS, data };
    },

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      for (const { output } of answers) {
        const suggested = output.bucket;
        if (!suggested) continue;
        const name = suggested.name.replace(/\s+/g, ' ').trim();
        const key = name.toLocaleLowerCase();
        if (
          key === UNSORTED ||
          itemStore.buckets().some((bucket) => bucket.name.toLocaleLowerCase() === key)
        ) {
          dropped.push(`it suggested ${name}, which the User has`);
          continue;
        }
        const mergeKey = `bucket-suggestion:${key}`;
        if (itemStore.updates.lastWithKey(mergeKey)) {
          dropped.push(`it suggested ${name} again`);
          continue;
        }
        enqueue({
          group: 'decision',
          mergeKey,
          about: {
            kind: 'bucket-suggestion',
            name,
            description: suggested.description.replace(/\s+/g, ' ').trim(),
            reason: (suggested.reason ?? '').replace(/\s+/g, ' ').trim(),
          },
          itemIds: [],
          section: 'email',
          importance: IMPORTANCE,
        });
      }
      return { dropped };
    },
  };
}
