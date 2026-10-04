import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '.';

// Settings → Calendar's second time zone (#127), kept in the Item store's database so it survives
// restarts, beside the meeting heads-up.

let dir: string;
let store: ItemStore;
const open = () =>
  openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => 1_000,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-calendar-settings-'));
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the second time zone', () => {
  it('is unset until the User picks one', () => {
    expect(store.calendarSettings.read().secondTimeZone ?? null).toBeNull();
  });

  it('survives a restart, and is kept when only the heads-up changes', () => {
    store.calendarSettings.save({ headsUp: false, secondTimeZone: 'America/New_York' });
    store.close();
    store = open();
    expect(store.calendarSettings.read()).toEqual({ headsUp: false, secondTimeZone: 'America/New_York' });

    store.calendarSettings.save({ headsUp: true });
    expect(store.calendarSettings.read()).toEqual({ headsUp: true, secondTimeZone: 'America/New_York' });
  });

  it('is cleared with null', () => {
    store.calendarSettings.save({ headsUp: false, secondTimeZone: 'Asia/Kolkata' });
    store.calendarSettings.save({ headsUp: false, secondTimeZone: null });
    expect(store.calendarSettings.read().secondTimeZone ?? null).toBeNull();
  });

  it('refuses a name that is no time zone', () => {
    expect(() =>
      store.calendarSettings.save({ headsUp: false, secondTimeZone: 'Mars/Olympus_Mons' }),
    ).toThrow();
    expect(store.calendarSettings.read().secondTimeZone ?? null).toBeNull();
  });
});
