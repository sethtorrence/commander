import type { ActivityEntry, ChatSetting, CoreMessage, DashboardState, Item } from '@commander/domain';
import type { AccountSummary, AccountsState } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import type { AutonomyClient } from '../ares/activity';
import { addDays, dayKey, dayStart } from '../calendar/agenda';
import { localTimeZone } from '../calendar/ScheduleCard';
import type { LinearAccountsClient } from '../linear/linear-issues';
import type { Clears } from './feed';
import { type SuggestedTodo, suggestedTodoOf } from './suggested-todos';

/*
  The Dashboard's view of the app: everything it reads or changes goes through here, so components
  never build requests themselves. It reads the open Items a Ranker looks at and the muted Chats from
  the Item store, who the User is in each Linear and Teams Account from the Accounts, and Ares's
  ranking, the cleared rows and his pending suggested Todos from the Core; it ticks Todos, clears
  rows, adds or dismisses suggestions, undoes, and asks Teams for a light sync when the Dashboard
  opens. Reached only through the window's bridge, so every change is the User's.
*/

export interface DashboardClient {
  /**
   * The open Items the Dashboard ranks: open Todos, Linear issues and Teams Chats, not deleted, and
   * today's and tomorrow's events (its schedule; the next meeting is ranked into Now).
   */
  items(): Promise<Item[]>;
  /** The Chats the User muted or excluded (muted ones never reach the Dashboard). */
  chatSettings(): Promise<ChatSetting[]>;
  /**
   * The Linear and Teams Accounts, each with who the User is there (for "assigned to me" and
   * "mentions me") and its syncing.
   */
  accounts: LinearAccountsClient;
  /** Asks every connected Teams Account for a light sync (opening the Dashboard checks Teams). */
  refreshTeams(): Promise<void>;
  /** Ticks a Todo (done) or unticks it. */
  setDone(itemId: string, done: boolean): Promise<ActivityEntry>;
  /** Reverses what an activity entry changed. */
  undo(entryId: number): Promise<ActivityEntry>;
  /** What today's Daily Note holds so far: its top Blocks' text, in order, or null with none yet. */
  dailyNote(day: string): Promise<string[] | null>;
  /** Ares's ranking (or why the rules rank the Dashboard) and the cleared rows, as the Core keeps them. */
  state(): Promise<DashboardState>;
  /** Replaces the cleared rows. */
  saveClears(clears: Clears): Promise<Clears>;
  /** Ares's pending suggested Todos, each as the Todo it would add. */
  suggestions(): Promise<{ item: Item; suggestion: SuggestedTodo }[]>;
  /** Adds a suggested Todo (accepts it, through the gate) or dismisses it. */
  settle(proposalId: number, op: 'accept' | 'dismiss'): Promise<void>;
  /**
   * Hears when Ares ranked again, or did or suggested something, or today's meetings changed. Returns
   * the function that stops it.
   */
  onAresChange(listener: () => void): () => void;
}

/** Ares's side of the bridge: the gate, and word from the Core. Absent, the Dashboard has no suggestions. */
export interface DashboardAres {
  autonomy: AutonomyClient;
  onCoreMessage(listener: (message: CoreMessage) => void): () => void;
}

// The Item store answers at most 1000 Items a query.
const MOST = 1000;

export function dashboardIn(
  itemStore: ItemStoreClient,
  accounts: LinearAccountsClient,
  ares?: DashboardAres,
  clock: () => number = Date.now,
): DashboardClient {
  return {
    state: () => itemStore({ op: 'dashboard' }),

    saveClears: (clears) => itemStore({ op: 'save-dashboard-clears', clears }),

    async suggestions() {
      if (!ares) return [];
      const pending = await ares.autonomy({
        op: 'activity',
        query: { section: 'notes', statuses: ['pending'], limit: 500 },
      });
      return pending.flatMap((row) => suggestedTodoOf(row) ?? []).reverse();
    },

    async settle(proposalId, op) {
      if (!ares) throw new Error('Ares isn’t running');
      await ares.autonomy({ op, proposalId });
    },

    onAresChange(listener) {
      if (!ares) return () => {};
      return ares.onCoreMessage((message) => {
        // Today's meetings changed (their chips did): the schedule and the next meeting follow.
        if (
          message.type === 'dashboard-ranked' ||
          message.type === 'ares-activity' ||
          message.type === 'meeting-chips'
        )
          listener();
      });
    },

    async items() {
      const timeZone = localTimeZone();
      const today = dayKey(clock(), timeZone);
      const from = dayStart(today, timeZone);
      const to = dayStart(addDays(today, 2), timeZone);
      const [todos, issues, events, chats] = await Promise.all([
        itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['open'], limit: MOST } }),
        itemStore({ op: 'query', query: { kinds: ['linear-issue'], statuses: ['open'], limit: MOST } }),
        itemStore({ op: 'events', query: { from, to, limit: MOST } }),
        itemStore({ op: 'query', query: { kinds: ['chat'], statuses: ['open'], limit: MOST } }),
      ]);
      return [...todos, ...issues, ...events, ...chats];
    },

    chatSettings: () => itemStore({ op: 'chat-settings' }),

    accounts,

    async refreshTeams() {
      const teams = (await accounts.list()).filter(
        (account) => account.source === 'teams' && account.status === 'connected',
      );
      await Promise.all(teams.map((account) => accounts.syncNow(account.id)));
    },

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

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

const ranksBy = (state: AccountsState): AccountSummary[] =>
  state.accounts.filter((account) => account.source === 'linear' || account.source === 'teams');

/** The Accounts the Dashboard ranks by: the Linear ones ("assigned to me") and the Teams ones ("mentions me"). */
export function dashboardAccountsIn(bridge: AccountsBridge): LinearAccountsClient {
  return {
    async list() {
      return ranksBy((await bridge.accounts({ op: 'list' })).state);
    },
    async syncNow(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(ranksBy(state)));
    },
  };
}

/** Who the User is in each Linear and Teams Account, by Account id: "assigned to me", "mentions me". */
export function usersOf(accounts: readonly AccountSummary[]): Record<string, string> {
  return Object.fromEntries(
    accounts.flatMap((account) => (account.user ? [[account.id, account.user.id] as const] : [])),
  );
}

/** What changes when a sync finishes: each Account's last sync. */
export const syncSignature = (accounts: readonly AccountSummary[]) =>
  accounts.map((account) => `${account.id}:${account.sync?.lastSyncedAt ?? ''}`).join('|');

// ---------------------------------------------------------------------------------------------
// Cleared rows were kept in localStorage before the Core kept them (so Ares can leave them out): those
// are moved to the Core once, then forgotten here. Clearing changes no Item: it is the Dashboard's own view.

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

export function forgetClears(storage: Storage): void {
  try {
    storage.removeItem(CLEARS_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing to forget.
  }
}
