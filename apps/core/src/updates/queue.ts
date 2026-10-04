// Ares's queue (#23, #70): anything in Commander that wants to tell the User something enqueues it
// here, and it waits for the next Update the User asks for. Ares never interrupts.
//
// - Each line has a group (needs you now, waiting on your decision, for your information), the
//   Items it is about, a merge key and an optional expiry.
// - Lines with the same key merge while queued: "12 suggestions I wasn't sure about" is one line.
//   A line acted on takes in nothing more; the next with its key starts a new line.
// - A time-bound line expires once it stops mattering; a snoozed one comes back when its snooze is up.
// - Lines stay queued until the User acts on them (done, dismissed) or what they are about is
//   settled elsewhere (resolved).
import {
  type Enqueue,
  inUpdateOrder,
  type QueuedAbout,
  type QueuedLine,
  type SnoozeChoice,
  snoozedUntil,
} from '@commander/domain';
import type { UpdateStore } from '../item-store';

export type UpdateQueue = {
  enqueue(input: Enqueue): QueuedLine;
  // What is queued now (not acted on, not expired, not snoozed), in Update order.
  list(): QueuedLine[];
  count(): number;
  // Done or Dismiss take the line out of the queue; Snooze hides it until later today or tomorrow.
  act(id: number, action: 'done' | 'dismiss' | 'snooze', snooze?: SnoozeChoice): QueuedLine;
  // What the line is about was settled elsewhere: it leaves the queue.
  resolve(id: number): QueuedLine;
  // Changes what a queued line is about (fewer suggestions still waiting, say).
  revise(id: number, changes: Pick<QueuedLine, 'about' | 'itemIds'>): QueuedLine;
  line(id: number): QueuedLine | null;
};

const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];

// What a merged line is about: the suggestions and warnings of both, or the newer word otherwise.
function merged(was: QueuedAbout, next: QueuedAbout): QueuedAbout {
  if (was.kind === 'suggestions' && next.kind === 'suggestions') {
    return { ...next, proposalIds: union(was.proposalIds, next.proposalIds).sort((a, b) => a - b) };
  }
  if (was.kind === 'injection-warnings' && next.kind === 'injection-warnings') {
    return { ...next, entryIds: union(was.entryIds, next.entryIds).sort((a, b) => a - b) };
  }
  return next;
}

export function createUpdateQueue({
  store,
  now = Date.now,
  onChange,
}: {
  store: UpdateStore;
  now?: () => number;
  onChange?: () => void;
}): UpdateQueue {
  const changed = <T>(result: T): T => {
    onChange?.();
    return result;
  };

  function queued(id: number): QueuedLine {
    const line = store.line(id);
    if (!line) throw new Error(`No queued line ${id}`);
    if (line.status !== 'queued') throw new Error(`That line is no longer queued (${line.status})`);
    return line;
  }

  // Lines past their expiry are expired for good, so they never come back.
  function expire(at: number) {
    for (const line of store.lines(['queued'])) {
      if (line.expiresAt !== null && line.expiresAt <= at) {
        store.saveLine(line.id, { status: 'expired', settledAt: at });
      }
    }
  }

  function list(): QueuedLine[] {
    const at = now();
    expire(at);
    return inUpdateOrder(
      store.lines(['queued']).filter((line) => line.snoozedUntil === null || line.snoozedUntil <= at),
    );
  }

  return {
    enqueue(input) {
      const at = now();
      const importance = Math.min(1, Math.max(0, input.importance ?? 0.5));
      const was = store.queuedWithKey(input.mergeKey);
      if (was && (was.expiresAt === null || was.expiresAt > at)) {
        return changed(
          store.saveLine(was.id, {
            group: input.group,
            about: merged(was.about, input.about),
            itemIds: union(was.itemIds, input.itemIds),
            section: input.section,
            importance: Math.max(was.importance, importance),
            updatedAt: at,
            expiresAt: input.expiresAt ?? was.expiresAt,
          }),
        );
      }
      return changed(
        store.addLine({
          group: input.group,
          mergeKey: input.mergeKey,
          about: input.about,
          itemIds: [...new Set(input.itemIds)],
          section: input.section,
          importance,
          createdAt: at,
          updatedAt: at,
          expiresAt: input.expiresAt ?? null,
          snoozedUntil: null,
          status: 'queued',
          settledAt: null,
        }),
      );
    },

    list,
    count: () => list().length,

    act(id, action, snooze) {
      queued(id);
      const at = now();
      if (action === 'snooze') {
        return changed(store.saveLine(id, { snoozedUntil: snoozedUntil(snooze ?? 'later-today', at) }));
      }
      return changed(store.saveLine(id, { status: action === 'done' ? 'done' : 'dismissed', settledAt: at }));
    },

    resolve(id) {
      queued(id);
      return changed(store.saveLine(id, { status: 'resolved', settledAt: now() }));
    },

    revise(id, changes) {
      queued(id);
      return changed(store.saveLine(id, changes));
    },

    line: (id) => store.line(id),
  };
}
