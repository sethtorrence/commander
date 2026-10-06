import { z } from 'zod';
import type { ComposeBody, ComposeRun } from './email-compose';

/*
  Ares drafts replies in the User's own style (#143, decisions #15, #19, #11, #22, #31).

  - "Learn writing style" (a Quick job, when idle, weekly) reads a sample of the User's own sent mail in
    each Account (text only, the last 30 days) and keeps one preference memory per Account: how long,
    how formal, their greetings and sign-offs, and how that differs between colleagues and outsiders.
    Sent mail is the User's own writing, so the memory is confirmed; What Ares knows shows it, and the
    User may edit or delete it (deleted, it is never learned again).
  - "Draft replies" (a Deep job at `reasoning_effort: high`) runs under the Organise action "Draft
    replies" (default Auto when sure): when a thread enters Needs reply, and on request (Draft a reply
    on the open thread, `d` in the list). The thread goes in as outside material, one message per
    data block (never attachments), beside the User's earlier mail to the same people, the style
    preference and what Ares knows about the sender. The reply is `{ body, confidence }`.
  - The suggestion (a Suggested reply) is Ares's own record beside the thread, never an Item and never
    at the Source: at Auto when sure it is already waiting at the end of the thread; at Ask (or on a
    thread with the warning mark) it is only offered, and drafted when the User asks. Open in composer
    makes it an ordinary Draft (#138) with the reply's From, signature and threading, saved to Gmail's or
    Outlook's Drafts as the User edits; Dismiss keeps it away from that thread until a new message
    arrives; drafting again replaces it.
  - Ares never sends: only the User does, by pressing Send in the composer (with Undo send). The gate
    refuses any proposal that would write or send a message, whatever the Autonomy settings say.
  - A link in Ares's draft that is in neither the thread nor the User's own sent mail is marked "Ares
    added this link" in the composer (an `aresLink` run) and left out of everything that reaches the
    Source, Drafts included, until the User keeps it.
*/

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

/** The job (and its Usage page line, "Draft replies") that drafts replies to email threads. */
export const DRAFT_EMAIL_REPLIES = 'draft-email-replies';
/** The job that learns the User's writing style from their sent mail. */
export const LEARN_WRITING_STYLE = 'learn-writing-style';

// The longest draft Ares writes, and the longest instruction the User may give with a request.
export const MAX_EMAIL_DRAFT = 6_000;
export const MAX_DRAFT_INSTRUCTION = 1_000;

/** The memory key of an Account's writing style: one preference per Account. */
export const writingStyleKey = (account: string) => `writing-style:${account}`;

// Ares's suggested reply at the end of a thread, as the window shows it: offered (he can draft one;
// nothing has been asked of the model yet) or ready (his draft, the links he added that are in neither
// the thread nor the User's sent mail, how sure he is, and whether that clears the bar for Auto when
// sure). `answering`: the message it replies to, the thread's latest.
export const readyReply = z.object({
  state: z.literal('ready'),
  answering: id,
  body: z.string().min(1).max(MAX_EMAIL_DRAFT),
  addedLinks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  sure: z.boolean(),
  at: timestamp,
});
export type ReadyReply = z.infer<typeof readyReply>;
export const suggestedReply = z.discriminatedUnion('state', [
  z.object({ state: z.literal('offered'), answering: id }),
  readyReply,
]);
export type SuggestedReply = z.infer<typeof suggestedReply>;

// A request to draft a reply to an email thread, from the window (Draft a reply) or a Skill: the thread
// by any of its messages, and what the User wants said, in their own words, when they say.
export const draftEmailRequest = z.object({
  itemId: id,
  instruction: z.string().trim().max(MAX_DRAFT_INSTRUCTION).optional(),
});
export type DraftEmailRequest = z.input<typeof draftEmailRequest>;

// A web address, as the composer and the output checks find them (safety/output.ts's urlsIn).
const URL = /\bhttps?:\/\/[^\s<>"'`[\]()“”‘’«»]+/gi;
const TRAILING = /[.,;:!?'"]+$/;

/** The web addresses in a text, without trailing punctuation. */
export function draftUrls(text: string): string[] {
  return [...text.matchAll(URL)].map((match) => match[0].replace(TRAILING, ''));
}

// One line of a draft as runs: plain text, with each link Ares added in a run of its own.
function lineRuns(line: string, added: ReadonlySet<string>): ComposeRun[] {
  const runs: ComposeRun[] = [];
  let at = 0;
  for (const match of line.matchAll(URL)) {
    const url = match[0].replace(TRAILING, '');
    if (!added.has(url)) continue;
    const index = match.index ?? 0;
    if (index > at) runs.push({ text: line.slice(at, index) });
    runs.push({ text: url, aresLink: true });
    at = index + url.length;
  }
  if (at < line.length) runs.push({ text: line.slice(at) });
  return runs;
}

/**
 * Ares's draft as the composer's body: a paragraph per line, and each link he added (in neither the
 * thread nor the User's sent mail) marked so the composer highlights it and nothing sends it unkept.
 */
export function draftBody(text: string, addedLinks: readonly string[]): ComposeBody {
  const added = new Set(addedLinks);
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({ type: 'paragraph' as const, runs: line ? lineRuns(line, added) : [] }));
}

/** A draft as the composer starts it: plain text, line breaks kept, no runs of blank lines, not too long. */
export function cleanEmailDraft(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EMAIL_DRAFT);
}
