// Keeps the Core running (#200). The main process starts it, watches it (its exit, and the heartbeat
// it sends every second), and starts a new one when it stops unexpectedly, waiting longer after each
// stop in a row; after several in a short time it stops trying until the User asks (Try again).
// While the Core is down, requests fail at once with a plain reason (CORE_DOWN) instead of timing out.
// Quitting never starts a new Core: stopCoreOnQuit (lifecycle.ts) stops it through `kill`.
//
// A Core that can't open the database (#203: it is damaged, or this version couldn't update it) is
// not restarted: starting it again would fail the same way. It stays up in its limited state, beating,
// and says so (`database-health`, handed here through setDatabase); the status carries it to the
// window, which shows the recovery screen. Meanwhile every request fails at once with
// DATABASE_UNAVAILABLE, except the recovery screen's own (`inRecovery`).
//
// Every start, stop and restart goes in the log (#207), with why it stopped and what happens next.
//
// Nothing is lost in a restart: sync, held sends (the outgoing queue, which never sends twice: a send
// whose outcome isn't known is checked at the Source first), Conversations and Ares's jobs live in the
// database, and the new Core carries on from it. Main re-sends what the Core only hears from it (the
// Accounts to sync, the machine's state, the User's presence) through onStarted.
import { type DatabaseHealth, needsRecovery } from '@commander/domain';
import { CORE_DOWN, type CoreStatus, type CoreStop, DATABASE_UNAVAILABLE } from '@commander/domain/ipc';

// What the supervisor needs of Electron's UtilityProcess.
export type CoreProcess = {
  readonly pid?: number | undefined;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
};

export type CoreDown = { ok: false; error: string };

// The wait before each new Core after a stop: the first stop in a while, the second in a row, the
// third. One more within CRASH_WINDOW_MS of the first and Commander stops trying.
export const RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;
// Stops longer ago than this are forgotten, so a Core that has run a while starts again at once.
export const CRASH_WINDOW_MS = 10 * 60_000;

// The heartbeat: a new Core has FIRST_BEAT_MS to send its first (opening the database and migrating
// it comes first), then each may be missing for up to MISSING_BEAT_MS before the Core counts as
// stopped. Generous, so a Core busy for a moment (a large sync saved in one go) is never ended.
const FIRST_BEAT_MS = 60_000;
const MISSING_BEAT_MS = 15_000;
const CHECK_MS = 1_000;

/**
 * The restart policy: given when the Core stopped recently (oldest first) and that it stopped again
 * `now`, the stops to remember and how long to wait before starting a new one, or null to stop trying.
 */
export function nextRestart(
  stops: readonly number[],
  now: number,
  {
    delaysMs = RESTART_DELAYS_MS,
    windowMs = CRASH_WINDOW_MS,
  }: { delaysMs?: readonly number[]; windowMs?: number } = {},
): { stops: number[]; delayMs: number | null } {
  const recent = [...stops.filter((at) => now - at < windowMs), now];
  return { stops: recent, delayMs: delaysMs[recent.length - 1] ?? null };
}

export function createCoreSupervisor({
  fork,
  onMessage,
  onStarted = () => {},
  onStatus = () => {},
  delaysMs = RESTART_DELAYS_MS,
  windowMs = CRASH_WINDOW_MS,
  firstBeatMs = FIRST_BEAT_MS,
  missingBeatMs = MISSING_BEAT_MS,
  checkMs = CHECK_MS,
  now = Date.now,
  killHard = (pid) => process.kill(pid, 'SIGKILL'),
  log = () => {},
}: {
  fork: () => CoreProcess;
  // Every message from the running Core, heartbeats included.
  onMessage: (message: unknown) => void;
  // A new Core was started (`restarted`: after one stopped), before it answers anything: whatever it
  // needs from main goes now (its messages wait until it is ready for them).
  onStarted?: (restarted: boolean) => void;
  // The status changed.
  onStatus?: (status: CoreStatus) => void;
  delaysMs?: readonly number[];
  windowMs?: number;
  firstBeatMs?: number;
  missingBeatMs?: number;
  checkMs?: number;
  now?: () => number;
  // Ends a Core that stopped answering (it can't run its own SIGTERM handler while stuck).
  killHard?: (pid: number) => void;
  // Where starts, stops and restarts are told (the log, #207).
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}) {
  let current: CoreProcess | null = null;
  let state: CoreStatus['state'] = 'restarting';
  let restartAt: number | null = null;
  let restarts = 0;
  let lastStop: CoreStop | null = null;
  let database: DatabaseHealth | null = null;
  let stops: number[] = [];
  let quitting = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  // Resolves when the running Core stops, so requests it was answering fail at once; and when it says
  // it is in its limited state, so requests it will never answer do too.
  let stopped: Promise<void> = new Promise(() => {});
  let limited: Promise<void> = new Promise(() => {});
  let resolveLimited = () => {};
  const exitListeners = new Set<() => void>();

  const status = (): CoreStatus => ({ state, restartAt, restarts, lastStop, database });
  const setState = (next: CoreStatus['state'], at: number | null = null) => {
    state = next;
    restartAt = at;
    onStatus(status());
  };

  function start() {
    if (current || quitting) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const restarted = lastStop !== null;
    if (restarted) restarts += 1;
    const core = fork();
    current = core;
    log('info', restarted ? `Started a new Core (restart ${restarts})` : 'Started the Core');
    // The new Core's word on the database is still to come.
    database = null;
    let resolveStopped = () => {};
    stopped = new Promise((resolve) => {
      resolveStopped = resolve;
    });
    limited = new Promise((resolve) => {
      resolveLimited = resolve;
    });
    let beat = false;
    let unresponsive = false;
    let startedAt = now();
    let lastBeat = startedAt;
    let lastCheck = startedAt;
    core.on('message', (message) => {
      if (core !== current) return;
      if ((message as { type?: unknown } | null)?.type === 'heartbeat') {
        lastBeat = now();
        if (!beat) {
          beat = true;
          // A new Core is back once it beats: until then its requests would only wait.
          if (state !== 'running') setState('running');
        }
      }
      onMessage(message);
    });
    core.on('exit', (code) => {
      if (core !== current) return;
      current = null;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      resolveStopped();
      for (const listener of exitListeners) listener();
      if (quitting) return log('info', `The Core stopped (code ${code}), as Commander is quitting`);
      const at = now();
      lastStop = { at, reason: unresponsive ? 'unresponsive' : 'exited', code: unresponsive ? null : code };
      const next = nextRestart(stops, at, { delaysMs, windowMs });
      stops = next.stops;
      const why = unresponsive
        ? 'The Core stopped answering and was ended'
        : `The Core exited (code ${code})`;
      if (next.delayMs === null) {
        log(
          'error',
          `${why}; it stopped ${stops.length} times in ${Math.round(windowMs / 60_000)} minutes, so it won’t be started again until the User asks (Try again)`,
        );
        return setState('stopped');
      }
      const delay = next.delayMs;
      log('warn', `${why}; starting a new one in ${delay / 1000} s`);
      restartTimer = setTimeout(start, delay);
      setState('restarting', at + delay);
    });
    watchdog = setInterval(() => {
      const at = now();
      // The machine slept (this check was held up too): nothing could beat meanwhile.
      if (at - lastCheck > checkMs * 3) {
        startedAt = at;
        lastBeat = at;
      }
      lastCheck = at;
      const late = beat ? at - lastBeat > missingBeatMs : at - startedAt > firstBeatMs;
      if (!late || unresponsive) return;
      unresponsive = true;
      log(
        'warn',
        `The Core’s heartbeat went missing (${beat ? 'it stopped beating' : 'it never beat'}); ending it`,
      );
      if (core.pid) killHard(core.pid);
      else core.kill();
    }, checkMs);
    // The first Core serves requests as soon as it is started (they wait for it, as at launch); a new
    // one once it beats.
    setState(restarted ? 'restarting' : 'running');
    onStarted(restarted);
  }

  return {
    start,
    status,
    // The running Core's process id (the end-to-end tests stop it), or null while there is none.
    pid: () => current?.pid ?? null,

    // Posts to the running Core; false (and dropped) while there is none.
    send(message: unknown): boolean {
      if (!current) return false;
      current.postMessage(message);
      return true;
    },

    /**
     * Runs a request to the Core: at once with CORE_DOWN's reason while it is down, and with it too
     * if the Core stops before answering. While the Core is in its limited state (#203) only the
     * recovery screen's requests (`inRecovery`) run; the rest fail with DATABASE_UNAVAILABLE.
     */
    whileRunning<R>(run: () => Promise<R>, { inRecovery = false } = {}): Promise<R | CoreDown> {
      if (!current || state !== 'running')
        return Promise.resolve({
          ok: false,
          error: state === 'stopped' ? CORE_DOWN.stopped : CORE_DOWN.restarting,
        });
      const unavailable: CoreDown = { ok: false, error: DATABASE_UNAVAILABLE };
      if (needsRecovery(database) && !inRecovery) return Promise.resolve(unavailable);
      const answering = stopped.then((): CoreDown => ({ ok: false, error: CORE_DOWN.answering }));
      if (inRecovery) return Promise.race([run(), answering]);
      return Promise.race([run(), answering, limited.then(() => unavailable)]);
    },

    // The running Core's word on the database (#203): its limited state, a full disk, or all well.
    setDatabase(health: DatabaseHealth) {
      if (!current) return;
      database = health;
      if (needsRecovery(health)) resolveLimited();
      onStatus(status());
    },

    // Try again: Commander stopped retrying, and the User asks for a new Core now.
    tryAgain() {
      if (current || quitting) return;
      log('info', 'The User asked to start the Core again (Try again)');
      stops = [];
      start();
    },

    // For stopCoreOnQuit (lifecycle.ts): whether there is a Core to stop, hearing it exit, and
    // stopping it for good (Commander is quitting: no new Core after this).
    running: () => current !== null,
    on(_event: 'exit', listener: () => void) {
      exitListeners.add(listener);
    },
    kill(): boolean {
      quitting = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      return current?.kill() ?? false;
    },
    // Wipe all Commander data (#204): stops the Core for good, as quitting does (never a crash, and no
    // new one after it), and resolves once it has exited, ending it hard if it hasn't by `timeoutMs`.
    stopForGood(timeoutMs = 5_000): Promise<void> {
      log('info', 'Stopping the Core for good: Commander is wiping its data');
      quitting = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const core = current;
      if (!core) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (core.pid) killHard(core.pid);
          resolve();
        }, timeoutMs);
        exitListeners.add(function exited() {
          exitListeners.delete(exited);
          clearTimeout(timer);
          resolve();
        });
        core.kill();
      });
    },
    // Commander is quitting (before-quit): whatever stops now is never started again.
    quit() {
      quitting = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
    },
  };
}

export type CoreSupervisor = ReturnType<typeof createCoreSupervisor>;
