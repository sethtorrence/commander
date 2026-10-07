// What a Skill hands a Conversation (#192): what it found, for Ares to answer from. Each Item comes
// read (its facts and words, read-item.ts) and goes to the model in a data block of its own, with a
// ref his answer links it by; other material (what Ares knows, People, Past Updates) comes as
// ready-made data blocks; and Commander's own note says what the Skill did, in its words. The
// Update Skill also hands over the Update it gave, which the Conversation shows with its actions, and
// an action Skill (#196) the proposals it handed the gate, which it shows as cards.
import type { FindKind, FindWhen, Item, ItemKind, SummaryTargetRange, UpdateView } from '@commander/domain';
import type { PromptData } from '../agent/prompt';

export type FoundItem = { item: Item; text: string };

export type Findings = {
  // What Commander says the Skill did, in its own words: never any words from outside.
  note: string;
  items: FoundItem[];
  more: PromptData[];
  // The Update given (null: nothing was queued). Only the Update Skill sets it.
  update?: UpdateView | null;
  // What an action Skill handed the gate (#196), by proposal: shown under the answer as cards.
  proposalIds?: number[];
};

// The kinds of Item each of Find's kinds means.
export const KINDS_OF: Record<FindKind, ItemKind[]> = {
  email: ['email'],
  event: ['event'],
  todo: ['todo'],
  note: ['block', 'daily-note'],
  linear: ['linear-issue'],
  github: ['pull-request', 'review-request', 'github-issue', 'github-release'],
  chat: ['chat', 'channel-post'],
};

// Ares's own Items are found where they belong (with their meeting, in the GitHub Section), never alone.
const NEVER_FOUND: readonly ItemKind[] = ['meeting-prep', 'github-summary'];

/** Whether a Skill may hand this Item to the model: live, not one of Ares's own, mail he may read. */
export function findable(item: Item, mayRead: (item: Item) => boolean): boolean {
  return item.deletedAt === null && !NEVER_FOUND.includes(item.kind) && mayRead(item);
}

/**
 * When an Item happened, as far as "when" goes: an event's start, an email's sending, the middle of
 * the day an open Todo is due, else its last change.
 */
export function timeOf(item: Item): number {
  const detail = item.detail;
  if (detail?.kind === 'event') return detail.start.at;
  if (detail?.kind === 'email') return detail.sentAt;
  if (detail?.kind === 'todo' && detail.dueOn && item.status === 'open') {
    const [year, month, day] = detail.dueOn.split('-').map(Number) as [number, number, number];
    return new Date(year, month - 1, day, 12).getTime();
  }
  return item.updatedAt;
}

export type Range = { from: number; to: number; words: string };

const startOfDay = (at: number, days = 0) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

// Monday of the week `at` falls in, `weeks` on.
const startOfWeek = (at: number, weeks = 0) => {
  const date = new Date(at);
  const back = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back + weeks * 7).getTime();
};

/** The span of time Find's "when" means, on the User's local calendar: from inclusive, to exclusive. */
export function rangeOf(when: FindWhen, now: number): Range {
  const date = new Date(now);
  switch (when) {
    case 'today':
      return { from: startOfDay(now), to: startOfDay(now, 1), words: 'today' };
    case 'tomorrow':
      return { from: startOfDay(now, 1), to: startOfDay(now, 2), words: 'tomorrow' };
    case 'yesterday':
      return { from: startOfDay(now, -1), to: startOfDay(now), words: 'yesterday' };
    case 'this-week':
      return { from: startOfWeek(now), to: startOfWeek(now, 1), words: 'this week' };
    case 'last-week':
      return { from: startOfWeek(now, -1), to: startOfWeek(now), words: 'last week' };
    case 'next-week':
      return { from: startOfWeek(now, 1), to: startOfWeek(now, 2), words: 'next week' };
    case 'this-month':
      return {
        from: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
        to: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
        words: 'this month',
      };
  }
}

/**
 * How far back a summary goes: today, the last seven days, the current sprint (the Linear cycle under
 * way, given, else the last fourteen days), the last thirty days, or everything.
 */
export function summaryRangeOf(range: SummaryTargetRange, now: number, cycleStart: number | null): Range {
  switch (range) {
    case 'today':
      return { from: startOfDay(now), to: Number.POSITIVE_INFINITY, words: 'today' };
    case 'week':
      return { from: startOfDay(now, -6), to: Number.POSITIVE_INFINITY, words: 'the last seven days' };
    case 'sprint':
      return cycleStart !== null
        ? { from: cycleStart, to: Number.POSITIVE_INFINITY, words: 'this sprint (the current Linear cycle)' }
        : {
            from: startOfDay(now, -13),
            to: Number.POSITIVE_INFINITY,
            words: 'this sprint (the last fourteen days)',
          };
    case 'month':
      return { from: startOfDay(now, -29), to: Number.POSITIVE_INFINITY, words: 'the last thirty days' };
    case 'all':
      return { from: 0, to: Number.POSITIVE_INFINITY, words: 'all of it' };
  }
}
