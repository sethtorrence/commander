// Snooze in the Core (#135). Gmail's API has no snooze, so Commander keeps it: a snoozed thread's
// messages carry Commander's own `snooze` field (never sent to Gmail), and this brings the thread back
// when its time comes (Item store wakeSnoozed: top of the inbox, the latest message unread, "Snoozed
// until"). It looks at start-up, so a time that passed while Commander was closed comes back then, and
// after that on a timer set for the next snooze (looking again at least every minute, so a machine
// that slept or a clock that jumped is caught up). Snoozing therefore needs Commander running, the
// window or the tray, to return mail on time; the snooze picker says so.
import type { CoreMessage } from '@commander/domain';
import type { ItemStore } from '../item-store';

// The longest the timer waits before looking again.
export const LOOK_AGAIN_MS = 60_000;

export type SnoozeOptions = {
  store: ItemStore;
  send(message: CoreMessage): void;
  now?: () => number;
  // Off in tests, which tick by hand.
  timers?: boolean;
  // Sets a timer; returns the function that clears it (tests stand in for setTimeout).
  setTimer?: (ms: number, run: () => void) => () => void;
  // The end-to-end tests may move the snooze clock on (`snooze-test-clock`).
  testHooks?: boolean;
};

export type Snooze = {
  // Brings back every thread whose snooze is due now.
  tick(): void;
  // A snooze was set, changed or undone: look again when the next one is due.
  changed(): void;
  // The end-to-end tests' clock hook. Returns whether the message was its own.
  handle(data: unknown): boolean;
  stop(): void;
};

const defaultTimer = (ms: number, run: () => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function setUpSnooze(options: SnoozeOptions): Snooze {
  const { store, send } = options;
  const baseNow = options.now ?? Date.now;
  let offset = 0;
  const now = () => baseNow() + offset;
  const setTimer = options.timers === false ? null : (options.setTimer ?? defaultTimer);
  let clear: (() => void) | null = null;
  let stopped = false;

  function tick() {
    let itemIds: string[] = [];
    try {
      itemIds = store.wakeSnoozed(now());
    } catch (error) {
      console.warn('Could not bring back snoozed mail:', error);
    }
    if (itemIds.length) send({ type: 'items-changed', itemIds });
  }

  function schedule() {
    clear?.();
    clear = null;
    if (!setTimer || stopped) return;
    const next = store.nextSnoozeAt();
    const wait = next === null ? LOOK_AGAIN_MS : Math.min(LOOK_AGAIN_MS, Math.max(0, next - now()));
    clear = setTimer(wait, () => {
      tick();
      schedule();
    });
  }

  tick();
  schedule();

  return {
    tick,
    changed: schedule,
    handle(data) {
      const message = data as { type?: unknown; offsetMs?: unknown };
      if (!options.testHooks || message?.type !== 'snooze-test-clock' || typeof message.offsetMs !== 'number')
        return false;
      offset += message.offsetMs;
      tick();
      schedule();
      return true;
    },
    stop() {
      stopped = true;
      clear?.();
      clear = null;
    },
  };
}
