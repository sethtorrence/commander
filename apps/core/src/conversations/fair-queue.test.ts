import { describe, expect, it } from 'vitest';
import { createFairQueue } from './fair-queue';

// A task that runs until the test lets it finish.
function gate() {
  let open: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the fair queue Conversations share a model through', () => {
  it('runs every Conversation at once on a cloud model', () => {
    const queue = createFairQueue({ capacity: () => Number.POSITIVE_INFINITY });
    const started: string[] = [];
    for (const key of ['a', 'b', 'c']) {
      queue.enqueue(key, () => {
        started.push(key);
        return gate().done;
      });
    }
    expect(started).toEqual(['a', 'b', 'c']);
    expect(queue.running()).toBe(3);
    expect(queue.waiting()).toBe(0);
  });

  it('starts a task at once when there is room, before enqueue returns', () => {
    const queue = createFairQueue({ capacity: () => 1 });
    let started = false;
    const ticket = queue.enqueue('a', async () => {
      started = true;
    });
    expect(started).toBe(true);
    expect(ticket.waiting()).toBe(false);
  });

  it('on a model on this machine, runs one at a time and takes turns between Conversations', async () => {
    const queue = createFairQueue({ capacity: () => 1 });
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const task = (name: string) => () => {
      order.push(name);
      const each = gate();
      gates.set(name, each);
      return each.done;
    };
    queue.enqueue('a', task('a1'));
    const a2 = queue.enqueue('a', task('a2'));
    queue.enqueue('a', task('a3'));
    const b1 = queue.enqueue('b', task('b1'));
    queue.enqueue('c', task('c1'));
    expect(order).toEqual(['a1']);
    expect(a2.waiting()).toBe(true);
    expect(b1.waiting()).toBe(true);
    expect(queue.waiting()).toBe(4);

    // One answer each in turn: b and c go before a's second, though a's was asked first.
    for (const name of ['a1', 'b1', 'c1', 'a2']) {
      gates.get(name)?.open();
      await settle();
    }
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
  });

  it('lets a waiting task be taken out, but not one that started', async () => {
    const queue = createFairQueue({ capacity: () => 1 });
    const first = gate();
    const order: string[] = [];
    const running = queue.enqueue('a', () => {
      order.push('a');
      return first.done;
    });
    const waiting = queue.enqueue('b', async () => {
      order.push('b');
    });
    queue.enqueue('c', async () => {
      order.push('c');
    });
    expect(waiting.cancel()).toBe(true);
    expect(waiting.cancel()).toBe(false);
    expect(running.cancel()).toBe(false);
    first.open();
    await settle();
    expect(order).toEqual(['a', 'c']);
  });

  it('frees the slot when a task fails', async () => {
    const queue = createFairQueue({ capacity: () => 1 });
    const order: string[] = [];
    queue.enqueue('a', async () => {
      order.push('a');
      throw new Error('the model fell over');
    });
    queue.enqueue('b', async () => {
      order.push('b');
    });
    await settle();
    expect(order).toEqual(['a', 'b']);
    expect(queue.running()).toBe(0);
  });

  it('reads its capacity each time: a model moved to the cloud lets the waiting ones go', async () => {
    let capacity = 1;
    const queue = createFairQueue({ capacity: () => capacity });
    const first = gate();
    const order: string[] = [];
    queue.enqueue('a', () => {
      order.push('a');
      return first.done;
    });
    queue.enqueue('b', () => {
      order.push('b');
      return gate().done;
    });
    expect(order).toEqual(['a']);
    capacity = Number.POSITIVE_INFINITY;
    queue.enqueue('c', () => {
      order.push('c');
      return gate().done;
    });
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
