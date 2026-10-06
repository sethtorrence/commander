import { z } from 'zod';
import { type Item, type ItemKind, item } from './items';

// The warning mark (#69): an outside Item holding instructions aimed at Ares says so wherever it is
// shown, and the same words go in its injection-warning activity entry. There is no pop-up.

const NOUNS: Partial<Record<ItemKind, string>> = {
  email: 'email',
  event: 'invite',
  'linear-issue': 'issue',
  'pull-request': 'pull request',
  'review-request': 'review request',
  'github-issue': 'issue',
  'github-release': 'release',
  chat: 'chat',
  'channel-post': 'post',
  // A Todo shows the mark of the Item behind it: a Linear issue, today.
  todo: 'Todo’s issue',
};

/** Why the User's Not an instruction clears a mark: their correction's words in the activity log. */
export const NOT_AN_INSTRUCTION = 'Not an instruction aimed at Ares';

/** "This issue contains instructions aimed at Ares. He ignored them." */
export function injectionWarningText(kind: ItemKind): string {
  return `This ${NOUNS[kind] ?? 'item'} contains instructions aimed at Ares. He ignored them.`;
}

// Refusals (#201): Ares sends no model an Item holding one of the User's keys or sign-in tokens (the
// prompt builder refuses it), and says so: an activity entry, a line in the next Update, and a small
// note on the Item. None of them ever holds the secret, nor the Item's own words.

const REFUSED_NOUNS: Partial<Record<ItemKind, string>> = {
  ...NOUNS,
  event: 'event',
  todo: 'Todo',
  block: 'note',
  'daily-note': 'Daily Note',
};

const HOLDS = 'it holds what looks like one of your keys or sign-in tokens';

/** "Ares skipped this email: it holds what looks like one of your keys or sign-in tokens, so…" */
export function refusalText(kind: ItemKind): string {
  return `Ares skipped this ${REFUSED_NOUNS[kind] ?? 'item'}: ${HOLDS}, so none of it went to a model.`;
}

/**
 * The refusal's activity entry, in words: "Ares skipped Dana Kim’s email: it holds what looks like
 * one of your keys or sign-in tokens. None of it went to a model." An email is named by its sender;
 * anything else is "this issue", since the entry is the Item's own (its title might hold the secret).
 */
export function refusalWhy(refused: Pick<Item, 'kind' | 'detail'>): string {
  const from = refused.detail?.kind === 'email' ? refused.detail.from : null;
  const sender = (from?.name || from?.address || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const what = sender ? `${sender}’s email` : `this ${REFUSED_NOUNS[refused.kind] ?? 'item'}`;
  return `Ares skipped ${what}: ${HOLDS}. None of it went to a model.`;
}

const timestamp = z.number().int().nonnegative();
const entryId = z.number().int().positive();

// The Flagged Items list in the Ares Section (#201): every Item carrying a warning mark, newest
// first, with what in it read like an instruction; those the User cleared lately, with Undo; and the
// Items Ares skipped lately because they hold one of the User's keys or sign-in tokens.
export const flaggedItem = z.object({
  item,
  // What in it read like an instruction, word for word as the Item has it (null when nothing can be
  // quoted). Shown to the User, never handed back to a model.
  quote: z.string().nullable(),
  // When it was marked, and by what: the pattern check, or a job's steering flag.
  at: timestamp,
  via: z.enum(['pattern', 'ares']),
  // When the User said Not an instruction, and that correction's entry (what Undo undoes); null while
  // the mark stands.
  clearedAt: timestamp.nullable(),
  clearEntryId: entryId.nullable(),
});
export type FlaggedItem = z.infer<typeof flaggedItem>;

export const skippedItem = z.object({
  item,
  // The refusal's activity entry, and its words (refusalWhy).
  entryId,
  at: timestamp,
  why: z.string(),
  // The job that would have sent it ("Sort into Buckets"), when known.
  job: z.string().nullable(),
});
export type SkippedItem = z.infer<typeof skippedItem>;

export const flaggedItems = z.object({
  marked: z.array(flaggedItem),
  cleared: z.array(flaggedItem),
  skipped: z.array(skippedItem),
});
export type FlaggedItems = z.infer<typeof flaggedItems>;
