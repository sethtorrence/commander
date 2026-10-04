import type { PresenceReport } from '@commander/domain';

// The main process's half of knowing whether the User is at the machine (#23, #70): powerMonitor's
// idle time and lock state, reported to the Core every few seconds and at once on lock, unlock,
// sleep and wake. The Core works out active, idle, locked or away from it. Only the status
// module's "You're here / away" and having the Update ready on return depend on it.

type PresenceEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume';

// What it needs of Electron's powerMonitor.
export interface PresenceMonitor {
  getSystemIdleTime(): number;
  getSystemIdleState(idleThreshold: number): string;
  on(event: PresenceEvent, listener: () => void): unknown;
  off(event: PresenceEvent, listener: () => void): unknown;
}

// powerMonitor counts the screen as locked by this threshold's measure too (seconds).
const IDLE_THRESHOLD_S = 5 * 60;

export function watchPresence({
  monitor,
  send,
  intervalMs = 15_000,
}: {
  monitor: PresenceMonitor;
  send: (report: PresenceReport) => void;
  intervalMs?: number;
}): () => void {
  let lockedScreen = false;
  let asleep = false;

  const report = () =>
    send({
      type: 'presence-report',
      idleSeconds: monitor.getSystemIdleTime(),
      locked: lockedScreen || asleep || monitor.getSystemIdleState(IDLE_THRESHOLD_S) === 'locked',
    });

  const listeners: Record<PresenceEvent, () => void> = {
    'lock-screen': () => {
      lockedScreen = true;
      report();
    },
    'unlock-screen': () => {
      lockedScreen = false;
      report();
    },
    suspend: () => {
      asleep = true;
      report();
    },
    resume: () => {
      asleep = false;
      report();
    },
  };
  const events = Object.keys(listeners) as PresenceEvent[];
  for (const event of events) monitor.on(event, listeners[event]);
  const timer = setInterval(report, intervalMs);
  report();

  return () => {
    clearInterval(timer);
    for (const event of events) monitor.off(event, listeners[event]);
  };
}

// The end-to-end tests drive the window with input the system never sees, so they stand in for
// powerMonitor with a User who is always at the machine (COMMANDER_TEST_PRESENCE=here).
export const alwaysHere: PresenceMonitor = {
  getSystemIdleTime: () => 0,
  getSystemIdleState: () => 'active',
  on: () => undefined,
  off: () => undefined,
};
