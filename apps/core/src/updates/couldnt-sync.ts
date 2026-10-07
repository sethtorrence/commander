// Changes that didn't reach a Source (#206), for the Update: one line per Account and Source ("2
// changes didn't reach Linear: moving ENG-418 to In Review…"), in the Needs you now group, with Retry.
//
// - A change that stops as Couldn't sync joins its Account's line, in words kept from its own data.
// - A change stays on the line while it is still queued (retried, it is on its way again), and leaves
//   once it has gone through or been discarded; a line with none left is resolved.
// - Dismissed (or Done) while its changes still couldn't sync, the line isn't queued again for them;
//   a change that stops later starts a new line.
// - Changes held after a restore (#202) say so: they may already be at the Source, so check there first.
import {
  changeWords,
  ITEM_KIND_OF_SOURCE,
  type QueuedAbout,
  type QueuedLine,
  type Source,
  type UpdateSection,
} from '@commander/domain';
import { HELD_AFTER_RESTORE } from '../backups/restore';
import type { ItemStore, OutgoingRow } from '../item-store';
import type { WatchedAccount } from './linear';
import type { UpdateQueue } from './queue';

type About = Extract<QueuedAbout, { kind: 'couldnt-sync' }>;

export const couldntSyncKey = (account: string, source: Source) => `couldnt-sync:${account}:${source}`;
const IMPORTANCE = 0.85;

const SECTION_OF_SOURCE: Record<Source, UpdateSection> = {
  linear: 'linear',
  gmail: 'email',
  outlook: 'email',
  'google-calendar': 'calendar',
  'outlook-calendar': 'calendar',
  teams: 'teams',
  github: 'github',
};

export function createCouldntSyncWatch({
  itemStore,
  queue,
  accounts,
}: {
  itemStore: ItemStore;
  queue: UpdateQueue;
  accounts?: () => readonly WatchedAccount[];
}) {
  const store = itemStore.updates;

  // A change as the line keeps it: its words, from its own data and the kind of Item it is on.
  function onLine(row: OutgoingRow): About['changes'][number] {
    const item = itemStore.get(row.itemId)?.item;
    const kind = item?.kind ?? ITEM_KIND_OF_SOURCE[row.source];
    const { what, verb, rest } = changeWords(row, { kind, source: row.source });
    return { id: row.id, itemId: row.itemId, what, verb, rest };
  }

  function about(account: string, source: Source, changes: About['changes'], rows: Map<number, OutgoingRow>) {
    const name = accounts?.().find((each) => each.account === account)?.name ?? null;
    const heldAfterRestore = changes.some((change) => rows.get(change.id)?.error === HELD_AFTER_RESTORE);
    return { kind: 'couldnt-sync', account, source, name, changes, heldAfterRestore } satisfies About;
  }

  const itemIdsOf = (changes: About['changes']) => [...new Set(changes.map((change) => change.itemId))];

  return {
    sweep() {
      const rows = new Map(itemStore.outgoing.rows().map((row) => [row.id, row]));
      // The changes that couldn't sync, by Account and Source.
      const failed = new Map<string, OutgoingRow[]>();
      for (const row of rows.values()) {
        if (row.status !== 'failed') continue;
        const key = couldntSyncKey(row.account, row.source);
        failed.set(key, [...(failed.get(key) ?? []), row]);
      }
      const lines = store
        .lines(['queued'])
        .filter((line): line is QueuedLine & { about: About } => line.about.kind === 'couldnt-sync');
      for (const line of lines) {
        const kept = line.about.changes.filter((change) => rows.has(change.id));
        const keptIds = new Set(kept.map((change) => change.id));
        const added = (failed.get(line.mergeKey) ?? []).filter((row) => !keptIds.has(row.id)).map(onLine);
        failed.delete(line.mergeKey);
        const changes = [...kept, ...added];
        if (!changes.length) {
          queue.resolve(line.id);
          continue;
        }
        const next = about(line.about.account, line.about.source, changes, rows);
        if (JSON.stringify(next) === JSON.stringify(line.about)) continue;
        queue.revise(line.id, { about: next, itemIds: itemIdsOf(changes) });
      }
      for (const [mergeKey, stopped] of failed) {
        const [first] = stopped;
        if (!first) continue;
        // Done or dismissed while they still couldn't sync: only changes that stopped since are new.
        const last = store.lastWithKey(mergeKey);
        const seen = new Set(
          last &&
            (last.status === 'done' || last.status === 'dismissed') &&
            last.about.kind === 'couldnt-sync'
            ? last.about.changes.map((change) => change.id)
            : [],
        );
        const changes = stopped.filter((row) => !seen.has(row.id)).map(onLine);
        if (!changes.length) continue;
        queue.enqueue({
          group: 'now',
          mergeKey,
          about: about(first.account, first.source, changes, rows),
          itemIds: itemIdsOf(changes),
          section: SECTION_OF_SOURCE[first.source],
          importance: IMPORTANCE,
        });
      }
    },
  };
}
