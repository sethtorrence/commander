// Outlook's limit of 4 requests at once per app per mailbox (decision #3), kept across both Outlook
// Sources of an Account: its mail (#136) and its calendar run their syncs, writes and the
// reader's part fetches through the same gate, keyed by the Account (both Sources share its id). A
// JSON batch of several requests holds as many places as it carries, since Graph runs them side by
// side against the mailbox.

export const MAILBOX_CONCURRENCY = 4;

export type Gate = <T>(task: () => Promise<T>, weight?: number) => Promise<T>;

/** Lets tasks run while their weights add up to no more than `size`; the rest wait their turn, in order. */
export function gate(size: number): Gate {
  let used = 0;
  const waiting: { weight: number; go: () => void }[] = [];
  const next = () => {
    while (waiting.length) {
      const first = waiting[0] as { weight: number; go: () => void };
      if (used + first.weight > size) return;
      waiting.shift();
      used += first.weight;
      first.go();
    }
  };
  return async function run<T>(task: () => Promise<T>, weight = 1): Promise<T> {
    const need = Math.max(1, Math.min(size, weight));
    if (used + need <= size && waiting.length === 0) used += need;
    else await new Promise<void>((go) => waiting.push({ weight: need, go }));
    try {
      return await task();
    } finally {
      used -= need;
      next();
    }
  };
}

const gates = new Map<string, Gate>();

/** The Account's mailbox gate, shared by every Outlook Source of the Account in this process. */
export function mailboxGate(account: string): Gate {
  let found = gates.get(account);
  if (!found) {
    found = gate(MAILBOX_CONCURRENCY);
    gates.set(account, found);
  }
  return found;
}
