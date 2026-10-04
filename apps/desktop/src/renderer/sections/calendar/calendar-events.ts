import type { ActivityEntry, CalendarSummary } from '@commander/domain';
import type { AccountSummary, AccountsState, GoogleAccountSummary } from '@commander/domain/ipc';
import type { ItemStoreClient } from '../../item-store/client';
import { syncLine } from '../linear/linear-issues';
import type { TodoLink } from '../todos/todos';
import { type CalendarEvent, isEvent } from './agenda';

/*
  The Calendar Section's view of the app: everything it reads from the Item store or asks of the
  calendar Accounts goes through here, so components never build requests themselves. Filing goes
  through Projects (projects/), which records it as the User's.
*/

export type EventLink = TodoLink;

export interface CalendarEvents {
  /** The live events overlapping a time range (epoch ms), earliest first. */
  list(from: number, to: number): Promise<CalendarEvent[]>;
  /** One event, if Commander still holds it. */
  get(itemId: string): Promise<CalendarEvent | null>;
  /** Every calendar Account's calendars, and whether each is on. */
  calendars(): Promise<CalendarSummary[]>;
  /** An event's Links in both directions: from it first, then backlinks. */
  links(itemId: string): Promise<EventLink[]>;
  /** An event's activity log, newest first. */
  history(itemId: string): Promise<ActivityEntry[]>;
  /** Reverses what an activity entry changed (filing an event, say). */
  undo(entryId: number): Promise<ActivityEntry>;
}

// The most events the Agenda reads at once.
const MOST = 5000;

export function calendarEventsIn(itemStore: ItemStoreClient): CalendarEvents {
  return {
    async list(from, to) {
      const items = await itemStore({ op: 'events', query: { from, to, limit: MOST } });
      return items.filter(isEvent);
    },
    async get(itemId) {
      const view = await itemStore({ op: 'get', itemId });
      return view && view.item.deletedAt === null && isEvent(view.item) ? view.item : null;
    },
    calendars: () => itemStore({ op: 'calendars' }),
    async links(itemId) {
      const view = await itemStore({ op: 'get', itemId });
      if (!view) return [];
      return [
        ...view.links.map((link) => ({ type: link.type, backlink: false, other: link.to })),
        ...view.backlinks.map((link) => ({ type: link.type, backlink: true, other: link.from })),
      ];
    },
    history: (itemId) => itemStore({ op: 'activity', query: { itemId } }),
    undo: (entryId) => itemStore({ op: 'record', action: { type: 'undo', entryId } }),
  };
}

/** Switching calendars on and off in Settings → Accounts (it hides or syncs their events). */
export function calendarSwitchesIn(itemStore: ItemStoreClient) {
  return {
    calendars: () => itemStore({ op: 'calendars' }),
    setOn: (account: string, calendarId: string, on: boolean) =>
      itemStore({ op: 'set-calendar-enabled', account, calendarId, on }),
  };
}
export type CalendarSwitches = ReturnType<typeof calendarSwitchesIn>;

/** The Google Accounts with Google Calendar on, as Settings → Accounts has them. */
export interface CalendarAccountsClient {
  list(): Promise<GoogleAccountSummary[]>;
  /** Syncs the Account's calendars at once (the sync engine's refresh of Google Calendar only). */
  refresh(accountId: string): Promise<void>;
  /** Called with the Accounts whenever they or their syncing change. Returns the unsubscribe. */
  onChange(listener: (accounts: GoogleAccountSummary[]) => void): () => void;
}

type AccountsBridge = Pick<Window['commander'], 'accounts' | 'onAccountsChanged'>;

/** Whether an Account carries Google Calendar, switched on. */
export const syncsCalendar = (account: AccountSummary): account is GoogleAccountSummary =>
  account.source === 'google' &&
  account.sources.some((carried) => carried.source === 'google-calendar' && carried.enabled);

const calendarAccounts = (state: AccountsState) => state.accounts.filter(syncsCalendar);

export function calendarAccountsIn(bridge: AccountsBridge): CalendarAccountsClient {
  return {
    async list() {
      return calendarAccounts((await bridge.accounts({ op: 'list' })).state);
    },
    async refresh(accountId) {
      await bridge.accounts({ op: 'sync-now', accountId, source: 'google-calendar' });
    },
    onChange(listener) {
      return bridge.onAccountsChanged((state) => listener(calendarAccounts(state)));
    },
  };
}

/** Google Calendar's own sync status of an Account (it may carry Gmail too). */
export const calendarSyncOf = (account: GoogleAccountSummary) =>
  account.sources.find((carried) => carried.source === 'google-calendar')?.sync ?? null;

/** The Section's thin status line: "Synced 14:02", "Syncing…", or the problem, each Account named when several. */
export function calendarSyncLine(
  accounts: readonly GoogleAccountSummary[],
  now: Date,
): { text: string; problem: boolean } {
  if (!accounts.length) return { text: 'No Google Calendar connected', problem: false };
  return syncLine(
    accounts.map((account) => ({ ...account, name: account.email, sync: calendarSyncOf(account) })),
    now,
  );
}
