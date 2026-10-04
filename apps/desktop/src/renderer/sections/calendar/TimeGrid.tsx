import { cn } from '@commander/ui';
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import { ItemWarning } from '../../links/ItemWarning';
import { type AgendaEntry, type CalendarEvent, clock, entryFor } from './agenda';
import { ClashMark, EventStamp } from './marks';
import { dayBlocks, type GridBlock, nowLine, type StripBar, stripBars } from './time-grid';
import { secondZoneHours, zoneName } from './zones';

/*
  The Day and Week views (#127): a time grid with a column per day, its hours down the side (and the
  second time zone's beside them, when set), all-day events in a strip above, overlapping events side
  by side, and a "now" line in the signal colour on today. Each block wears its calendar's colour,
  its Badge as a stamp and, when it clashes with another Account's event, the clash mark.
*/

// The height of an hour, in px.
const HOUR = 44;
const LANE = 22;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const pad = (n: number) => String(n).padStart(2, '0');
const dayHead = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()]} ${d}`;
};

// A block's colours: a tint of its calendar's colour, with the colour itself as its left edge.
const tinted = (colour: string) =>
  ({
    '--cal': colour,
    backgroundColor: 'color-mix(in srgb, var(--cal) 20%, var(--sheet))',
    borderColor: 'color-mix(in srgb, var(--cal) 55%, var(--line))',
    boxShadow: 'inset 3px 0 0 var(--cal)',
  }) as CSSProperties;

type Shared = {
  timeZone: string;
  now: number;
  clashes: ReadonlyMap<string, CalendarEvent[]>;
  selectedId: string | null;
  onOpen: (entry: AgendaEntry) => void;
};

function Block({ block, timeZone, now, clashes, selectedId, onOpen }: Shared & { block: GridBlock }) {
  const { event } = block;
  const entry = entryFor(event, block.day, timeZone);
  const label = `${entry.time}${entry.until ? `–${entry.until}` : ''} ${event.title}`;
  const height = ((block.bottom - block.top) / 60) * HOUR;
  const short = height < 38;
  const declined = event.detail.myResponse === 'declined';
  const selected = selectedId === event.id;
  const time = block.continuesBefore
    ? `↑ ${clock(event.detail.end.at, timeZone)}`
    : `${clock(event.detail.start.at, timeZone)}`;
  const clashing = clashes.get(event.id) ?? [];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (CalendarSheet's shortcuts)
    <li
      data-testid="calendar-block"
      data-item-id={event.id}
      aria-label={label}
      aria-current={selected || undefined}
      title={label}
      onClick={() => onOpen(entry)}
      className={cn(
        'absolute flex cursor-default flex-col overflow-hidden border px-1.5 pl-2 text-left',
        short ? 'flex-row items-center gap-1.5 py-0' : 'gap-0.5 py-1',
        selected
          ? 'z-3 outline-2 outline-offset-0 outline-ink'
          : 'z-1 hover:z-2 hover:outline hover:outline-ink',
        // Free time: a dashed edge, as the Agenda's "Free" tag.
        !event.detail.busy && 'border-dashed',
        clashing.length > 0 && 'pr-4',
        event.detail.end.at <= now && 'hatch',
      )}
      style={{
        ...tinted(event.detail.calendar.colour),
        top: (block.top / 60) * HOUR,
        height: Math.max(height - 1, 14),
        left: `calc(${(block.column / block.columns) * 100}% + 1px)`,
        width: `calc(${100 / block.columns}% - 3px)`,
      }}
    >
      {/* The clash mark in the corner, where even a narrow block shows it. */}
      <ClashMark clashes={clashing} small className="absolute top-0 right-0" />
      {!short && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-label leading-none font-medium tracking-mono whitespace-nowrap text-muted tabular-nums">
            {time}
          </span>
          <span className="ml-auto flex flex-none items-center gap-1">
            <ItemWarning item={event} />
            <EventStamp event={event} size="sm" />
          </span>
        </span>
      )}
      <span
        className={cn(
          'min-w-0 truncate text-note leading-[16px] font-semibold',
          declined ? 'text-faint line-through decoration-1' : 'text-ink',
          short && 'flex-1',
        )}
      >
        {event.title}
      </span>
      {short && <EventStamp event={event} size="sm" />}
      {!short && height > 70 && event.detail.location && (
        <span className="min-w-0 truncate text-label leading-[14px] text-muted">{event.detail.location}</span>
      )}
    </li>
  );
}

function Bar({
  bar,
  days,
  timeZone,
  clashes,
  selectedId,
  onOpen,
}: Shared & { bar: StripBar; days: readonly string[] }) {
  const { event } = bar;
  const day = days[bar.first] ?? '';
  const entry = entryFor(event, day, timeZone);
  const label = event.detail.allDay ? `All day ${event.title}` : `${entry.time} ${event.title}`;
  const selected = selectedId === event.id;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (CalendarSheet's shortcuts)
    <li
      data-testid="calendar-allday"
      data-item-id={event.id}
      aria-label={label}
      aria-current={selected || undefined}
      title={label}
      onClick={() => onOpen(entry)}
      className={cn(
        'mx-px flex h-[19px] min-w-0 cursor-default items-center gap-1.5 border px-1.5',
        selected ? 'outline-2 outline-ink' : 'hover:outline hover:outline-ink',
      )}
      style={{
        ...tinted(event.detail.calendar.colour),
        gridColumn: `${bar.first + 1} / span ${bar.span}`,
        gridRow: bar.lane + 1,
      }}
    >
      {bar.continuesBefore && <span className="text-label text-muted">←</span>}
      <span className="min-w-0 flex-1 truncate text-label-lg leading-none font-semibold text-ink">
        {event.title}
      </span>
      <ClashMark clashes={clashes.get(event.id) ?? []} />
      <EventStamp event={event} size="sm" />
      {bar.continuesAfter && <span className="text-label text-muted">→</span>}
    </li>
  );
}

export function TimeGrid({
  days,
  events,
  timeZone,
  secondTimeZone,
  now,
  today,
  clashes,
  selectedId,
  onOpen,
  overlay,
}: Shared & {
  days: readonly string[];
  events: readonly CalendarEvent[];
  secondTimeZone: string | null;
  today: string;
  /** More to draw in a day's column (Ares's suggested focus blocks), placed by `top` (minutes → px). */
  overlay?: (day: string, top: (minutes: number) => number) => ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useMemo(
    () => days.map((day) => ({ day, blocks: dayBlocks(events, day, timeZone) })),
    [days, events, timeZone],
  );
  const bars = useMemo(() => stripBars(events, days, timeZone), [events, days, timeZone]);
  const lanes = bars.reduce((most, bar) => Math.max(most, bar.lane + 1), 0);
  const line = nowLine(now, days, timeZone);
  // The second zone's hours, as on the first day shown (or today, when it is shown).
  const secondHours = secondTimeZone
    ? secondZoneHours(days.includes(today) ? today : (days[0] ?? today), timeZone, secondTimeZone)
    : null;
  const gutter = secondHours ? 104 : 56;
  const template = `${gutter}px repeat(${days.length}, minmax(0, 1fr))`;
  const shared = { timeZone, now, clashes, selectedId, onOpen };

  // Opened, or moved to other days: the grid starts an hour before now on today (07:00 at the
  // earliest), else at 07:00.
  const first = days[0];
  const lineMinutes = line?.minutes ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of days (or view) scrolls
  useLayoutEffect(() => {
    const start = lineMinutes !== null ? Math.max(7 * 60, lineMinutes - 60) : 7 * 60;
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (start / 60) * HOUR - 8);
  }, [first, days.length]);

  return (
    <div data-testid="time-grid" className="flex min-w-0 flex-col">
      <div className="grid border-b border-line" style={{ gridTemplateColumns: template }}>
        <div className="flex items-end justify-around gap-1 pb-1.5 font-mono text-[8.5px] leading-none uppercase tracking-label text-faint">
          <span title={timeZone}>{zoneName(timeZone)}</span>
          {secondTimeZone && (
            <span title={secondTimeZone} data-testid="second-zone-head">
              {zoneName(secondTimeZone)}
            </span>
          )}
        </div>
        {days.map((day) => (
          <div
            key={day}
            data-testid="grid-day"
            className={cn(
              'flex h-9 min-w-0 items-center overflow-hidden border-l border-line2 px-2.5 font-mono text-label-lg leading-none uppercase tracking-label whitespace-nowrap',
              day === today ? 'font-bold text-signal-ink' : 'font-semibold text-ink',
            )}
          >
            {day === today ? (
              <span className="flex items-center gap-1.5">
                <span className="bg-signal px-1 py-[3px] text-on-signal">{dayHead(day)}</span>
              </span>
            ) : (
              dayHead(day)
            )}
          </div>
        ))}
      </div>
      <div className="grid border-b border-line" style={{ gridTemplateColumns: template }}>
        <div className="flex items-start justify-end px-1.5 pt-1.5 font-mono text-[8.5px] leading-none uppercase tracking-label text-faint">
          All day
        </div>
        <ul
          className="m-0 grid list-none gap-y-[3px] border-l border-line2 p-0 py-[5px]"
          style={{
            gridColumn: `2 / span ${days.length}`,
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${Math.max(lanes, 1)}, ${LANE - 3}px)`,
          }}
          data-testid="all-day-strip"
        >
          {bars.map((bar) => (
            <Bar key={`${bar.event.id}`} bar={bar} days={days} {...shared} />
          ))}
        </ul>
      </div>
      <div
        ref={scroller}
        className="relative max-h-[calc(100vh-var(--body)-250px)] min-h-[320px] overflow-y-auto [scrollbar-width:thin]"
      >
        <div className="grid" style={{ gridTemplateColumns: template, height: 24 * HOUR }}>
          <div className="relative" aria-hidden="true">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="absolute right-0 left-0 flex justify-around font-mono text-[9.5px] leading-none font-medium text-muted tabular-nums"
                style={{ top: hour * HOUR - (hour ? 5 : 0) }}
              >
                {hour > 0 && <span>{pad(hour)}:00</span>}
                {hour > 0 && secondHours && (
                  <span className="text-faint" data-testid="second-zone-hour">
                    {secondHours[hour]}
                  </span>
                )}
              </div>
            ))}
            {line && (
              <span
                className="absolute right-1 left-1 z-4 grid h-[15px] place-items-center bg-signal font-mono text-[9px] leading-none font-semibold text-on-signal tabular-nums"
                style={{ top: (line.minutes / 60) * HOUR - 7 }}
              >
                {clock(now, timeZone)}
              </span>
            )}
          </div>
          {columns.map(({ day, blocks }) => (
            <div
              key={day}
              data-day={day}
              className={cn(
                'relative border-l border-line2',
                day === today && days.length > 1 && 'bg-signal-focus',
              )}
              style={{
                backgroundImage: `repeating-linear-gradient(to bottom, var(--line2) 0 1px, transparent 1px ${HOUR}px)`,
              }}
            >
              <ul className="m-0 list-none p-0" aria-label={day}>
                {blocks.map((block) => (
                  <Block key={`${block.event.id}/${block.day}`} block={block} {...shared} />
                ))}
              </ul>
              {overlay?.(day, (minutes) => (minutes / 60) * HOUR)}
              {line && line.column === days.indexOf(day) && (
                <div
                  data-testid="now-line"
                  aria-hidden="true"
                  className="pointer-events-none absolute right-0 left-0 z-4 h-0.5 bg-signal"
                  style={{ top: (line.minutes / 60) * HOUR - 1 }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
