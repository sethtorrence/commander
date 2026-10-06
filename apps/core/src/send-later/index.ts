// Send later in the Core (#139): the clock for the scheduled messages Commander sends itself (Gmail's,
// and personal Outlook.com's until Microsoft's hold is tested there; Outlook work Accounts' wait in
// Exchange's Outbox instead, and need nothing from here).
//
// - At a message's time, while Commander runs and the machine is awake, it is released into the
//   outgoing queue as an ordinary send, with no Undo hold (the User already chose when). Offline then,
//   it waits in the queue and goes when the connection returns: nothing was missed, so nothing is asked.
// - A time that passed while Commander was closed (found at start-up) or the machine asleep (found on
//   waking, or when the timer fires long after its time because the machine slept unnoticed) is
//   missed: never sent late by surprise. The message stays in Scheduled, marked missed, and Ares's
//   producers queue a Needs you now line ("Your email to Dana was due at 09:00. Send it now?").
//
// It looks at start-up, then on a timer set for the next time (looking again at least every minute),
// as Snooze does. The end-to-end tests may move its clock on (`send-later-test-clock`), or start with
// it moved (`offsetMs`), to play a time passing while Commander runs or while it was closed.
import type { ItemStore } from '../item-store';

// The longest the timer waits before looking again.
export const LOOK_AGAIN_MS = 60_000;
// How late Commander may be at a message's time and still count as running then (a busy moment, a
// timer firing a little late). Any later and the machine was asleep at its time: missed.
export const ON_TIME_MS = 2 * 60_000;

export type SendLaterOptions = {
  store: ItemStore;
  now?: () => number;
  // Off in tests, which tick by hand.
  timers?: boolean;
  // Sets a timer; returns the function that clears it (tests stand in for setTimeout).
  setTimer?: (ms: number, run: () => void) => () => void;
  // Messages sent or missed: open views read them again, and Ares's queue looks for a missed one.
  onChanged?: (itemIds: string[]) => void;
  // The end-to-end tests may move the clock on (`send-later-test-clock`), and start with it moved.
  testHooks?: boolean;
  offsetMs?: number;
  log?: (message: string) => void;
};

export type SendLater = {
  // Sends (or finds missed) every message due now. `missed`: anything due passed while Commander wasn't
  // running or the machine was asleep (start-up, waking).
  tick(options?: { missed?: boolean }): void;
  // A message was scheduled, rescheduled or taken back: look again when the next one is due.
  changed(): void;
  // The machine went to sleep or woke (powerMonitor, through the main process).
  systemState(state: { awake: boolean }): void;
  // The end-to-end tests' clock hook. Returns whether the message was its own.
  handle(data: unknown): boolean;
  stop(): void;
};

const defaultTimer = (ms: number, run: () => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function setUpSendLater(options: SendLaterOptions): SendLater {
  const { store } = options;
  const baseNow = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  let offset = options.testHooks ? (options.offsetMs ?? 0) : 0;
  const now = () => baseNow() + offset;
  const setTimer = options.timers === false ? null : (options.setTimer ?? defaultTimer);
  let clear: (() => void) | null = null;
  let awake = true;
  let stopped = false;

  function tick({ missed = false }: { missed?: boolean } = {}) {
    const at = now();
    const changed: string[] = [];
    for (const { itemId, scheduledAt } of store.compose.due(at)) {
      try {
        if (missed || !awake || at - scheduledAt > ON_TIME_MS) store.compose.miss(itemId, at);
        else
          store.compose.sendScheduled(
            itemId,
            { by: { kind: 'user' }, why: 'Sent at the time you chose' },
            'Sent at the time you chose',
          );
        changed.push(itemId);
      } catch (error) {
        // Never left due (the clock would look again at once, and again): the User is asked instead.
        log(`Send later couldn’t send ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
        try {
          store.compose.miss(itemId, at);
          changed.push(itemId);
        } catch {}
      }
    }
    if (changed.length) options.onChanged?.(changed);
  }

  function schedule() {
    clear?.();
    clear = null;
    if (!setTimer || stopped || !awake) return;
    const next = store.compose.nextDueAt();
    const wait = next === null ? LOOK_AGAIN_MS : Math.min(LOOK_AGAIN_MS, Math.max(0, next - now()));
    clear = setTimer(wait, () => {
      clear = null;
      tick();
      schedule();
    });
  }

  // Anything due already came due while Commander was closed.
  tick({ missed: true });
  schedule();

  return {
    tick,
    changed: schedule,
    systemState(state) {
      const wasAwake = awake;
      awake = state.awake;
      if (!awake) {
        clear?.();
        clear = null;
        return;
      }
      // Awake again: what came due while it slept was missed.
      if (!wasAwake) tick({ missed: true });
      schedule();
    },
    handle(data) {
      const message = data as { type?: unknown; offsetMs?: unknown };
      if (
        !options.testHooks ||
        message?.type !== 'send-later-test-clock' ||
        typeof message.offsetMs !== 'number'
      )
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
