import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchSystemState } from './system-state';

// Syncing pauses while the machine sleeps or is offline: the main process watches Electron's
// powerMonitor and the network and tells the Core.

let power: EventEmitter;
let online: boolean;
let states: { awake: boolean; online: boolean }[];
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  power = new EventEmitter();
  online = true;
  states = [];
  stop = watchSystemState({
    powerMonitor: power,
    isOnline: () => online,
    onChange: (state) => states.push(state),
    pollMs: 10_000,
  });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('watching the machine for sync', () => {
  it('reports the state at once', () => {
    expect(states).toEqual([{ awake: true, online: true }]);
  });

  it('reports sleep and wake', () => {
    power.emit('suspend');
    power.emit('resume');

    expect(states.slice(1)).toEqual([
      { awake: false, online: true },
      { awake: true, online: true },
    ]);
  });

  it('notices going offline and coming back, and reports only changes', async () => {
    online = false;
    await vi.advanceTimersByTimeAsync(30_000);
    online = true;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(states.slice(1)).toEqual([
      { awake: true, online: false },
      { awake: true, online: true },
    ]);
  });

  it('stops watching', async () => {
    stop();
    power.emit('suspend');
    online = false;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(states).toHaveLength(1);
  });
});
