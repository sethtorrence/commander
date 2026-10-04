import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createPresence } from './presence';

// Whether the User is at the machine, from what the main process reports of powerMonitor, on an
// injectable clock and a real Item store (so it carries across restarts).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
let dir: string;
let clock: number;
let store: ItemStore;

function open() {
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-presence-'));
  clock = new Date(2026, 9, 3, 9, 0).getTime();
  open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const presenceOn = (events: string[] = []) =>
  createPresence({
    store: store.updates,
    now: () => clock,
    onReturn: () => events.push('returned'),
    onLeave: () => events.push('left'),
  });

describe('presence', () => {
  it('counts the User as here until the main process says otherwise', () => {
    const presence = presenceOn();
    expect(presence.current()).toEqual({ state: 'active', since: clock });
  });

  it('is active with input in the last 5 minutes, idle after that, and locked when the screen is', () => {
    const presence = presenceOn();
    const start = clock;
    clock += 10 * MINUTE;
    presence.report({ idleSeconds: 4 * 60, locked: false });
    expect(presence.current().state).toBe('active');

    clock += 2 * MINUTE;
    presence.report({ idleSeconds: 6 * 60, locked: false });
    expect(presence.current()).toEqual({ state: 'idle', since: clock - 6 * MINUTE });

    presence.report({ idleSeconds: 6 * 60, locked: true });
    expect(presence.current()).toEqual({ state: 'locked', since: clock - 6 * MINUTE });
    expect(start).toBeLessThan(clock);
  });

  it('is away after more than 8 hours with no activity, locked or not', () => {
    const presence = presenceOn();
    presence.report({ idleSeconds: 0, locked: false });
    const last = clock;
    clock += 8 * HOUR + MINUTE;
    presence.report({ idleSeconds: (8 * HOUR + MINUTE) / 1000, locked: true });
    expect(presence.current()).toEqual({ state: 'away', since: last });
  });

  it('says when the User leaves and comes back, and how long the longest stretch away was', () => {
    const events: string[] = [];
    const presence = presenceOn(events);
    presence.report({ idleSeconds: 0, locked: false });
    clock += 30 * MINUTE;
    presence.report({ idleSeconds: 0, locked: false });
    expect(presence.awayMs()).toBeLessThan(HOUR);

    clock += 10 * MINUTE;
    presence.report({ idleSeconds: 10 * 60, locked: true });
    clock += 9 * HOUR;
    presence.report({ idleSeconds: 2, locked: false });
    expect(events).toEqual(['left', 'returned']);
    expect(presence.current().state).toBe('active');
    expect(presence.awayMs()).toBeGreaterThan(9 * HOUR);
  });

  it('starts counting again once an Update is given', () => {
    const presence = presenceOn();
    presence.report({ idleSeconds: 0, locked: false });
    clock += 9 * HOUR;
    presence.report({ idleSeconds: 0, locked: false });
    expect(presence.awayMs()).toBe(9 * HOUR);
    presence.updateGiven();
    expect(presence.awayMs()).toBe(0);
  });

  it('remembers the User’s last input across restarts, so a night with Commander closed counts', () => {
    presenceOn().report({ idleSeconds: 0, locked: false });
    store.close();
    clock += 10 * HOUR;
    open();
    const presence = presenceOn();
    expect(presence.current().state).toBe('active');
    presence.report({ idleSeconds: 1, locked: false });
    expect(presence.awayMs()).toBe(10 * HOUR - 1000);
  });
});
