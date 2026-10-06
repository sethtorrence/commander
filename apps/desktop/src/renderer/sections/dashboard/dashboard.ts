import {
  type ActivityEntry,
  type ChatSetting,
  type CoreMessage,
  type DashboardState,
  type Item,
  NEEDS_REPLY,
  WAITING_ON_OTHERS,
} from '@commander/domain';
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
   * The open Items the Dashboard ranks: open Todos, Linear issues and Teams Chats, not deleted,
   * today's and tomorrow's events (its schedule; the next meeting is ranked into Now), GitHub's open
   * work, Ares's latest GitHub summary, and the inbox's threads in Needs reply and Waiting on others,
   * each by its latest message (#137).
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
      // From Daily Notes and from Teams Chats (#110), oldest first.
      const found = await Promise.all(
        (['notes', 'teams'] as const).map((section) =>
          ares.autonomy({ op: 'activity', query: { section, statuses: ['pending'], limit: 500 } }),
        ),
      );
      return found
        .flat()
        .sort((a, b) => a.id - b.id)
        .flatMap((row) => suggestedTodoOf(row) ?? []);
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
      const [todos, issues, events, chats, posts, invitations, work, summaries, needsReply, waiting] =
        await Promise.all([
          itemStore({ op: 'query', query: { kinds: ['todo'], statuses: ['open'], limit: MOST } }),
          itemStore({ op: 'query', query: { kinds: ['linear-issue'], statuses: ['open'], limit: MOST } }),
          itemStore({ op: 'events', query: { from, to, limit: MOST } }),
          itemStore({ op: 'query', query: { kinds: ['chat'], statuses: ['open'], limit: MOST } }),
          // Channel posts (#111): the band rules put an unseen mention of the User in Today.
          itemStore({ op: 'query', query: { kinds: ['channel-post'], statuses: ['open'], limit: MOST } }),
          // Invitations waiting for an answer, whenever they are (#129): the band rules put them in Today.
          itemStore({ op: 'invitations' }),
          // GitHub's open work (#116): reviews asked of the User, and pull requests (theirs are ranked).
          itemStore({
            op: 'query',
            query: { kinds: ['review-request', 'pull-request'], statuses: ['open'], limit: MOST },
          }),
          // Ares's latest daily GitHub summary or Monday roll-up (#121): one row, FYI or Today.
          itemStore({ op: 'github-summaries', cadences: ['daily', 'weekly'], limit: 1 }),
          // Email (#137): the inbox's threads in the two Buckets the band rules place.
          itemStore({ op: 'email-threads', query: { view: 'inbox', bucket: NEEDS_REPLY, limit: MOST } }),
          itemStore({
            op: 'email-threads',
            query: { view: 'inbox', bucket: WAITING_ON_OTHERS, limit: MOST },
          }),
        ]);
      const shown = new Set(events.map((event) => event.id));
      return [
        ...todos,
        ...issues,
        ...events,
        ...chats,
        ...posts,
        ...invitations.filter((item) => !shown.has(item.id)),
        ...work,
        ...summaries.summaries,
        ...[...needsReply.threads, ...waiting.threads].map((thread) => thread.latest),
      ];
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
  state.accounts.filter(
    (account) => account.source === 'linear' || account.source === 'teams' || account.source === 'github',
  );

/**
 * The Accounts the Dashboard ranks by: the Linear ones ("assigned to me"), the Teams ones ("mentions
 * me") and the GitHub ones ("your pull request").
 */
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

/**
 * Who the User is in each Linear and Teams Account, by Account id: "assigned to me", "mentions me";
 * in a GitHub Account, their login (GitHub's Items name people by login).
 */
export function usersOf(accounts: readonly AccountSummary[]): Record<string, string> {
  return Object.fromEntries(
    accounts.flatMap((account) => {
      if (account.source === 'github') return [[account.id, account.login] as const];
      return account.user ? [[account.id, account.user.id] as const] : [];
    }),
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
