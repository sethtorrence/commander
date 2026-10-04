import type { CalendarSummary } from '@commander/domain';
import { Switch, toast } from '@commander/ui';
import { useEffect, useState } from 'react';
import type { CalendarSwitches as Switches } from './calendar-events';
import { CalendarSwatch } from './EventRow';

/**
 * Settings → Accounts, under a Google Account's Google Calendar: each of its calendars with a switch.
 * Primary and owned calendars start on, subscribed ones (holidays, a colleague's) off. Off stops
 * syncing the calendar and hides its events at once; on syncs it again. The list is read again after
 * each sync (`syncedAt`), which is when new calendars show up.
 */
export function CalendarSwitches({
  account,
  switches,
  syncedAt,
}: {
  account: string;
  switches: Switches;
  syncedAt: number | null;
}) {
  const [calendars, setCalendars] = useState<CalendarSummary[] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `syncedAt` asks for a reread after a sync
  useEffect(() => {
    let current = true;
    Promise.resolve()
      .then(() => switches.calendars())
      .then(
        (all) => current && setCalendars(all.filter((calendar) => calendar.account === account)),
        () => current && setCalendars([]),
      );
    return () => {
      current = false;
    };
  }, [switches, account, syncedAt]);

  const set = async (calendar: CalendarSummary, on: boolean) => {
    setCalendars((now) => now?.map((each) => (each.id === calendar.id ? { ...each, on } : each)) ?? now);
    try {
      const all = await switches.setOn(account, calendar.id, on);
      setCalendars(all.filter((each) => each.account === account));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      setCalendars((now) => now?.map((each) => (each.id === calendar.id ? calendar : each)) ?? now);
    }
  };

  if (calendars === null) return null;
  return (
    <div data-testid="calendar-switches" className="mt-1 ml-[52px] max-w-[508px] basis-full">
      {calendars.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 border-l border-line2 p-0 pl-3">
          {calendars.map((calendar) => (
            <li
              key={calendar.id}
              className="flex min-h-7 items-center gap-2.5"
              data-calendar-id={calendar.id}
            >
              <Switch
                aria-label={calendar.name}
                checked={calendar.on}
                onCheckedChange={(on) => void set(calendar, on)}
              />
              <CalendarSwatch colour={calendar.colour} />
              <span className="min-w-0 truncate text-note text-ink">{calendar.name}</span>
              <span className="flex-none text-note text-muted">
                {calendar.primary ? 'Primary' : calendar.accessRole === 'owner' ? 'Yours' : 'Subscribed'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-note text-muted">Its calendars show here after its first sync.</p>
      )}
    </div>
  );
}
