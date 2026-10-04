import { type CalendarSummary, newEventsCalendar } from '@commander/domain';
import { useEffect, useMemo, useState } from 'react';
import type { ItemStoreClient } from '../../item-store/client';
import { type CalendarAccount, type CalendarAccountsClient, calendarAccountsIn } from './calendar-events';

/** What a meeting card needs to know of the User's calendars (#132). */
export interface Scheduling {
  accounts: CalendarAccount[];
  calendars: CalendarSummary[];
  bookingLink: string | null;
  /** Where a new event goes (Settings → Calendar → New events go in), until the card changes it. */
  newEvents: { account: string; calendarId: string } | null;
}

// Without the window's bridge (component tests): no calendar Accounts.
const noAccounts: CalendarAccountsClient = {
  list: async () => [],
  refresh: async () => {},
  onChange: () => () => {},
};

/**
 * The calendar Accounts, every calendar, and the booking link, read while `active` (again whenever the
 * Accounts change, and whenever `version` does).
 */
export function useScheduling(itemStore: ItemStoreClient, active: boolean, version = 0): Scheduling {
  const client = useMemo(() => (window.commander ? calendarAccountsIn(window.commander) : noAccounts), []);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [bookingLink, setBookingLink] = useState<string | null>(null);
  const [newEvents, setNewEvents] = useState<Scheduling['newEvents']>(null);

  useEffect(() => {
    if (!active) return;
    client.list().then(setAccounts, () => {});
    return client.onChange(setAccounts);
  }, [client, active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and the Accounts ask for a reload
  useEffect(() => {
    if (!active) return;
    Promise.all([
      itemStore({ op: 'calendars' }),
      itemStore({ op: 'scheduling-settings' }),
      itemStore({ op: 'focus-settings' }),
    ]).then(
      ([listed, settings, focus]) => {
        setCalendars(listed);
        setBookingLink(settings.bookingLink);
        setNewEvents(newEventsCalendar(listed, settings, focus.focusAccount));
      },
      () => {},
    );
  }, [itemStore, active, version, accounts]);

  return { accounts, calendars, bookingLink, newEvents };
}
