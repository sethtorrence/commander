import type { Bucket, EmailThreadSummary } from '@commander/domain';
import { stripOrder } from '../../buckets/buckets';
import { threadId } from './use-email';

/*
  Triage (#140, decision #16), as pure functions: a walk through one Bucket's inbox threads, one at a
  time, as they were when it started (the Account switcher's and the Project filter's), so "4 of 12"
  stays put while threads leave the Bucket. Each decision is kept against its thread; a decision moves
  on to the next thread not yet decided, skip (`j`) to the next and back (`k`) to the previous; undoing
  a decision forgets it and goes back to its thread. Past the last thread is the end: its summary, and
  the next Bucket with threads in the User's order.
*/

/** What the User decided for a thread. */
export type TriageOutcome = 'replied' | 'archived' | 'snoozed' | 'todo' | 'moved' | 'filed';

export interface TriageWalk {
  /** The Bucket walked. */
  bucketId: string;
  /** Its threads when the walk started, in the inbox's order (newest first). */
  threads: readonly EmailThreadSummary[];
  /** Where the walk is: a thread's index, or `threads.length` at the end. */
  at: number;
  /** What was decided for each thread so far, by thread id. */
  outcomes: ReadonlyMap<string, TriageOutcome>;
}

export function startWalk(bucketId: string, threads: readonly EmailThreadSummary[]): TriageWalk {
  return { bucketId, threads, at: 0, outcomes: new Map() };
}

/** The thread shown, or null at the end. */
export const currentThread = (walk: TriageWalk): EmailThreadSummary | null => walk.threads[walk.at] ?? null;

export const atEnd = (walk: TriageWalk) => walk.at >= walk.threads.length;

/**
 * Keeps a decision for a thread (the one shown unless named) and, when it is the one shown, moves on
 * to the next thread not yet decided (or the end). One decided while the User had already moved
 * (its change was still on its way) leaves the walk where it is.
 */
export function decide(walk: TriageWalk, outcome: TriageOutcome, id?: string): TriageWalk {
  const shown = currentThread(walk);
  const decided = id ?? (shown ? threadId(shown) : null);
  if (!decided || !walk.threads.some((thread) => threadId(thread) === decided)) return walk;
  const outcomes = new Map(walk.outcomes).set(decided, outcome);
  if (!shown || threadId(shown) !== decided) return { ...walk, outcomes };
  let at = walk.at + 1;
  while (at < walk.threads.length && outcomes.has(threadId(walk.threads[at] as EmailThreadSummary))) at += 1;
  return { ...walk, outcomes, at };
}

/** Skip (`j`, Space): on to the next thread, decided or not, or the end. */
export const skip = (walk: TriageWalk): TriageWalk => ({
  ...walk,
  at: Math.min(walk.threads.length, walk.at + 1),
});

/** Back (`k`): the previous thread (from the end, the last). */
export const back = (walk: TriageWalk): TriageWalk => ({ ...walk, at: Math.max(0, walk.at - 1) });

/**
 * A decision undone: the thread's outcome goes back to what it was before it (`before`, none when
 * it had none), and the walk goes back to that thread.
 */
export function undecide(walk: TriageWalk, id: string, before: TriageOutcome | null): TriageWalk {
  const index = walk.threads.findIndex((thread) => threadId(thread) === id);
  if (index === -1) return walk;
  const outcomes = new Map(walk.outcomes);
  if (before) outcomes.set(id, before);
  else outcomes.delete(id);
  return { ...walk, outcomes, at: index };
}

/** Where the User is: "Needs reply · 4 of 12". */
export function triagePosition(bucketName: string, walk: TriageWalk): string {
  const total = walk.threads.length;
  return `${bucketName} · ${Math.min(walk.at + 1, total)} of ${total}`;
}

const PARTS: { outcome: TriageOutcome; say: (n: number) => string }[] = [
  { outcome: 'replied', say: (n) => `${n} replied` },
  { outcome: 'archived', say: (n) => `${n} archived` },
  { outcome: 'snoozed', say: (n) => `${n} snoozed` },
  { outcome: 'todo', say: (n) => `${n} ${n === 1 ? 'Todo' : 'Todos'}` },
  { outcome: 'moved', say: (n) => `${n} moved` },
  { outcome: 'filed', say: (n) => `${n} filed` },
];

/** The end's summary: "12 done: 5 replied, 4 archived, 2 snoozed, 1 Todo", and how many were skipped. */
export function triageSummary(walk: TriageWalk): { done: string; skipped: number } {
  const counts = new Map<TriageOutcome, number>();
  for (const outcome of walk.outcomes.values()) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const parts = PARTS.flatMap(({ outcome, say }) => {
    const n = counts.get(outcome) ?? 0;
    return n ? [say(n)] : [];
  });
  const done = walk.outcomes.size;
  return {
    done: parts.length ? `${done} done: ${parts.join(', ')}` : '0 done',
    skipped: walk.threads.length - done,
  };
}

/** What a decided thread's header says: "Archived". */
export const OUTCOME_LABELS: Record<TriageOutcome, string> = {
  replied: 'Replied',
  archived: 'Archived',
  snoozed: 'Snoozed',
  todo: 'Made a Todo',
  moved: 'Moved',
  filed: 'Project set',
};

/**
 * The Bucket the end offers next: the first after this one, in the Email Section's order (Needs reply,
 * then the User's), with threads in `counts`; null when none has.
 */
export function nextBucket(
  buckets: readonly Bucket[],
  after: string,
  counts: ReadonlyMap<string, number>,
): { bucket: Bucket; threads: number } | null {
  const order = stripOrder(buckets);
  const from = order.findIndex((bucket) => bucket.id === after);
  for (const bucket of order.slice(from + 1)) {
    const threads = counts.get(bucket.id) ?? 0;
    if (threads > 0) return { bucket, threads };
  }
  return null;
}
