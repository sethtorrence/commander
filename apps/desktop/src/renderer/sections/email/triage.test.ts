import {
  type Bucket,
  type EmailThreadSummary,
  type Item,
  NEEDS_REPLY,
  STARTER_BUCKETS,
} from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  atEnd,
  back,
  currentThread,
  decide,
  nextBucket,
  skip,
  startWalk,
  triagePosition,
  triageSummary,
  undecide,
} from './triage';
import { threadId } from './use-email';

// Triage's walk (#140): one Bucket's threads as they were when it started, decisions moving on to the
// next undecided thread, skip and back, Undo returning to its thread, the end's summary and the next
// Bucket in the User's order.

const thread = (key: string): EmailThreadSummary => ({
  account: 'google:alex',
  threadKey: key,
  subject: key,
  senders: ['Dana'],
  snippet: '',
  latestAt: 0,
  messageCount: 1,
  unreadCount: 0,
  hasAttachments: false,
  latest: { id: `item-${key}` } as Item,
  itemIds: [`item-${key}`],
});

const keyOf = (walk: ReturnType<typeof startWalk>) => currentThread(walk)?.threadKey ?? 'end';
const id = (key: string) => threadId(thread(key));

const buckets: Bucket[] = STARTER_BUCKETS.map((each, order) => ({
  ...each,
  order,
  createdAt: 0,
  skipInbox: false,
}));

describe('the Triage walk', () => {
  it('shows one thread at a time, and a decision moves on to the next', () => {
    let walk = startWalk(NEEDS_REPLY, ['a', 'b', 'c'].map(thread));
    expect(keyOf(walk)).toBe('a');
    expect(triagePosition('Needs reply', walk)).toBe('Needs reply · 1 of 3');

    walk = decide(walk, 'archived');
    expect(keyOf(walk)).toBe('b');
    expect(triagePosition('Needs reply', walk)).toBe('Needs reply · 2 of 3');
    walk = decide(decide(walk, 'replied'), 'snoozed');
    expect(atEnd(walk)).toBe(true);
    expect(currentThread(walk)).toBeNull();
    expect(triagePosition('Needs reply', walk)).toBe('Needs reply · 3 of 3');
  });

  it('skips with j, goes back with k, and a decision moves on past the threads already decided', () => {
    let walk = startWalk(NEEDS_REPLY, ['a', 'b', 'c', 'd'].map(thread));
    walk = skip(walk);
    walk = decide(walk, 'archived'); // b
    walk = decide(walk, 'todo'); // c
    expect(keyOf(walk)).toBe('d');
    walk = back(back(back(walk)));
    expect(keyOf(walk)).toBe('a');
    walk = back(walk);
    expect(keyOf(walk)).toBe('a');

    walk = decide(walk, 'moved');
    expect(keyOf(walk)).toBe('d');
    walk = skip(skip(walk));
    expect(atEnd(walk)).toBe(true);
    expect(keyOf(back(walk))).toBe('d');
  });

  it('keeps a decision that arrives after the User moved on, without moving them', () => {
    let walk = startWalk(NEEDS_REPLY, ['a', 'b', 'c'].map(thread));
    walk = skip(walk);
    walk = decide(walk, 'archived', id('a'));
    expect(keyOf(walk)).toBe('b');
    expect(walk.outcomes.get(id('a'))).toBe('archived');
    expect(decide(walk, 'archived', id('elsewhere'))).toBe(walk);
  });

  it('undoing a decision forgets it and goes back to its thread', () => {
    let walk = startWalk(NEEDS_REPLY, ['a', 'b', 'c'].map(thread));
    walk = decide(decide(walk, 'archived'), 'snoozed');
    expect(keyOf(walk)).toBe('c');

    walk = undecide(walk, id('a'), null);
    expect(keyOf(walk)).toBe('a');
    expect(walk.outcomes.has(id('a'))).toBe(false);
    expect(walk.outcomes.get(id('b'))).toBe('snoozed');

    // Decided again after going back: undoing that brings back the first decision.
    walk = decide(walk, 'filed');
    walk = undecide(walk, id('a'), 'archived');
    expect(walk.outcomes.get(id('a'))).toBe('archived');
  });

  it('sums up what was done at the end, and what was skipped', () => {
    let walk = startWalk(NEEDS_REPLY, ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(thread));
    for (const outcome of ['replied', 'archived', 'replied', 'snoozed', 'todo', 'moved'] as const)
      walk = decide(walk, outcome);
    walk = skip(walk);
    expect(triageSummary(walk)).toEqual({
      done: '6 done: 2 replied, 1 archived, 1 snoozed, 1 Todo, 1 moved',
      skipped: 1,
    });

    let todos = startWalk(NEEDS_REPLY, ['a', 'b', 'c'].map(thread));
    todos = decide(decide(decide(todos, 'todo'), 'todo'), 'filed');
    expect(triageSummary(todos).done).toBe('3 done: 2 Todos, 1 filed');
    expect(triageSummary(startWalk(NEEDS_REPLY, [thread('a')]))).toEqual({ done: '0 done', skipped: 1 });
  });

  it('offers the next Bucket with threads in the User’s order, skipping empty ones, never one before', () => {
    const counts = new Map([
      ['needs-reply', 3],
      ['fyi', 7],
      ['receipts', 2],
    ]);
    expect(nextBucket(buckets, NEEDS_REPLY, counts)).toMatchObject({ bucket: { name: 'FYI' }, threads: 7 });
    expect(nextBucket(buckets, 'fyi', counts)).toMatchObject({ bucket: { name: 'Receipts' }, threads: 2 });
    expect(nextBucket(buckets, 'receipts', counts)).toBeNull();
    expect(nextBucket(buckets, NEEDS_REPLY, new Map([['waiting-on-others', 4]]))?.bucket.name).toBe(
      'Waiting on others',
    );

    // Needs reply comes first wherever the User put it.
    const moved = [...buckets.filter((each) => each.id !== NEEDS_REPLY), ...buckets.slice(0, 1)];
    expect(nextBucket(moved, NEEDS_REPLY, counts)?.bucket.name).toBe('FYI');
  });
});
