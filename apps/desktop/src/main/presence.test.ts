import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PresenceMonitor, watchPresence } from './presence';

// The main process's half of presence: what powerMonitor says, reported to the Core every few
// seconds and at once on lock, unlock, sleep and wake.

class FakeMonitor extends EventEmitter implements PresenceMonitor {
  idle = 0;
  state: 'active' | 'idle' | 'locked' | 'unknown' = 'active';
  getSystemIdleTime = () => this.idle;
  getSystemIdleState = () => this.state;
}

let monitor: FakeMonitor;
let sent: unknown[];
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  monitor = new FakeMonitor();
  sent = [];
  stop = watchPresence({ monitor, send: (message) => sent.push(message), intervalMs: 15_000 });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('watchPresence', () => {
  it('reports the idle time and lock state at once, then every interval', () => {
    expect(sent).toEqual([{ type: 'presence-report', idleSeconds: 0, locked: false }]);
    monitor.idle = 20;
    vi.advanceTimersByTime(15_000);
    expect(sent.at(-1)).toEqual({ type: 'presence-report', idleSeconds: 20, locked: false });
  });

  it('reports a lock at once, and the screen still locked when powerMonitor says so', () => {
    monitor.emit('lock-screen');
    expect(sent.at(-1)).toEqual({ type: 'presence-report', idleSeconds: 0, locked: true });
    monitor.emit('unlock-screen');
    expect(sent.at(-1)).toEqual({ type: 'presence-report', idleSeconds: 0, locked: false });
    monitor.state = 'locked';
    vi.advanceTimersByTime(15_000);
    expect(sent.at(-1)).toMatchObject({ locked: true });
  });

  it('counts a sleeping machine as locked until it wakes', () => {
    monitor.emit('suspend');
    expect(sent.at(-1)).toMatchObject({ locked: true });
    vi.advanceTimersByTime(15_000);
    expect(sent.at(-1)).toMatchObject({ locked: true });
    monitor.emit('resume');
    expect(sent.at(-1)).toMatchObject({ locked: false });
  });

  it('stops listening when stopped', () => {
    stop();
    const count = sent.length;
    monitor.emit('lock-screen');
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(count);
    expect(monitor.listenerCount('lock-screen')).toBe(0);
  });
});
