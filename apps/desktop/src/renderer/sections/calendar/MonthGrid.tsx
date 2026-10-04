import { cn } from '@commander/ui';
import { useMemo } from 'react';
import type { AgendaEntry, CalendarEvent } from './agenda';
import { CalendarSwatch } from './EventRow';
import { ClashMark, EventStamp } from './marks';
import { monthCells } from './time-grid';

/*
  The Month view (#127): whole weeks, Monday first, covering the month. Each day lists up to a few
  events in Agenda order (all-day ones first) with their calendar colour, time, title, Badge and clash
  mark, then "+3 more", which opens that day in the Day view.
*/

// The most events a day shows before "+N more".
export const MONTH_EVENTS = 3;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dateOf = (day: string) => Number(day.slice(8, 10));
const monthOf = (day: string) => day.slice(0, 7);

export function MonthGrid({
  days,
  anchor,
  today,
  events,
  timeZone,
  clashes,
  selectedId,
  onOpen,
  onShowDay,
}: {
  days: readonly string[];
  /** A day in the month shown: days of other months are faint. */
  anchor: string;
  today: string;
  events: readonly CalendarEvent[];
  timeZone: string;
  clashes: ReadonlyMap<string, CalendarEvent[]>;
  selectedId: string | null;
  onOpen: (entry: AgendaEntry) => void;
  onShowDay: (day: string) => void;
}) {
  const cells = useMemo(() => monthCells(events, days, timeZone, MONTH_EVENTS), [events, days, timeZone]);
  return (
    <div data-testid="month-grid" className="min-w-0 pb-30">
      <div className="grid grid-cols-7 border-b border-line">
        {WEEKDAYS.map((name) => (
          <div
            key={name}
            className="border-l border-line2 px-2.5 py-2 font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted first:border-l-0"
          >
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const other = monthOf(cell.day) !== monthOf(anchor);
          return (
            <div
              key={cell.day}
              data-day={cell.day}
              data-testid="month-day"
              className={cn(
                'flex min-h-[116px] min-w-0 flex-col gap-[3px] border-b border-l border-line2 px-1.5 pt-1.5 pb-2 [&:nth-child(7n+1)]:border-l-0',
                other && 'hatch',
                cell.day === today && 'bg-signal-focus',
              )}
            >
              <span
                className={cn(
                  'mb-0.5 self-start px-1 py-[3px] font-mono text-label-lg leading-none font-semibold tabular-nums',
                  cell.day === today ? 'bg-signal text-on-signal' : other ? 'text-faint' : 'text-ink',
                )}
              >
                {dateOf(cell.day)}
              </span>
              <ul className="m-0 flex list-none flex-col gap-[3px] p-0">
                {cell.shown.map((entry) => {
                  const { event } = entry;
                  const selected = selectedId === event.id;
                  const label = `${entry.time} ${event.title}`;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (CalendarSheet's shortcuts)
                    <li
                      key={event.id}
                      data-testid="month-event"
                      data-item-id={event.id}
                      aria-label={label}
                      aria-current={selected || undefined}
                      title={label}
                      onClick={() => onOpen(entry)}
                      className={cn(
                        'flex h-[21px] min-w-0 cursor-default items-center gap-1.5 px-1',
                        selected
                          ? 'bg-signal-focus shadow-[inset_2px_0_0_var(--signal)] outline outline-ink'
                          : 'hover:bg-raise',
                      )}
                    >
                      <CalendarSwatch colour={event.detail.calendar.colour} className="h-2 w-2" />
                      {!event.detail.allDay && (
                        <span className="flex-none font-mono text-label leading-none text-muted tabular-nums">
                          {entry.time === 'Continues' ? '…' : entry.time}
                        </span>
                      )}
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-label-lg leading-none',
                          event.detail.myResponse === 'declined'
                            ? 'text-faint line-through decoration-1'
                            : 'text-text',
                        )}
                      >
                        {event.title}
                      </span>
                      <ClashMark clashes={clashes.get(event.id) ?? []} small />
                      <EventStamp event={event} size="sm" />
                    </li>
                  );
                })}
              </ul>
              {cell.more > 0 && (
                <button
                  type="button"
                  onClick={() => onShowDay(cell.day)}
                  className="cursor-pointer self-start border-0 bg-transparent px-1 py-0.5 font-mono text-label leading-none font-semibold uppercase tracking-label text-muted hover:text-ink hover:underline"
                >
                  +{cell.more} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
