import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Gate, openGate } from '@commander/core/src/autonomy/gate';
import { createOwnSettings } from '@commander/core/src/autonomy/own-settings';
import { answerAutonomyRequest } from '@commander/core/src/autonomy/requests';
import { type ItemStore, openItemStore } from '@commander/core/src/item-store';
import type { AutonomyClient } from './activity';

// For tests only: a real gate on a temporary database, and a client that reaches it through the
// same request handling the Core uses for the window.
export function openTestGate(): { store: ItemStore; gate: Gate; client: AutonomyClient; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'commander-ares-'));
  const store = openItemStore({
    path: join(dir, 'commander.db'),
    snapshotDir: join(dir, 'snapshots'),
    migrationsFolder: join(import.meta.dirname, '../../../../../core/drizzle'),
  });
  // Ares's own settings (#197), which a confirmed settings change writes.
  const ownSettings = createOwnSettings({
    itemStore: store,
    setLevel: (target, level) => gate.setLevel(target, level),
  });
  const gate: Gate = openGate({ itemStore: store, ownSettings });
  let id = 0;
  const client: AutonomyClient = async (request) => {
    id += 1;
    const reply = answerAutonomyRequest(
      gate,
      { type: 'autonomy-request', id, request },
      { testHooks: false },
    );
    if (!reply) throw new Error('No reply');
    if (!reply.response.ok) throw new Error(reply.response.error);
    // biome-ignore lint/suspicious/noExplicitAny: the Core's reply is unchecked here, as the main process would check it
    return reply.response.result as any;
  };
  return {
    store,
    gate,
    client,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
