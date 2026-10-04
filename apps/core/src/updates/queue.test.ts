import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Enqueue } from '@commander/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemStore, openItemStore } from '../item-store';
import { createUpdateQueue, type UpdateQueue } from './queue';

// Ares's queue through its interface, over a real Item store in a temporary database.

const HOUR = 60 * 60_000;
let dir: string;
let clock: number;
let store: ItemStore;
let queue: UpdateQueue;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commander-queue-'));
  clock = new Date(2026, 9, 3, 10, 0).getTime();
  store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../drizzle'),
    now: () => clock,
  });
  queue = createUpdateQueue({ store: store.updates, now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const suggestions = (proposalIds: number[], itemIds: string[]): Enqueue => ({
  group: 'decision',
  mergeKey: 'suggestions:suggest-todos',
  about: {
    kind: 'suggestions',
    action: 'suggest-todos',
    name: 'Suggest Todos',
    actionKind: 'organise',
    proposalIds,
  },
  itemIds,
  section: 'notes',
  importance: 0.6,
});

const capWarning = (expiresAt: number | null = null): Enqueue => ({
  group: 'fyi',
  mergeKey: 'cap-warning:2026-10',
  about: { kind: 'cap-warning', month: '2026-10', spentUsd: 8.2, capUsd: 10 },
  itemIds: [],
  section: 'ares',
  importance: 0.5,
  expiresAt,
});

const prep: Enqueue = {
  group: 'now',
  mergeKey: 'chained:9',
  about: {
    kind: 'chained',
    action: 'suggest-todos',
    name: 'Suggest Todos',
    actionKind: 'organise',
    proposalId: 9,
  },
  itemIds: ['block-9'],
  section: 'notes',
  importance: 0.9,
};

describe('Ares’s queue', () => {
  it('lists what is queued by group: needs you now, then waiting on your decision, then for your information', () => {
    queue.enqueue(capWarning());
    queue.enqueue(suggestions([1], ['block-1']));
    queue.enqueue(prep);
    expect(queue.list().map((line) => line.group)).toEqual(['now', 'decision', 'fyi']);
    expect(queue.count()).toBe(3);
  });

  it('merges lines with the same key into one, with every Item and suggestion it is about', () => {
    const first = queue.enqueue(suggestions([1], ['block-1']));
    clock += 60_000;
    const merged = queue.enqueue(suggestions([2], ['block-2']));
    expect(merged.id).toBe(first.id);
    expect(merged.itemIds).toEqual(['block-1', 'block-2']);
    expect(merged.about).toMatchObject({ proposalIds: [1, 2] });
    expect(merged.updatedAt).toBe(clock);
    expect(queue.count()).toBe(1);
  });

  it('drops a time-bound line once it stops mattering', () => {
    queue.enqueue(capWarning(clock + HOUR));
    expect(queue.count()).toBe(1);
    clock += HOUR;
    expect(queue.list()).toEqual([]);
    expect(store.updates.lines(['expired'])).toHaveLength(1);
  });

  it('keeps lines queued until they are acted on: done and dismissed go, the rest stay', () => {
    const one = queue.enqueue(suggestions([1], ['block-1']));
    const two = queue.enqueue(capWarning());
    const three = queue.enqueue(prep);
    clock += 3 * HOUR;
    expect(queue.count()).toBe(3);

    expect(queue.act(one.id, 'done').status).toBe('done');
    expect(queue.act(two.id, 'dismiss').status).toBe('dismissed');
    expect(queue.list().map((line) => line.id)).toEqual([three.id]);
  });

  it('a line acted on never takes in new ones: the next with its key starts a line of its own', () => {
    const first = queue.enqueue(suggestions([1], ['block-1']));
    queue.act(first.id, 'done');
    const next = queue.enqueue(suggestions([2], ['block-2']));
    expect(next.id).not.toBe(first.id);
    expect(next.about).toMatchObject({ proposalIds: [2] });
  });

  it('snoozes a line until later today or tomorrow morning, then brings it back', () => {
    const line = queue.enqueue(suggestions([1], ['block-1']));
    queue.act(line.id, 'snooze', 'later-today');
    expect(queue.count()).toBe(0);
    clock += 3 * HOUR;
    expect(queue.list().map((each) => each.id)).toEqual([line.id]);

    queue.act(line.id, 'snooze', 'tomorrow');
    clock = new Date(2026, 9, 4, 8, 59).getTime();
    expect(queue.count()).toBe(0);
    clock = new Date(2026, 9, 4, 9, 0).getTime();
    expect(queue.count()).toBe(1);
  });

  it('refuses to act on a line that is no longer queued', () => {
    const line = queue.enqueue(capWarning());
    queue.act(line.id, 'done');
    expect(() => queue.act(line.id, 'dismiss')).toThrow(/no longer queued/);
    expect(() => queue.act(999, 'done')).toThrow(/No queued line 999/);
  });

  it('tells its listeners when the queue changes', () => {
    const heard: number[] = [];
    const watched = createUpdateQueue({
      store: store.updates,
      now: () => clock,
      onChange: () => heard.push(1),
    });
    const line = watched.enqueue(capWarning());
    watched.act(line.id, 'done');
    expect(heard).toHaveLength(2);
  });
});
