// Whether the User is at the machine (#23): the main process reports powerMonitor's idle time and
// lock state every few seconds, and this works out where they stand.
//
// - Active: unlocked, with input in the last 5 minutes. Idle: unlocked, no input for longer.
//   Locked: the screen is locked. Away: no activity for more than 8 hours, locked or not.
// - Until the first report the User counts as here (Commander was just started).
// - It keeps the longest stretch without activity since the last Update, across restarts (when the
//   User last did something is saved), so a night with Commander closed counts too: over 8 hours,
//   and the next Update leads with the most important things.
// - It drives only "You're here / away" and having the Update ready on return. It never draws the
//   User's attention.
import type { Presence, PresenceState } from '@commander/domain';
import type { UpdateStore } from '../item-store';

export const ACTIVE_WITHIN_MS = 5 * 60_000;
export const AWAY_AFTER_MS = 8 * 60 * 60_000;

export type PresenceModel = {
  report(report: { idleSeconds: number; locked: boolean }): void;
  current(): Presence;
  // The longest stretch without activity since the last Update (or ever, before the first).
  awayMs(): number;
  // An Update was given: the count starts again.
  updateGiven(): void;
};

export function createPresence({
  store,
  now = Date.now,
  onChange,
  onReturn,
  onLeave,
}: {
  store: Pick<UpdateStore, 'state' | 'saveState'>;
  now?: () => number;
  onChange?: (presence: Presence) => void;
  // The User came back after being idle, locked or away.
  onReturn?: () => void;
  // The User stopped being active.
  onLeave?: () => void;
}): PresenceModel {
  const started = now();
  let reported = false;
  let locked = false;
  // When the current active stretch began.
  let activeSince = started;
  let last: PresenceState = 'active';

  function stateAt(at: number): Presence {
    const lastInputAt = store.state().lastInputAt;
    if (!reported || lastInputAt === null) return { state: 'active', since: activeSince };
    const quiet = at - lastInputAt;
    if (quiet > AWAY_AFTER_MS) return { state: 'away', since: lastInputAt };
    if (locked) return { state: 'locked', since: lastInputAt };
    if (quiet >= ACTIVE_WITHIN_MS) return { state: 'idle', since: lastInputAt };
    return { state: 'active', since: activeSince };
  }

  return {
    report({ idleSeconds, locked: isLocked }) {
      const at = now();
      reported = true;
      locked = isLocked;
      const saved = store.state();
      if (!isLocked) {
        const inputAt = Math.round(at - idleSeconds * 1000);
        const previous = saved.lastInputAt;
        if (previous === null || inputAt > previous) {
          const gap = previous === null ? 0 : inputAt - previous;
          if (gap >= ACTIVE_WITHIN_MS) activeSince = inputAt;
          store.saveState({ lastInputAt: inputAt, longestGapMs: Math.max(saved.longestGapMs, gap) });
        }
      }
      const next = stateAt(at);
      if (next.state === last) return;
      const was = last;
      last = next.state;
      onChange?.(next);
      if (next.state === 'active') onReturn?.();
      else if (was === 'active') onLeave?.();
    },

    current: () => stateAt(now()),

    awayMs() {
      const { longestGapMs } = store.state();
      return longestGapMs;
    },

    updateGiven() {
      store.saveState({ longestGapMs: 0, lastGivenAt: now() });
    },
  };
}
