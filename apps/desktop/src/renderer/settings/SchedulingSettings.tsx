import {
  type CalendarSummary,
  newEventsCalendar,
  type SchedulingSettings as Settings,
} from '@commander/domain';
import { Button, cn, Input, toast } from '@commander/ui';
import { useEffect, useMemo, useState } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import {
  addressOf,
  type CalendarAccount,
  type CalendarAccountsClient,
  calendarAccountsIn,
} from '../sections/calendar/calendar-events';
import { writableCalendars } from '../sections/calendar/meetings';
import { SettingRow } from './parts';

/*
  Settings → Calendar's scheduling (#132):
  - New events go in: the Account and calendar Ares's proposed events and Find time's go in (each card
    can change it). Until chosen, the focus blocks' Account, or the first calendar Account, on its main
    calendar.
  - Google booking link: the User's appointment schedule in Google Calendar, offered to guests outside
    their organisations instead of a time ("Send your booking link instead" copies it). Commander never
    hosts booking pages itself.
*/

const selectClass =
  'h-7.5 min-w-0 border border-line bg-sheet px-2 font-sans text-note text-ink outline-none focus-visible:border-ink';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Without the window's bridge (component tests): no calendar Accounts.
const noAccounts: CalendarAccountsClient = {
  list: async () => [],
  refresh: async () => {},
  onChange: () => () => {},
};

export function SchedulingSettings({
  itemStore,
  accounts: accountsClient,
}: {
  itemStore: ItemStoreClient;
  accounts?: CalendarAccountsClient;
}) {
  const client = useMemo(
    () => accountsClient ?? (window.commander ? calendarAccountsIn(window.commander) : noAccounts),
    [accountsClient],
  );
  const [settings, setSettings] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [link, setLink] = useState('');

  useEffect(() => {
    itemStore({ op: 'scheduling-settings' }).then(
      (saved) => {
        setSettings(saved);
        setLink(saved.bookingLink ?? '');
      },
      () => {},
    );
  }, [itemStore]);
  useEffect(() => {
    client.list().then(setAccounts, () => {});
    return client.onChange(setAccounts);
  }, [client]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Accounts changing lists their calendars again
  useEffect(() => {
    itemStore({ op: 'calendars' }).then(setCalendars, () => {});
  }, [itemStore, accounts]);

  const save = (next: Settings) =>
    itemStore({ op: 'save-scheduling-settings', settings: next }).then(
      (saved) => {
        setSettings(saved);
        setLink(saved.bookingLink ?? '');
        return true;
      },
      (error) => {
        toast(message(error));
        return false;
      },
    );

  if (!settings) return null;
  const targets = accounts.flatMap((account) =>
    writableCalendars(calendars, account.id).map((calendar) => ({ account, calendar })),
  );
  const chosen =
    settings.newEventsAccount && settings.newEventsCalendar
      ? `${settings.newEventsAccount}\u0000${settings.newEventsCalendar}`
      : '';
  const fallback = newEventsCalendar(calendars, { newEventsAccount: null, newEventsCalendar: null });
  const fallbackLabel = (() => {
    const account = accounts.find((each) => each.id === fallback?.account);
    return account ? `${addressOf(account)}, main calendar` : null;
  })();
  const trimmed = link.trim();

  return (
    <div data-testid="scheduling-settings">
      <SettingRow
        label="New events go in"
        description="Where the events Ares proposes from your Daily Notes, and those you set up with Find time, are made. Each card can change it."
      >
        <select
          aria-label="New events go in"
          value={chosen}
          onChange={(event) => {
            const [account, calendarId] = event.target.value.split('\u0000');
            void save({
              ...settings,
              newEventsAccount: account || null,
              newEventsCalendar: calendarId || null,
            });
          }}
          className={cn(selectClass, 'w-80')}
        >
          <option value="">
            {fallbackLabel ? `${fallbackLabel} (until you choose)` : 'Choose a calendar'}
          </option>
          {targets.map(({ account, calendar }) => (
            <option key={`${account.id}/${calendar.id}`} value={`${account.id}\u0000${calendar.id}`}>
              {calendar.primary
                ? `${addressOf(account)}, main calendar`
                : `${addressOf(account)} · ${calendar.name}`}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="Google booking link"
        description="When you schedule with someone outside your organisations, Ares offers this link instead of a time. To make one, open Google Calendar, choose Create → Appointment schedule, set your bookable hours, then Share and copy the booking page link here. Commander only copies the link; it never hosts booking pages."
      >
        <form
          className="flex flex-wrap items-center gap-2"
          aria-label="Google booking link"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ ...settings, bookingLink: trimmed || null }).then(
              (saved) => saved && toast(trimmed ? 'Booking link saved' : 'Booking link removed'),
            );
          }}
        >
          <Input
            aria-label="Google booking link"
            placeholder="https://calendar.app.google/…"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            className="w-80"
          />
          <Button size="sm" type="submit" disabled={trimmed === (settings.bookingLink ?? '')}>
            Save
          </Button>
          {settings.bookingLink && (
            <Button size="sm" variant="ghost" onClick={() => void save({ ...settings, bookingLink: null })}>
              Remove
            </Button>
          )}
        </form>
      </SettingRow>
    </div>
  );
}
