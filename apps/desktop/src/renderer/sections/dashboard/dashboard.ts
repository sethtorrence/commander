import type { ActivityEntry, Item } from '@commander/domain';
import type { AccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import type { LinearAccountsClient } from '../linear/linear-issues';
import type { Clears } from './feed';

/*
  The Dashboard's view of the app: everything it reads or changes goes through here, so components
  never build requests themselves. It reads the open Items a Ranker looks at from the Item store, and
  who the User is in each Linear Account from the Accounts; it ticks Todos and undoes. Reached only
  through the window's bridge, so every change is the User's.
*/

export interface DashboardClient {
  /** The open Items the Dashboard ranks: open Todos and open Linear issues, not deleted. */
  items(): Promise<Item[]>;
  /** The Linear Accounts, each with who the User is there (for "assigned to me") and its syncing. */
  accounts: LinearAccountsClient;
  /** Ticks a Todo (done) or unticks it. */
  setDone(itemId: string, done: boolean): Promise<ActivityEntry>;
  /** Reverses what an activity entry changed. */
  undo(entryId: number): Promise<ActivityEntry>;
  /** What today's Daily Note holds so far: its top Blocks' text, in order, or null with none yet. */
  dailyNote(day: string): Promise<string[] | null>;
}

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

export function dashboardIn(itemStore: ItemStoreClient, accounts: LinearAccountsClient): DashboardClient {
  return {
    async items() {
      const [todos, issues] = await Promise.all([
        itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['open'], limit: MOST } }),
        itemStore({ op: 'query', query: { kinds: ['linear-issue'], statuses: ['open'], limit: MOST } }),
      ]);
      return [...todos, ...issues];
    },

    accounts,

    setDone(itemId, done) {
      return itemStore({
        op: 'record',
        action: { type: 'update', itemId, changes: { status: done ? 'done' : 'open' } },
      });
    },

    undo(entryId) {
      return itemStore({ op: 'record', action: { type: 'undo', entryId } });
    },

    async dailyNote(day) {
      const { notes } = await itemStore({ op: 'daily-notes', query: { from: day, to: day, limit: 1 } });
      const note = notes[0];
      if (!note) return null;
      const blocks = await itemStore({ op: 'blocks', dailyNoteIds: [note.item.id] });
      return blocks
        .flatMap((block) =>
          block.detail?.kind === 'block' && block.detail.parentId === null ? [block.detail] : [],
        )
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .map((block) => block.text.trim())
        .filter(Boolean);
    },
  };
}

/** Who the User is in each Linear Account, by Account id: the ranking's "assigned to me". */
export function usersOf(accounts: readonly AccountSummary[]): Record<string, string> {
  return Object.fromEntries(
    accounts.flatMap((account) => (account.user ? [[account.id, account.user.id] as const] : [])),
  );
}

/** What changes when a sync finishes: each Account's last sync. */
export const syncSignature = (accounts: readonly AccountSummary[]) =>
  accounts.map((account) => `${account.id}:${account.sync?.lastSyncedAt ?? ''}`).join('|');

// ---------------------------------------------------------------------------------------------
// Cleared rows, remembered across restarts in localStorage, like the Project filter, until the Core
// keeps the User's settings. Clearing changes no Item: it is the Dashboard's own view.

export const CLEARS_STORAGE_KEY = 'commander.dashboard.cleared';

const BANDS = new Set(['now', 'today', 'waiting', 'fyi']);

export function loadClears(storage: Storage): Clears {
  try {
    const saved: unknown = JSON.parse(storage.getItem(CLEARS_STORAGE_KEY) ?? '{}');
    if (!saved || typeof saved !== 'object') return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, mark]) => mark && typeof mark === 'object' && BANDS.has(mark.band) && typeof mark.at === 'number',
      ),
    );
  } catch {
    return {};
  }
}

export function saveClears(storage: Storage, clears: Clears): void {
  try {
    storage.setItem(CLEARS_STORAGE_KEY, JSON.stringify(clears));
  } catch {
    // Storage unavailable: the clears still hold for this session.
  }
}
