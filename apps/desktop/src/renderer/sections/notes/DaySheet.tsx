import { cn, Kbd, Led, SectionHeader, Sheet, SheetStrip } from '@commander/ui';
import type { ReactNode } from 'react';
import { dayOfYear, isoWeek } from '../../frame/calendar';
import { dateOf, dayLabel, longDate, notePartNumber, weekday } from './days';
import type { DayState } from './notebook';
import { OutlineView, type ProjectView } from './OutlineView';
import type { Outline } from './outline';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function daysInYear(year: number) {
  return new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
}

// Column A: the sheet's title block, with its part number, the big date and a table of what it holds.
function Spec({ day, today, outline }: { day: string; today: boolean; outline: Outline }) {
  const date = dateOf(day);
  const todos = [...outline.values()].filter((block) => block.todo);
  const done = todos.filter((block) => block.todo?.done).length;
  const rows: [string, string, string?][] = [
    ['Meetings', '00'],
    today ? ['Open Todos', pad(todos.length - done)] : ['Todos done', `${done}/${todos.length}`],
    ['Blocks', pad(outline.size, 3)],
  ];
  if (today) rows.push(['From Ares', '00', 'ares']);
  return (
    <aside className="n-spec" aria-label="Daily Note details">
      <div className="n-sp-pn">
        <span>{notePartNumber(day)}</span>
        {today && (
          <span className="n-sp-live">
            <Led size="sm" />
            Live
          </span>
        )}
      </div>
      <div className="n-sp-num">{pad(date.getDate())}</div>
      <div className="n-sp-mo">
        {MONTHS[date.getMonth()]} {date.getFullYear()} · {weekday(day).slice(0, 3)}
      </div>
      <dl className="n-sp-tab">
        {rows.map(([label, value, tone]) => (
          <div key={label} className={tone}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="n-sp-foot">
        Wk {isoWeek(date)} · D {dayOfYear(date)}/{daysInYear(date.getFullYear())}
      </div>
    </aside>
  );
}

function ShiftIcon() {
  return (
    <svg className="sh" viewBox="0 0 10 10" aria-label="Shift">
      <path d="M5 1.2 1.3 5.3h2.2v3.4h3V5.3h2.2Z" />
    </svg>
  );
}

function Key({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <div className="k">
      <span className="kk">{keys}</span>
      <span>{children}</span>
    </div>
  );
}

// The outliner key in today's margin (LGD-01): the keys that work in a Block.
function Legend() {
  return (
    <div className="n-legend" data-testid="outliner-key">
      <div className="n-lt">
        <span>Key · every line is a block</span>
        <span className="n-lt-n">LGD-01</span>
      </div>
      <Key keys={<Kbd>↵</Kbd>}>new block</Key>
      <Key
        keys={
          <>
            <Kbd>Tab</Kbd>
            <Kbd>
              <ShiftIcon />
              Tab
            </Kbd>
          </>
        }
      >
        indent, outdent
      </Key>
      <Key keys={<Kbd>■</Kbd>}>click a bullet to fold</Key>
      <Key keys={<Kbd>[ ]</Kbd>}>start a line, get a Todo</Key>
      <Key keys={<Kbd>#LT</Kbd>}>file it under a Project</Key>
      <Key keys={<Kbd>Ctrl ↵</Kbd>}>make a Todo, tick it</Key>
      <Key keys={<Kbd>Ctrl .</Kbd>}>fold, unfold</Key>
      <Key
        keys={
          <Kbd>
            Alt <ShiftIcon />
            ↑↓
          </Kbd>
        }
      >
        move with its children
      </Key>
      <Key keys={<Kbd>Ctrl B I E</Kbd>}>bold, italic, code</Key>
      <Key keys={<Kbd>Ctrl Z</Kbd>}>undo, add Shift to redo</Key>
    </div>
  );
}

export interface DaySheetProps {
  state: DayState;
  today: string;
  /** Its place in the stream, from 1, and how many sheets there are. */
  sheet: readonly [number, number];
  /** Its Blocks' Projects and the Project filter (#51). */
  projects?: DayProjects;
}

export interface DayProjects {
  view: ProjectView;
  /** Under the filter, with nothing in it: the day shows as one line, `filtered` naming the filter. */
  collapsed: boolean;
  filtered: string;
  /** Shows a collapsed day in full. */
  onExpand(): void;
}

// A day with nothing in the Project filter: one line, which opens the day in full.
function CollapsedDay({ state, today, projects }: { state: DayState; today: string; projects: DayProjects }) {
  const { day, outline } = state;
  const written = [...outline.values()].filter((block) => block.text !== '').length;
  return (
    <section
      id={`day-${day}`}
      className={cn('n-day n-g8 n-collapsed', day === today && 'today')}
      data-day={day}
      data-testid="daily-note"
      data-collapsed=""
      aria-label={`${weekday(day)} ${longDate(day)}`}
    >
      <button
        type="button"
        className="n-col-row"
        title="Nothing here under the Project filter. Click to show the whole day."
        onClick={projects.onExpand}
      >
        <span className="m">{notePartNumber(day)}</span>
        <b>
          {weekday(day)} {longDate(day)}
        </b>
        <span>Nothing in {projects.filtered}</span>
        <span className="m">
          {pad(written, 3)} {written === 1 ? 'Block' : 'Blocks'} · Show
        </span>
      </button>
    </section>
  );
}

/** One Daily Note on the drawing: spec (A), the sheet (B–E) and its margin (F–H). */
export function DaySheet({ state, today, sheet, projects }: DaySheetProps) {
  const { day, outline } = state;
  const isToday = day === today;
  if (projects?.collapsed) return <CollapsedDay state={state} today={today} projects={projects} />;
  return (
    <section
      id={`day-${day}`}
      className={cn('n-day n-g8', isToday && 'today')}
      data-day={day}
      data-testid="daily-note"
      aria-label={`${weekday(day)} ${longDate(day)}`}
    >
      <Spec day={day} today={isToday} outline={outline} />
      <Sheet className="n-sheet">
        <SheetStrip
          eyebrow={dayLabel(day, today)}
          live={isToday}
          partNumber={notePartNumber(day)}
          sheet={sheet}
        />
        <SectionHeader
          as="h2"
          size="day"
          className={cn(!isToday && 'n-past')}
          title={weekday(day)}
          subtitle={<span className="n-date">{longDate(day)}</span>}
        />
        <div className="n-body">
          <OutlineView
            day={day}
            outline={outline}
            placeholder={isToday ? 'Nothing yet. Start typing.' : 'Nothing written this day.'}
            projectView={projects?.view}
          />
        </div>
      </Sheet>
      <div className="n-gutter">{isToday && <Legend />}</div>
    </section>
  );
}
