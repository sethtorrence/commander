import './notes.css';
import './formatting.css';
import type { DailyNoteProjects, Filing } from '@commander/domain';
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
import { BadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import type { ProjectFilter } from '../../projects/filter';
import { useShortcuts } from '../../shortcuts/react';
import { type SectionDefinition, useHeaderSlot, useSection } from '../section';
import { effectiveFilings, filterView, noteCounts } from './block-projects';
import { type DayProjects, DaySheet } from './DaySheet';
import { dailyNotesIn } from './daily-notes';
import { dateOf, dayKey, longDate, notePartNumber, weekday, weekOf } from './days';
import { createNotebook, type DayState, type Notebook, type NotebookSnapshot } from './notebook';
import { focusText, OutlineContext, type OutlineControls, type OutlineProjects } from './OutlineView';
import type { Block, Caret } from './outline';
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

/*
  The Project filter in Notes (#51): the one app-wide filter narrows the stream to a Project's Blocks
  (or the Unfiled ones), with the Blocks above them dimmed as context, and a day with none of them
  collapses to one line. The Blocks the User writes in while it is on stay shown, as does a day they
  open from its line, until the filter changes. Its counts are Daily Notes, not Blocks.
*/
function useNoteFilter(days: readonly DayState[], savedProjects: readonly DailyNoteProjects[]) {
  const { filter, projectById } = useProjects();
  const [kept, setKept] = useState<{ filter: ProjectFilter; ids: ReadonlySet<string> }>({
    filter,
    ids: new Set(),
  });
  const [opened, setOpened] = useState<{ filter: ProjectFilter; days: ReadonlySet<string> }>({
    filter,
    days: new Set(),
  });
  const keptIds = kept.filter === filter ? kept.ids : null;
  const openedDays = opened.filter === filter ? opened.days : null;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  /** Keeps a Block shown under the current filter (the User is writing in it, or it was revealed). */
  const keep = useCallback((id: string) => {
    const current = filterRef.current;
    if (current === 'everything') return;
    setKept((was) => {
      const ids = was.filter === current ? was.ids : new Set<string>();
      return ids.has(id) ? was : { filter: current, ids: new Set([...ids, id]) };
    });
  }, []);

  const filtered = filter === 'unfiled' ? 'Unfiled' : (projectById(filter)?.name ?? 'this Project');
  const views = useMemo(() => {
    const byDay = new Map<string, DayProjects>();
    for (const { day, outline } of days) {
      const dayFilter = openedDays?.has(day) ? 'everything' : filter;
      const view = filterView(outline, dayFilter, keptIds ?? undefined);
      const keepsOne = !!keptIds && [...keptIds].some((id) => outline.has(id));
      byDay.set(day, {
        view: { ...view, filings: effectiveFilings(outline) },
        collapsed: dayFilter !== 'everything' && view.matching === 0 && !keepsOne,
        filtered,
        onExpand: () =>
          setOpened((was) => ({
            filter,
            days: new Set([...(was.filter === filter ? was.days : []), day]),
          })),
      });
    }
    return byDay;
  }, [days, filter, keptIds, openedDays, filtered]);

  const counts = useMemo(() => noteCounts(savedProjects, days), [savedProjects, days]);
  return { views, counts, keep };
}

// The Badge picker for a Block, opened from its margin Badge: `b` is a typing key in the editor.
function useBlockPicker(notebook: Notebook) {
  const [target, setTarget] = useState<{
    day: string;
    block: Block;
    filing: Filing;
    anchor: HTMLElement;
  } | null>(null);
  const open = useCallback(
    (day: string, block: Block, filing: Filing, anchor: HTMLElement) =>
      setTarget({ day, block, filing, anchor }),
    [],
  );
  const close = useCallback(() => setTarget(null), []);
  const picker = target && (
    <BadgePicker
      target={{ id: target.block.id, title: target.block.text, filing: target.filing }}
      anchor={target.anchor}
      clearLabel={target.block.parentId ? 'Follow its parent' : 'Unfiled'}
      onClose={close}
      onPick={(projectId) => {
        setTarget(null);
        notebook.file(target.day, target.block.id, projectId);
      }}
    />
  );
  return { open, picker };
}

// The Notes Section: today's Daily Note on top, earlier days below in one stream, and the week strip.
function NotesSection() {
  const { active } = useSection();
  const slot = useHeaderSlot();
  const today = dayKey(useNow(60_000));
  const { projects } = useProjects();
  // The Notebook reads the `#LT` shorthand against the Projects as they are now.
  const projectsNow = useRef(projects);
  projectsNow.current = projects;
  const [api] = useState(() => dailyNotesIn(window.commander.itemStore));
  const [notebook] = useState(() =>
    createNotebook(api, {
      today,
      onError: (message) => toast(message),
      projects: () => projectsNow.current,
    }),
  );
  const state = useSyncExternalStore(notebook.subscribe, notebook.snapshot);

  // Which Projects every Daily Note has Blocks in, for the filter's counts; read again after changes.
  const [savedProjects, setSavedProjects] = useState<DailyNoteProjects[]>([]);
  const loadProjects = useCallback(() => {
    void api.projects?.().then(setSavedProjects, () => {});
  }, [api]);
  useEffect(() => {
    if (state.started) loadProjects();
  }, [state.started, loadProjects]);
  const noteFilter = useNoteFilter(state.days, savedProjects);
  const { keep } = noteFilter;
  const blockPicker = useBlockPicker(notebook);
  // A Block clicked into stays shown under the Project filter while the User writes in it.
  const stream = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = stream.current;
    if (!element) return;
    const onFocus = (event: FocusEvent) => {
      const id = event.target instanceof HTMLElement ? event.target.dataset.blockId : undefined;
      if (id) keep(id);
    };
    element.addEventListener('focusin', onFocus);
    return () => element.removeEventListener('focusin', onFocus);
  }, [keep]);

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
        loadProjects();
      }),
    [notebook, loadProjects],
  );
  // A Block opened from elsewhere (a Todo's made-from Link, the palette): its day comes on screen,
  // and it is scrolled to and highlighted. A Daily Note opened from the palette scrolls to its day.
  useReveal('notes', async (itemId) => {
    await notebook.start();
    // Shown even when the Project filter would leave it out.
    keep(itemId);
    const day = await notebook.reveal(itemId);
    if (!day) return;
    if (notebook.snapshot().days.some((d) => d.outline.has(itemId)))
      highlightBlock(withParents(notebook.snapshot(), itemId));
    else requestAnimationFrame(() => scrollToDay(day));
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
  const outlineProjects = useMemo<OutlineProjects>(
    () => ({ list: projects, pick: blockPicker.open }),
    [projects, blockPicker.open],
  );
  const controls = useMemo<OutlineControls>(
    () => ({
      notebook,
      focus(caret) {
        if (!caret) return;
        // A Block the caret goes to stays shown under the Project filter (a new one, say).
        keep(caret.id);
        pendingFocus.current = caret;
        requestAnimationFrame(applyFocus);
      },
      projects: outlineProjects,
    }),
    [notebook, applyFocus, keep, outlineProjects],
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
        <div className="n-stream" data-notes-stream="" ref={stream}>
          <Dimensions today={today} ready={state.started} />
          <div className="n-filter n-g8">
            <SectionProjectFilter className="n-pflt" counts={noteFilter.counts} />
          </div>
          {state.days.map((day, index) => (
            <DaySheet
              key={day.day}
              state={day}
              today={today}
              sheet={[index + 1, sheets]}
              projects={noteFilter.views.get(day.day)}
            />
          ))}
          <StreamEnd notebook={notebook} state={state} />
        </div>
        {blockPicker.picker}
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
