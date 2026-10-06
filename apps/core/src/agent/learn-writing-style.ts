// "Learn writing style" (#143, decision #19: Memory's preferences include the User's writing style,
// learned from sent mail, so drafts sound like the User). A Quick job at low thinking, run when the
// machine is idle (and on request, Settings → Ares's Run now), at most once a week per Account.
//
// - Reads a sample of the User's own sent mail in each email Account: the newest MAX_SAMPLES messages
//   of the last STYLE_DAYS days with words of their own (quoted history left out; forwards skipped,
//   as their words are mostly someone else's), never HTML nor attachments. Gmail only once the User has
//   let Ares read that Account's mail (#141). An Account needs MIN_SAMPLES before he says anything.
// - One call per Account. Each message goes in an outside data block of its own (trust comes from where
//   an Item came from, ADR 0004, and sent mail came from the Source); each says whether its recipients
//   are in the User's organisation (the same domain as the User's address, a personal mail domain
//   aside), so the style can say how the User writes to colleagues and to outsiders.
// - The reply is the style in a few plain sentences. It is kept as the Account's one preference memory
//   (writingStyleKey): confirmed, since sent mail is the User's own writing, so his drafts take it as
//   the User's own material. It never carries a link (any is taken out). Learned again, the memory's
//   words are replaced, unless the User edited them; one the User deleted is never learned again. It
//   writes Memory, not Items, so nothing goes to the gate (ADR 0004's fifth and eleventh amendments).
import {
  type EmailAddress,
  type EmailDetail,
  type Item,
  LEARN_WRITING_STYLE,
  mayReadMail,
  writingStyleKey,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import { LINK_REMOVED, urlsIn } from '../safety/output';
import { longDay } from './chat-material';
import { writtenText } from './draft-email-reply';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';

// How far back the sample reaches, how many messages it takes (and must have), and how often an
// Account's style is learned again.
export const STYLE_DAYS = 30;
export const MAX_SAMPLES = 12;
export const MIN_SAMPLES = 3;
export const STYLE_EVERY_MS = 7 * 24 * 60 * 60_000;
// The newest sent messages looked through for a sample, and how much of each goes in.
const LOOKED_AT = 60;
const SAMPLE_TEXT = 1_200;
const MAX_STYLE = 900;
const MAX_SOURCES = 5;
const DAY_MS = 24 * 60 * 60_000;

// Mail domains anyone can have an address at: sharing one says nothing about an organisation.
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
]);

export const OUTPUT = z.object({
  // The User's writing style, in a few plain sentences.
  style: z.string().trim().min(1).max(2_000),
});
type Output = z.infer<typeof OUTPUT>;

type Sample = { account: string; address: string; messages: Item[]; fingerprint: string };
type Input = JobInput & { samples: Sample[] };

const INSTRUCTIONS = `You are Ares. You learn how the User writes email, so the replies you draft for them sound like them.

The data holds a sample of the User's own sent emails from one of their Accounts, newest first, each with whom it went to (and whether they are in the User's organisation), when, its subject and the words the User wrote.

Describe how the User writes, in a few short plain sentences of your own, as notes for drafting their replies:
- how long their emails usually are, and how they set them out;
- their tone (formal or casual, warm or brisk) and the language they write in;
- how they open (their greeting, or none) and how they close (their sign-off and name, or none), with their exact words when they repeat them;
- how all that differs between colleagues in their organisation and people outside it, when the sample shows a difference.

Say only what the sample shows, and nothing about what any email was about: no names of other people, no facts, no links.

Reply with only this JSON object: {"style":"…"}`;

const lower = (address: string) => address.trim().toLowerCase();
const domainOf = (address: string) => lower(address).split('@')[1] ?? '';

const emailOf = (item: Item | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;

// A forward's words are mostly someone else's.
const FORWARD = /^\s*(?:fwd?|fw|wg|tr)\s*:/i;

// Whom a sent message went to, and whether they are in the User's organisation.
function recipients(email: EmailDetail, own: string): string {
  const people: EmailAddress[] = [...email.to, ...email.cc];
  const domain = domainOf(own);
  const organisation = !!domain && !PERSONAL_DOMAINS.has(domain);
  const inside = people.filter((each) => organisation && domainOf(each.address) === domain).length;
  const where =
    !people.length || !organisation
      ? ''
      : inside === people.length
        ? ' (all in the User’s organisation)'
        : inside === 0
          ? ' (all outside the User’s organisation)'
          : ' (some in the User’s organisation, some outside it)';
  const named = people.slice(0, 4).map((each) => each.name?.trim() || each.address);
  return `${named.join(', ')}${people.length > named.length ? ` and ${people.length - named.length} more` : ''}${where}`;
}

/** A style as the memory keeps it: one paragraph, no links, not too long. */
export function cleanStyle(text: string): string {
  let out = text;
  for (const url of urlsIn(out)) out = out.split(url).join('');
  out = out.split(LINK_REMOVED).join('').replace(/\s+/g, ' ').trim();
  return out.length > MAX_STYLE ? `${out.slice(0, MAX_STYLE - 1).trimEnd()}…` : out;
}

export function learnWritingStyleJob(
  itemStore: ItemStore,
  { now = Date.now }: { now?: () => number } = {},
): AgentJob<Input, Output> {
  // The newest of an Account's sent messages with words of the User's own, newest first.
  function sampleOf(account: string): Item[] {
    return itemStore.suggestedReplies
      .sent(account, now() - STYLE_DAYS * DAY_MS, LOOKED_AT)
      .filter((item) => {
        const email = emailOf(item);
        if (!email || FORWARD.test(email.subject)) return false;
        return !!writtenText(itemStore.emailBody(item.id)?.text ?? '', SAMPLE_TEXT).trim();
      })
      .slice(0, MAX_SAMPLES);
  }

  return {
    job: LEARN_WRITING_STYLE,
    name: 'Learn writing style',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: LEARN_WRITING_STYLE,
      actionKind: 'organise',
      section: 'email',
      hint: 'How you write, from your own sent mail, kept in What Ares knows for the replies he drafts. Ask works as Auto here: you edit or delete it there',
    },
    triggers: { idle: true },

    gather({ triggers }) {
      const asked = triggers.some((trigger) => trigger.kind === 'request');
      const samples: Sample[] = [];
      for (const { account, source } of itemStore.suggestedReplies.sentAccounts(
        now() - STYLE_DAYS * DAY_MS,
      )) {
        if (!mayReadMail(itemStore.models.settings(), source, account)) continue;
        const key = writingStyleKey(account);
        // Deleted by the User: never learned again.
        if (itemStore.memory.knows([key]).has(key) && !itemStore.memory.byKey(key)) continue;
        const last = itemStore.memory.progress(key);
        if (!asked && last !== null && now() - last < STYLE_EVERY_MS) continue;
        const messages = sampleOf(account);
        if (messages.length < MIN_SAMPLES) continue;
        const own = itemStore.suggestedReplies.ownAddresses(account);
        const address = emailOf(messages[0])?.from?.address ?? own[0] ?? account;
        samples.push({
          account,
          address,
          messages,
          fingerprint: JSON.stringify(messages.map((item) => item.id)),
        });
      }
      return {
        items: samples.map((sample) => ({
          itemId: sample.messages[0]?.id as string,
          fingerprint: sample.fingerprint,
        })),
        samples,
      };
    },

    // One Account per call.
    batch: (input) =>
      input.samples.map((one) => ({
        items: [{ itemId: one.messages[0]?.id as string, fingerprint: one.fingerprint }],
        samples: [one],
      })),

    prompt(input) {
      const [sample] = input.samples;
      const data: PromptData[] = (sample?.messages ?? []).map((item, index) => {
        const email = emailOf(item) as EmailDetail;
        return {
          label: `S${index + 1} · The User’s sent email`,
          from: item,
          text: [
            `To: ${recipients(email, sample?.address ?? '')}`,
            `Date: ${longDay(email.sentAt)}`,
            `Subject: ${email.subject || '(no subject)'}`,
            `Text:\n${writtenText(itemStore.emailBody(item.id)?.text ?? '', SAMPLE_TEXT)}`,
          ].join('\n'),
        };
      });
      return { instructions: INSTRUCTIONS, data };
    },

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      for (const { output, input } of answers) {
        const [sample] = input.samples;
        if (!sample) continue;
        const style = cleanStyle(output.style);
        if (!style) {
          dropped.push(`its style for ${sample.address} was empty once links were taken out`);
          continue;
        }
        const key = writingStyleKey(sample.account);
        itemStore.transaction(() => {
          itemStore.memory.learn({
            kind: 'preference',
            text: `Writing style for ${sample.address}: ${style}`,
            confirmed: true,
            key,
            keywords: `writing style email replies tone greeting sign-off ${sample.address}`,
            sources: sample.messages.slice(0, MAX_SOURCES).map((item) => item.id),
          });
          itemStore.memory.saveProgress(key, now());
        });
      }
      return { dropped };
    },
  };
}
