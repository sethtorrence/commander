// The fair queue Conversations share a model through (#191). A cloud model answers every
// Conversation at once; a model on this machine has room for one answer at a time, so Conversations
// take turns: whenever a slot frees, the Conversation served longest ago (or never) goes next, one
// answer each in turn, so a Conversation with several waiting never holds up another's.

export type QueueTicket = {
  // Takes a task out of the queue before it starts. False once it has started (or finished).
  cancel(): boolean;
  // Whether it is still waiting for a slot.
  waiting(): boolean;
};

export type FairQueue = {
  // Runs `task` once a slot is free and it is `key`'s turn. A task that starts at once starts before
  // this returns.
  enqueue(key: string, task: () => Promise<void>): QueueTicket;
  // How many tasks are running, and waiting.
  running(): number;
  waiting(): number;
};

type Entry = {
  key: string;
  task: () => Promise<void>;
  // The order tasks arrived in, which settles turns between keys never served.
  seq: number;
  state: 'waiting' | 'running' | 'done' | 'cancelled';
};

export function createFairQueue({
  capacity,
}: {
  // How many tasks may run at once, read whenever a slot might be taken (settings can change).
  capacity: () => number;
}): FairQueue {
  const waiting: Entry[] = [];
  // When each key last had a task started (a count of starts), for whose turn is next.
  const servedAt = new Map<string, number>();
  let starts = 0;
  let arrivals = 0;
  let runningCount = 0;

  // The waiting task whose key was served longest ago (never first), oldest first within a key.
  function next(): Entry | null {
    let best: Entry | null = null;
    for (const entry of waiting) {
      if (!best) best = entry;
      else {
        const turn = servedAt.get(entry.key) ?? -1;
        const bestTurn = servedAt.get(best.key) ?? -1;
        if (turn < bestTurn || (turn === bestTurn && entry.seq < best.seq)) best = entry;
      }
    }
    if (best) waiting.splice(waiting.indexOf(best), 1);
    return best;
  }

  function pump() {
    while (waiting.length && runningCount < Math.max(1, capacity())) {
      const entry = next();
      if (!entry) break;
      start(entry);
    }
  }

  function start(entry: Entry) {
    entry.state = 'running';
    runningCount += 1;
    servedAt.set(entry.key, starts++);
    const finish = () => {
      entry.state = 'done';
      runningCount -= 1;
      pump();
    };
    let ran: Promise<void>;
    try {
      ran = entry.task();
    } catch {
      ran = Promise.resolve();
    }
    ran.then(finish, finish);
  }

  return {
    enqueue(key, task) {
      const entry: Entry = { key, task, seq: arrivals++, state: 'waiting' };
      waiting.push(entry);
      pump();
      return {
        cancel() {
          if (entry.state !== 'waiting') return false;
          entry.state = 'cancelled';
          waiting.splice(waiting.indexOf(entry), 1);
          return true;
        },
        waiting: () => entry.state === 'waiting',
      };
    },
    running: () => runningCount,
    waiting: () => waiting.length,
  };
}
