import { cn } from '@commander/ui';
import { isoWeek } from '../../frame/calendar';
import { addDays, dateOf, longDate, weekday, weekOf, weekRange } from './days';

const pad = (n: number) => String(n).padStart(2, '0');

export interface WeekStripProps {
  /** A day in the week shown. */
  week: string;
  today: string;
  /** The day being read in the stream. */
  active: string | null;
  /** Days of this week with something written. */
  written: ReadonlySet<string>;
  onWeek(day: string): void;
  onDay(day: string): void;
  onToday(): void;
}

/** The week strip (.days): the week's days, which of them have notes, back and on a week, and today. */
export function WeekStrip({ week, today, active, written, onWeek, onDay, onToday }: WeekStripProps) {
  const days = weekOf(week);
  return (
    <nav className="n-week" aria-label="Jump to day" data-testid="week-strip">
      <div className="n-wk">
        <div className="n-wkn">
          <span className="long">Week</span>
          <span className="short">Wk</span> {isoWeek(dateOf(week))}
        </div>
        <div className="n-wkr">{weekRange(week)}</div>
        <div className="n-wk-nav">
          <button
            type="button"
            aria-label="Previous week"
            title="Previous week"
            onClick={() => onWeek(addDays(week, -7))}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next week"
            title="Next week"
            onClick={() => onWeek(addDays(week, 7))}
          >
            ›
          </button>
        </div>
      </div>
      {days.map((day) => {
        const has = written.has(day);
        const future = day > today;
        const name = `${weekday(day)} ${longDate(day)}`;
        return (
          <button
            key={day}
            type="button"
            className={cn(
              'n-dbtn',
              has ? 'has' : 'empty',
              day === today && 'today',
              day === active && 'active',
            )}
            title={name + (has ? '' : future ? ' · no Daily Note yet' : ' · no Daily Note')}
            aria-label={name}
            aria-current={day === active ? 'date' : undefined}
            data-day={day}
            onClick={() => onDay(day)}
          >
            <span className="w">{weekday(day).slice(0, 3)}</span>
            <span className="n">{pad(dateOf(day).getDate())}</span>
          </button>
        );
      })}
      <button type="button" className="n-tbtn" title="Back to today" onClick={onToday}>
        <span className="w">Jump</span>
        <span className="t">Today</span>
      </button>
    </nav>
  );
}
