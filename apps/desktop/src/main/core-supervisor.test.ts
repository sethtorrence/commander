import { EventEmitter } from 'node:events';
import {
  CORE_DOWN,
  type CoreStatus,
  DATABASE_UNAVAILABLE,
  type DatabaseRecovery,
  DISK_FULL,
  reachedNoCore,
  tryAgainLater,
} from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreSupervisor, nextRestart } from './core-supervisor';

describe('nextRestart', () => {
  it('waits longer after each stop in a row, then stops trying', () => {
    let stops: number[] = [];
    const delays: (number | null)[] = [];
    for (const at of [0, 10_000, 20_000, 30_000]) {
      const next = nextRestart(stops, at);
      stops = next.stops;
      delays.push(next.delayMs);
    }
    expect(delays).toEqual([1_000, 5_000, 30_000, null]);
  });

  it('forgets stops from longer ago, so a Core that ran a while starts again at once', () => {
    const next = nextRestart([0, 10_000, 20_000], 20_000 + 10 * 60_000);
    expect(next).toEqual({ stops: [20_000 + 10 * 60_000], delayMs: 1_000 });
    // One stop still recent: the second wait.
    expect(nextRestart([0, 9 * 60_000], 10 * 60_000 + 1).delayMs).toBe(5_000);
  });

  it('takes its own waits and window', () => {
    expect(nextRestart([], 0, { delaysMs: [100], windowMs: 1_000 }).delayMs).toBe(100);
    expect(nextRestart([0], 500, { delaysMs: [100], windowMs: 1_000 }).delayMs).toBeNull();
    expect(nextRestart([0], 1_000, { delaysMs: [100], windowMs: 1_000 }).delayMs).toBe(100);
  });
});

// A stand-in for the Core's utilityProcess.
class FakeCore extends EventEmitter {
  static pids = 100;
  pid = FakeCore.pids++;
  posted: unknown[] = [];
  killed = false;
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  kill() {
    this.killed = true;
    return true;
  }
  beat() {
    this.emit('message', { type: 'heartbeat', beats: 1, at: 1 });
  }
  exit(code = 1) {
    this.emit('exit', code);
  }
}

function supervise(options: Partial<Parameters<typeof createCoreSupervisor>[0]> = {}) {
  const cores: FakeCore[] = [];
  const statuses: CoreStatus[] = [];
  const started: boolean[] = [];
  const messages: unknown[] = [];
  const killedHard: number[] = [];
  const supervisor = createCoreSupervisor({
    fork: () => {
      const core = new FakeCore();
      cores.push(core);
      return core;
    },
    onMessage: (message) => messages.push(message),
    onStarted: (restarted) => started.push(restarted),
    onStatus: (status) => statuses.push(status),
    killHard: (pid) => {
      killedHard.push(pid);
      cores.find((core) => core.pid === pid)?.exit(137);
    },
    ...options,
  });
  supervisor.start();
  const latest = () => cores.at(-1) as FakeCore;
  return { supervisor, cores, statuses, started, messages, killedHard, latest };
}

describe('createCoreSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 6, 0, 0, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the Core, serves requests at once, and passes its messages on', async () => {
    const { supervisor, latest, started, messages } = supervise();
    expect(supervisor.status().state).toBe('running');
    expect(started).toEqual([false]);
    expect(supervisor.send({ type: 'hello' })).toBe(true);
    expect(latest().posted).toEqual([{ type: 'hello' }]);
    latest().emit('message', { type: 'items-changed', itemIds: ['a'] });
    expect(messages).toEqual([{ type: 'items-changed', itemIds: ['a'] }]);
    await expect(supervisor.whileRunning(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it('starts a new Core after the wait when it stops, and says so', async () => {
    const { supervisor, cores, latest, statuses, started } = supervise();
    latest().beat();
    latest().exit(1);

    expect(supervisor.status()).toEqual({
      state: 'restarting',
      restartAt: Date.now() + 1_000,
      restarts: 0,
      lastStop: { at: Date.now(), reason: 'exited', code: 1 },
      database: null,
    });
    expect(supervisor.send({ type: 'lost' })).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(cores).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cores).toHaveLength(2);
    expect(started).toEqual([false, true]);
    // Started, but not back until it beats.
    expect(supervisor.status().state).toBe('restarting');
    latest().beat();
    expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 1 });
    expect(statuses.map((status) => status.state)).toEqual([
      'running',
      'restarting',
      'restarting',
      'running',
    ]);
  });

  it('fails requests at once while the Core is down, and those it was answering when it stopped', async () => {
    const { supervisor, latest } = supervise();
    latest().beat();
    const answering = supervisor.whileRunning(() => new Promise(() => {}));
    latest().exit(1);
    await expect(answering).resolves.toEqual({ ok: false, error: CORE_DOWN.answering });
    const run = vi.fn(async () => ({ ok: true }));
    await expect(supervisor.whileRunning(run)).resolves.toEqual({ ok: false, error: CORE_DOWN.restarting });
    expect(run).not.toHaveBeenCalled();
    // Only those that never reached the Core can be made again.
    expect(reachedNoCore(new Error(CORE_DOWN.restarting))).toBe(true);
    expect(reachedNoCore(new Error(CORE_DOWN.answering))).toBe(false);
  });

  it('backs off after each stop in a row, then stops trying until Try again', async () => {
    const { supervisor, cores, latest } = supervise();
    for (const wait of [1_000, 5_000, 30_000]) {
      latest().beat();
      latest().exit(1);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(supervisor.status().state).toBe('restarting');
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(cores).toHaveLength(4);
    latest().exit(1);
    expect(supervisor.status()).toMatchObject({ state: 'stopped', restartAt: null, restarts: 3 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cores).toHaveLength(4);
    await expect(supervisor.whileRunning(async () => ({ ok: true }))).resolves.toEqual({
      ok: false,
      error: CORE_DOWN.stopped,
    });

    supervisor.tryAgain();
    expect(cores).toHaveLength(5);
    latest().beat();
    expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 4 });
    // A fresh start: the next stop waits the first wait again.
    latest().exit(1);
    expect(supervisor.status().restartAt).toBe(Date.now() + 1_000);
  });

  it('ends a Core whose heartbeat goes missing, and starts a new one', async () => {
    const { supervisor, latest, killedHard, cores } = supervise({ missingBeatMs: 5_000 });
    const first = latest();
    first.beat();
    for (let second = 0; second < 4; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      first.beat();
    }
    expect(killedHard).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(killedHard).toEqual([first.pid]);
    expect(supervisor.status().lastStop).toMatchObject({ reason: 'unresponsive', code: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cores).toHaveLength(2);
  });

  it('gives a new Core longer for its first heartbeat', async () => {
    const { latest, killedHard } = supervise({ firstBeatMs: 30_000, missingBeatMs: 5_000 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(killedHard).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(killedHard).toEqual([latest().pid]);
  });

  it('never counts the machine sleeping as a missing heartbeat', async () => {
    const { latest, killedHard } = supervise({ missingBeatMs: 5_000 });
    latest().beat();
    // Asleep for an hour: the clock jumps on, and the check is late too.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(killedHard).toEqual([]);
    latest().beat();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(killedHard).toEqual([]);
  });

  it('never starts a new Core once Commander is quitting', async () => {
    const { supervisor, cores, latest } = supervise();
    latest().beat();
    supervisor.quit();
    const exited = vi.fn();
    supervisor.on('exit', exited);
    expect(supervisor.kill()).toBe(true);
    latest().exit(0);
    expect(exited).toHaveBeenCalledOnce();
    expect(supervisor.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cores).toHaveLength(1);
  });

  it('never counts a deliberate stop (quitting to relaunch for a restore, #202) as a crash', async () => {
    const { supervisor, cores, latest, statuses } = supervise();
    latest().beat();
    const seen = statuses.length;
    supervisor.quit();
    supervisor.kill();
    latest().exit(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(supervisor.status()).toMatchObject({ state: 'running', lastStop: null, restarts: 0 });
    expect(statuses.slice(seen)).toEqual([]);
    expect(cores).toHaveLength(1);
  });

  it('drops a restart already waiting when Commander quits', async () => {
    const { supervisor, cores, latest } = supervise();
    latest().exit(1);
    supervisor.quit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cores).toHaveLength(1);
    supervisor.tryAgain();
    expect(cores).toHaveLength(1);
  });

  describe('a Core that can’t open the database (#203)', () => {
    const damaged: DatabaseRecovery = {
      state: 'damaged',
      problem: 'Tree 12 page 40: btreeInitPage() returns error code 11',
      snapshot: null,
      restoreFailed: null,
    };

    it('stays up in its limited state, never restarted, with the window told why', async () => {
      const { supervisor, cores, latest, statuses } = supervise({ missingBeatMs: 5_000 });
      expect(supervisor.status().database).toBeNull();
      latest().beat();
      supervisor.setDatabase(damaged);
      expect(supervisor.status()).toMatchObject({ state: 'running', database: damaged });
      expect(statuses.at(-1)?.database).toEqual(damaged);
      // It keeps beating, so it is never ended or started again.
      for (let second = 0; second < 60; second++) {
        await vi.advanceTimersByTimeAsync(1_000);
        latest().beat();
      }
      expect(cores).toHaveLength(1);
      expect(supervisor.status().state).toBe('running');
    });

    it('fails every request at once but the recovery screen’s, and those already waiting', async () => {
      const { supervisor, latest } = supervise();
      // Requests made as the window opens wait for the Core, which then says it can't open the database.
      const waiting = supervisor.whileRunning(() => new Promise(() => {}));
      latest().beat();
      supervisor.setDatabase(damaged);
      await expect(waiting).resolves.toEqual({ ok: false, error: DATABASE_UNAVAILABLE });

      const run = vi.fn(async () => ({ ok: true }));
      await expect(supervisor.whileRunning(run)).resolves.toEqual({ ok: false, error: DATABASE_UNAVAILABLE });
      expect(run).not.toHaveBeenCalled();
      await expect(supervisor.whileRunning(run, { inRecovery: true })).resolves.toEqual({ ok: true });
      // Not one to hold and make again: the recovery screen is all there is.
      expect(tryAgainLater(new Error(DATABASE_UNAVAILABLE))).toBe(false);
    });

    it('forgets the old Core’s word when a new one starts', async () => {
      const { supervisor, latest } = supervise();
      latest().beat();
      supervisor.setDatabase({ state: 'disk-full', since: Date.now() });
      expect(supervisor.status().database).toEqual({ state: 'disk-full', since: Date.now() });
      latest().exit(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(supervisor.status().database).toBeNull();
    });

    it('keeps a full disk in the status without holding requests back', async () => {
      const { supervisor, latest } = supervise();
      latest().beat();
      supervisor.setDatabase({ state: 'disk-full', since: Date.now() });
      await expect(supervisor.whileRunning(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
      // Saves refused for a full disk are held and made again, as those while the Core is down are.
      expect(tryAgainLater(new Error(DISK_FULL))).toBe(true);
      expect(tryAgainLater(new Error(CORE_DOWN.restarting))).toBe(true);
      expect(tryAgainLater(new Error('Invalid Block'))).toBe(false);
    });
  });

  it('tells the log each start, stop and restart, and why', async () => {
    const lines: string[] = [];
    const { supervisor, latest } = supervise({
      missingBeatMs: 5_000,
      log: (level, message) => lines.push(`${level} ${message}`),
    });
    latest().beat();
    latest().exit(3);
    await vi.advanceTimersByTimeAsync(1_000);
    latest().beat();
    await vi.advanceTimersByTimeAsync(7_000);
    await vi.advanceTimersByTimeAsync(5_000);
    latest().beat();
    latest().exit(1);
    await vi.advanceTimersByTimeAsync(30_000);
    latest().exit(1);
    supervisor.tryAgain();
    supervisor.kill();
    latest().exit(0);
    expect(lines).toEqual([
      'info Started the Core',
      'warn The Core exited (code 3); starting a new one in 1 s',
      'info Started a new Core (restart 1)',
      'warn The Core’s heartbeat went missing (it stopped beating); ending it',
      'warn The Core stopped answering and was ended; starting a new one in 5 s',
      'info Started a new Core (restart 2)',
      'warn The Core exited (code 1); starting a new one in 30 s',
      'info Started a new Core (restart 3)',
      'error The Core exited (code 1); it stopped 4 times in 10 minutes, so it won’t be started again until the User asks (Try again)',
      'info The User asked to start the Core again (Try again)',
      'info Started a new Core (restart 4)',
      'info The Core stopped (code 0), as Commander is quitting',
    ]);
  });

  it('stops the Core for good for a wipe: never taken for a crash, no new one, resolved once it exits', async () => {
    const { supervisor, cores, latest, statuses, killedHard } = supervise();
    latest().beat();
    let stopped = false;
    const stopping = supervisor.stopForGood().then(() => {
      stopped = true;
    });
    expect(latest().killed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    latest().exit(0);
    await stopping;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cores).toHaveLength(1);
    expect(statuses.at(-1)?.state).toBe('running');
    expect(supervisor.status().lastStop).toBeNull();
    expect(killedHard).toEqual([]);
    supervisor.tryAgain();
    expect(cores).toHaveLength(1);
  });

  it('ends a Core that doesn’t stop for a wipe hard, after the time given', async () => {
    const { supervisor, latest, killedHard } = supervise();
    const stopping = supervisor.stopForGood(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    expect(killedHard).toEqual([latest().pid]);
  });

  it('gives the end-to-end tests the running Core’s process id', () => {
    const { supervisor, latest } = supervise();
    expect(supervisor.pid()).toBe(latest().pid);
    latest().exit(1);
    expect(supervisor.pid()).toBeNull();
  });
});
