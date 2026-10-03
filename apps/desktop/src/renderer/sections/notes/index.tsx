import './notes.css';
import { DimensionLine, toast } from '@commander/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { isoWeek } from '../../frame/calendar';
import { useReveal } from '../../frame/reveal';
import { useNow } from '../../frame/use-now';
import { itemChangesFromCore } from '../../item-store/changes';
import { useShortcuts } from '../../shortcuts/react';
import { type SectionDefinition, useHeaderSlot, useSection } from '../section';
import { DaySheet } from './DaySheet';
import { dailyNotesIn } from './daily-notes';
import { dateOf, dayKey, longDate, notePartNumber, weekday, weekOf } from './days';
import { createNotebook, type Notebook, type NotebookSnapshot } from './notebook';
import { focusText, OutlineContext, type OutlineControls } from './OutlineView';
import type { Caret } from './outline';
import { WeekStrip } from './WeekStrip';

// How far below the window's top a day's sheet sits when the stream scrolls to it.
const bodyTop = () =>
  Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--body')) || 132;

function scrollToDay(day: string, behavior: ScrollBehavior = 'smooth') {
  const element = document.getElementById(`day-${day}`);
  if (!element) return;
  const top = element.getBoundingClientRect().top + window.scrollY - bodyTop() - 22;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

// A Block and the Blocks it sits under, nearest first.
function withParents(state: NotebookSnapshot, blockId: string): string[] {
  const outline = state.days.find((d) => d.outline.has(blockId))?.outline;
  const ids = [blockId];
  for (let parent = outline?.get(blockId)?.parentId; parent && outline?.has(parent); ) {
    ids.push(parent);
    parent = outline.get(parent)?.parentId;
  }
  return ids;
}

// Scrolls to a Block once it is on screen and flashes it. A Block folded away shows the nearest
// Block it sits under instead.
function highlightBlock(ids: string[], tries = 30) {
  requestAnimationFrame(() => {
    const target = ids
      .map((id) => document.querySelector<HTMLElement>(`[data-notes-stream] [data-block="${id}"]`))
      .find((element) => element !== null);
    if (!target) {
      if (tries > 0) highlightBlock(ids, tries - 1);
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    target.addEventListener('animationend', () => target.classList.remove('flash'), { once: true });
  });
}

// The day being read: the last sheet whose top has passed near the top of the window.
function useActiveDay(days: readonly string[], enabled: boolean): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const spy = () => {
      let current: string | null = days[0] ?? null;
      for (const day of days) {
        const element = document.getElementById(`day-${day}`);
        if (element && element.getBoundingClientRect().top <= bodyTop() + 128) current = day;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4)
        current = days.at(-1) ?? current;
      setActive(current);
    };
    spy();
    window.addEventListener('scroll', spy, { passive: true });
    window.addEventListener('resize', spy);
    return () => {
      window.removeEventListener('scroll', spy);
      window.removeEventListener('resize', spy);
    };
  }, [days, enabled]);
  return active;
}

// The dimension lines' widths: today's spec, sheet and margin, as drawn.
function useDimensions(today: string, ready: boolean) {
  const [widths, setWidths] = useState({ spec: 0, sheet: 0, margin: 0, wide: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` says today's sheet is on the page to measure
  useEffect(() => {
    const day = document.getElementById(`day-${today}`);
    if (!day || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const sheet = day.querySelector<HTMLElement>('.n-sheet');
      const margin = day.querySelector<HTMLElement>('.n-gutter');
      setWidths({
        spec: Math.round(day.clientWidth / 8),
        sheet: sheet?.offsetWidth ?? 0,
        margin: margin?.offsetWidth ?? 0,
        wide: window.matchMedia('(max-width: 1440px)').matches,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(day);
    return () => observer.disconnect();
  }, [today, ready]);
  return widths;
}

function Dimensions({ today, ready }: { today: string; ready: boolean }) {
  const { spec, sheet, margin, wide } = useDimensions(today, ready);
  return (
    <div className="n-dims n-g8" aria-hidden="true">
      <DimensionLine className="n-d-a">A · Spec · {spec}</DimensionLine>
      <DimensionLine className="n-d-s">
        {wide ? 'B–F' : 'B–E'} · Daily Note · {sheet}
      </DimensionLine>
      <DimensionLine className="n-d-g">
        {wide ? 'G–H' : 'F–H'} · Margin · {margin}
      </DimensionLine>
    </div>
  );
}

// The foot of the stream: more days loading as it comes into view, or the end.
function StreamEnd({ notebook, state }: { notebook: Notebook; state: NotebookSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  const { hasMore, started } = state;
  useEffect(() => {
    const element = ref.current;
    if (!element || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void notebook.loadMore();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [notebook, hasMore]);
  if (!started) return null;
  const first = state.days.at(-1)?.day ?? state.today;
  return (
    <div className="n-end-row n-g8" ref={ref} data-testid="stream-end">
      <div className="n-end">
        <span className="m">{notePartNumber(first)}</span>
        {hasMore ? (
          <span>Loading earlier days…</span>
        ) : (
          <span>
            Nothing written before <b>{`${weekday(first)} ${longDate(first)}`}</b>. That’s the first Daily
            Note.
          </span>
        )}
        <span className="m">End · Wk {isoWeek(dateOf(first))}</span>
      </div>
    </div>
  );
}

// The Notes Section: today's Daily Note on top, earlier days below in one stream, and the week strip.
function NotesSection() {
  const { active } = useSection();
  const slot = useHeaderSlot();
  const today = dayKey(useNow(60_000));
  const [notebook] = useState(() =>
    createNotebook(dailyNotesIn(window.commander.itemStore), { today, onError: (message) => toast(message) }),
  );
  const state = useSyncExternalStore(notebook.subscribe, notebook.snapshot);

  // Today's Daily Note is made when Notes is first shown (every Section stays mounted behind the others).
  useEffect(() => {
    if (active) void notebook.start();
  }, [notebook, active]);
  // Past local midnight, the new day comes in on top.
  useEffect(() => {
    if (state.started) void notebook.setToday(today);
  }, [notebook, today, state.started]);
  // Changes made while Notes is hidden (a Todo ticked or renamed in Todos) show when it comes back.
  const shown = useRef(active);
  shown.current = active;
  useEffect(
    () =>
      itemChangesFromCore(() => {
        if (!shown.current) void notebook.refresh();
      }),
    [notebook],
  );
  // A Block opened from elsewhere (a Todo's made-from Link): its day comes on screen, and it is
  // scrolled to and highlighted.
  useReveal('notes', async (blockId) => {
    await notebook.start();
    if (await notebook.reveal(blockId)) highlightBlock(withParents(notebook.snapshot(), blockId));
  });
  // Typing held back for a pause is saved before Commander quits.
  useEffect(() => window.commander.onSaveBeforeQuit?.(() => notebook.flush()), [notebook]);

  // The caret goes where the Notebook says, once the Block is on screen.
  const pendingFocus = useRef<Caret | null>(null);
  const applyFocus = useCallback(() => {
    const caret = pendingFocus.current;
    if (!caret) return;
    const element = document.querySelector<HTMLElement>(`[data-block-id="${caret.id}"]`);
    if (!element) return;
    pendingFocus.current = null;
    focusText(element, caret.offset);
  }, []);
  useLayoutEffect(applyFocus);
  const controls = useMemo<OutlineControls>(
    () => ({
      notebook,
      focus(caret) {
        if (!caret) return;
        pendingFocus.current = caret;
        requestAnimationFrame(applyFocus);
      },
    }),
    [notebook, applyFocus],
  );

  useShortcuts([
    { keys: 'Ctrl+z', label: 'Undo in the Daily Note', run: () => controls.focus(notebook.undo()) },
    { keys: 'Ctrl+Shift+z', label: 'Redo in the Daily Note', run: () => controls.focus(notebook.redo()) },
  ]);

  // The week strip follows the day being read; its arrows browse other weeks.
  const dayKeys = useMemo(() => state.days.map((d) => d.day), [state.days]);
  const reading = useActiveDay(dayKeys, active);
  const [week, setWeek] = useState(today);
  useEffect(() => {
    if (reading) setWeek(reading);
  }, [reading]);
  const [savedWritten, setSavedWritten] = useState<ReadonlySet<string>>(new Set());
  const weekDays = weekOf(week);
  const weekStart = weekDays[0] ?? week;
  const weekEnd = weekDays[6] ?? week;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state.started` asks again once the store has answered
  useEffect(() => {
    let current = true;
    notebook.daysWithContent(weekStart, weekEnd).then(
      (days) => current && setSavedWritten(days),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [notebook, weekStart, weekEnd, state.started]);
  const written = useMemo(() => {
    const days = new Set(savedWritten);
    for (const d of state.days)
      if ([...d.outline.values()].some((block) => block.text !== '')) days.add(d.day);
    return days;
  }, [savedWritten, state.days]);

  const goToDay = useCallback(
    async (day: string) => {
      if (day > today) {
        toast(`No Daily Note for ${weekday(day)} ${longDate(day)} yet. It starts that morning.`);
        return;
      }
      await notebook.showDay(day);
      requestAnimationFrame(() => scrollToDay(day));
    },
    [notebook, today],
  );

  const sheets = Math.max(state.days.length, 1 + state.olderTotal);
  return (
    <OutlineContext.Provider value={controls}>
      <div className="col-span-8 min-w-0" data-testid="section-notes">
        <h1 className="sr-only">Daily Notes</h1>
        {active &&
          slot &&
          createPortal(
            <WeekStrip
              week={week}
              today={today}
              active={reading}
              written={written}
              onWeek={setWeek}
              onDay={(day) => void goToDay(day)}
              onToday={() => {
                setWeek(today);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />,
            slot,
          )}
        <div className="n-stream" data-notes-stream="">
          <Dimensions today={today} ready={state.started} />
          {state.days.map((day, index) => (
            <DaySheet key={day.day} state={day} today={today} sheet={[index + 1, sheets]} />
          ))}
          <StreamEnd notebook={notebook} state={state} />
        </div>
      </div>
    </OutlineContext.Provider>
  );
}

export const notes: SectionDefinition = {
  id: 'notes',
  label: 'Notes',
  headerTitle: 'Daily Notes',
  code: 'DN',
  Component: NotesSection,
};
