import type { Item } from '@commander/domain';
import type { ReactNode } from 'react';
import { requestReveal } from '../../frame/reveal';
import { ItemBadge } from '../../projects/badges';
import { SideCard } from '../../projects/page/SideCard';
import { type AgendaDay, addDays, agendaDays, dayKey, isEvent, longDay } from './agenda';
import { CalendarSwatch } from './EventRow';

/*
  A schedule in a side column (#128): the Dashboard's Today and Tomorrow, and a Project page's next 7
  days. Each row shows the time, calendar colour, title and Badge, and opens the event in the Calendar
  Section. Declined and cancelled events are left out; the Agenda keeps them.
*/

const pad = (n: number) => String(n).padStart(2, '0');

/** The machine's time zone, as the Agenda reads days. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The schedule from `today` for `days` days: each day (with nothing on it too), its events in order,
 * without declined or cancelled ones.
 */
export function scheduleDays(
  items: readonly Item[],
  { today, days, timeZone }: { today: string; days: number; timeZone: string },
): AgendaDay[] {
  const events = items.filter(isEvent).filter((event) => {
    return event.deletedAt === null && event.detail.myResponse !== 'declined';
  });
  const found = new Map(agendaDays(events, { today, days, timeZone }).map((day) => [day.day, day]));
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(today, i);
    return found.get(day) ?? { day, title: longDay(day), entries: [] };
  });
}

/** The day a schedule starts on, for an instant on this machine. */
export const todayKey = (now: number, timeZone = localTimeZone()) => dayKey(now, timeZone);

export function ScheduleCard({
  label,
  title,
  days,
  dayName,
  empty,
  onOpenSection,
}: {
  label: string;
  title: ReactNode;
  days: readonly AgendaDay[];
  /** What a day's heading says: "Today", "Tomorrow", "Mon 5 Oct". */
  dayName: (day: AgendaDay, index: number) => string;
  /** What a day with nothing on it says. */
  empty: string;
  onOpenSection: (sectionId: string) => void;
}) {
  const total = days.reduce((sum, day) => sum + day.entries.length, 0);
  const open = (itemId: string) => {
    requestReveal('calendar', itemId);
    onOpenSection('calendar');
  };
  return (
    <SideCard label={label} title={title} note={pad(total)}>
      {days.map((day, index) => (
        <section key={day.day} aria-label={`Meetings · ${dayName(day, index)}`} data-testid="schedule-day">
          <h3 className="m-0 px-2.5 pt-2 pb-[3px] font-mono text-tiny leading-[1.4] font-semibold uppercase tracking-caps text-muted">
            {dayName(day, index)}
          </h3>
          {day.entries.length ? (
            <ul className="m-0 list-none p-0">
              {day.entries.map((entry) => (
                <li key={`${entry.event.id}-${entry.day}`}>
                  <button
                    type="button"
                    data-testid="schedule-event"
                    title="Open in the Calendar Section"
                    onClick={() => open(entry.event.id)}
                    className="flex w-full cursor-pointer items-center gap-2 border-0 border-b border-line2 bg-transparent px-2.5 py-1.5 text-left text-note leading-[18px] text-text hover:bg-raise"
                  >
                    <span className="w-[42px] flex-none font-mono text-label leading-[18px] tracking-mono tabular-nums text-ink">
                      {entry.time}
                    </span>
                    <CalendarSwatch colour={entry.event.detail.calendar.colour} />
                    <span className="min-w-0 flex-1 truncate">{entry.event.title}</span>
                    <ItemBadge filing={entry.event.filing} size="sm" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 border-b border-line2 px-2.5 pt-0.5 pb-2 text-note leading-[17px] text-faint">
              {empty}
            </p>
          )}
        </section>
      ))}
    </SideCard>
  );
}
