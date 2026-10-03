import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ItemStore, openItemStore } from '@commander/core/src/item-store';
import { answerItemStoreRequest } from '@commander/core/src/item-store-requests';
import type { ItemChanges } from './changes';
import type { ItemStoreClient } from './client';

// For tests only: a real Item store on a temporary database, and a client that reaches it through
// the same request handling the Core uses for the window, so every action is recorded as the User's.
// `changes` hears which Items each change touched, as the window hears it from the Core.
export function openTestItemStore(now?: () => number): {
  store: ItemStore;
  client: ItemStoreClient;
  changes: ItemChanges;
  close: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'commander-item-store-'));
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../../../core/drizzle'),
    now,
  });
  const listeners = new Set<(itemIds: string[]) => void>();
  const changes: ItemChanges = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  let id = 0;
  const client: ItemStoreClient = async (request) => {
    id += 1;
    let changed: string[] = [];
    const reply = answerItemStoreRequest(store, { type: 'item-store-request', id, request }, (ids) => {
      changed = ids;
    });
    if (changed.length) {
      const ids = changed;
      queueMicrotask(() => {
        for (const listener of listeners) listener(ids);
      });
    }
    if (!reply) throw new Error('No reply');
    if (!reply.response.ok) throw new Error(reply.response.error);
    // biome-ignore lint/suspicious/noExplicitAny: the Core's reply is unchecked here, as the main process would check it
    return reply.response.result as any;
  };
  return {
    store,
    client,
    changes,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
