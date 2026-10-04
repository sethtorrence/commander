import type { BlockPair, FocusSettings } from '@commander/domain';
import { Button, cn, Switch, toast } from '@commander/ui';
import { useEffect, useMemo, useState } from 'react';
import type { ItemStoreClient } from '../item-store/client';
import {
  addressOf,
  type CalendarAccount,
  type CalendarAccountsClient,
  calendarAccountsIn,
} from '../sections/calendar/calendar-events';
import { SettingRow } from './parts';

/*
  Settings → Calendar's focus time (#131):
  - Working hours, which free time is worked out in (09:00–18:00 Monday to Friday unless changed).
  - Focus blocks go in: the Account whose "Commander" calendar Ares's focus blocks go in (made there on
    first use).
  - Block time across Accounts, off by default: pairs the User chooses ("personal Google → work
    Outlook"); each busy event in the first puts a private "Busy" on the second's main calendar.
    Switching a pair on sets Tidy your Sources / "Block time across Accounts" to Auto in the Autonomy
    grid, where it can be changed.
*/

const DAYS: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const selectClass =
  'h-7.5 min-w-0 border border-line bg-sheet px-2 font-sans text-note text-ink outline-none focus-visible:border-ink';
const labelClass = 'font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Without the window's bridge (component tests): no calendar Accounts.
const noAccounts: CalendarAccountsClient = {
  list: async () => [],
  refresh: async () => {},
  onChange: () => () => {},
};

const accountLabel = (account: CalendarAccount) =>
  `${addressOf(account)} · ${account.source === 'google' ? 'Google' : 'Outlook'}`;

export function FocusTimeSettings({
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
  const [settings, setSettings] = useState<FocusSettings | null>(null);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    itemStore({ op: 'focus-settings' }).then(setSettings, () => {});
  }, [itemStore]);
  useEffect(() => {
    client.list().then(setAccounts, () => {});
    return client.onChange(setAccounts);
  }, [client]);

  const save = (next: FocusSettings) =>
    itemStore({ op: 'save-focus-settings', settings: next }).then(setSettings, (error) =>
      toast(message(error)),
    );
  const nameOf = (id: string) => {
    const account = accounts.find((each) => each.id === id);
    return account ? addressOf(account) : id;
  };

  if (!settings) return null;
  const { workingHours, focusAccount, blockPairs } = settings;
  const toggleDay = (day: number) => {
    const days = workingHours.days.includes(day)
      ? workingHours.days.filter((each) => each !== day)
      : [...workingHours.days, day];
    void save({ ...settings, workingHours: { ...workingHours, days } });
  };
  const setPair = (pair: BlockPair, change: Partial<BlockPair> | null) =>
    void save({
      ...settings,
      blockPairs: change
        ? blockPairs.map((each) => (each === pair ? { ...each, ...change } : each))
        : blockPairs.filter((each) => each !== pair),
    });
  const addPair = () => {
    if (!from || !to || from === to) return;
    void save({ ...settings, blockPairs: [...blockPairs, { from, to, on: true }] }).then(() => {
      setFrom('');
      setTo('');
    });
  };
  const taken = blockPairs.some((pair) => pair.from === from && pair.to === to);

  return (
    <div data-testid="focus-time-settings">
      <SettingRow
        label="Working hours"
        description="Ares finds free time for focus blocks only inside these hours, on these days, in this machine’s time zone."
      >
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="m-0 flex min-w-0 border-0 p-0">
            <legend className="sr-only">Working days</legend>
            {DAYS.map(([day, short]) => {
              const on = workingHours.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    'h-7.5 w-10 cursor-pointer border border-line font-mono text-label font-semibold uppercase tracking-label [&+&]:border-l-0',
                    on ? 'bg-ink text-sheet' : 'bg-sheet text-muted hover:bg-raise',
                  )}
                >
                  {short}
                </button>
              );
            })}
          </fieldset>
          <label className="flex items-center gap-2">
            <span className={labelClass}>From</span>
            <input
              type="time"
              aria-label="Working hours start"
              value={workingHours.start}
              onChange={(event) =>
                event.target.value < workingHours.end &&
                void save({ ...settings, workingHours: { ...workingHours, start: event.target.value } })
              }
              className={selectClass}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className={labelClass}>To</span>
            <input
              type="time"
              aria-label="Working hours end"
              value={workingHours.end}
              onChange={(event) =>
                event.target.value > workingHours.start &&
                void save({ ...settings, workingHours: { ...workingHours, end: event.target.value } })
              }
              className={selectClass}
            />
          </label>
        </div>
      </SettingRow>
      <SettingRow
        label="Focus blocks go in"
        description="Accepted focus blocks go in a calendar named Commander in this Account, busy and private, so colleagues see only that you’re busy. Commander makes the calendar the first time."
      >
        <select
          aria-label="Focus blocks go in"
          value={focusAccount ?? ''}
          onChange={(event) => void save({ ...settings, focusAccount: event.target.value || null })}
          className={cn(selectClass, 'w-80')}
        >
          <option value="">
            {accounts.length === 1
              ? `${accountLabel(accounts[0] as CalendarAccount)} (the only one)`
              : 'Choose an Account'}
          </option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountLabel(account)}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="Block time across Accounts"
        description="Off until you add a pair. Each busy event in the first Account puts a private event titled Busy, with nothing else of it, on the second Account’s main calendar, so nobody books over it. It moves and goes with its event. Commander’s own events are never copied."
      >
        <div className="flex flex-col gap-2">
          {blockPairs.length > 0 && (
            <ul className="m-0 list-none border-t border-line p-0" aria-label="Pairs">
              {blockPairs.map((pair) => {
                const name = `${nameOf(pair.from)} → ${nameOf(pair.to)}`;
                return (
                  <li
                    key={`${pair.from}→${pair.to}`}
                    className="flex min-h-9 items-center gap-3 border-b border-line2 py-1"
                  >
                    <span className="min-w-0 flex-1 truncate text-note text-ink">{name}</span>
                    <Switch
                      aria-label={`Block time: ${name}`}
                      checked={pair.on}
                      onCheckedChange={(on) => setPair(pair, { on })}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPair(pair, null)}
                      aria-label={`Remove ${name}`}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {accounts.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Busy events in"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className={cn(selectClass, 'w-60')}
              >
                <option value="">Busy events in…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
              <span aria-hidden="true" className="text-muted">
                →
              </span>
              <select
                aria-label="Block time in"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className={cn(selectClass, 'w-60')}
              >
                <option value="">Block time in…</option>
                {accounts
                  .filter((account) => account.id !== from)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
              </select>
              <Button size="sm" disabled={!from || !to || from === to || taken} onClick={addPair}>
                Add pair
              </Button>
            </div>
          ) : (
            <p className="m-0 text-note text-faint">
              Connect a second calendar Account to block time across Accounts.
            </p>
          )}
        </div>
      </SettingRow>
    </div>
  );
}
