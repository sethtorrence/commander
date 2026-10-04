import { localDay } from '@commander/domain';
import { Kbd, SheetStripCell, toast } from '@commander/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { clockTime } from '../../frame/calendar';
import { requestReveal } from '../../frame/reveal';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { SideCard } from '../../projects/page/SideCard';
import { useShortcuts } from '../../shortcuts/react';
import { longDate, notePartNumber, weekday } from '../notes/days';
import { SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { useDashboard } from './context';
import { type FeedRow, tabCount } from './feed';
import { openIn, RankedList, revealId, titleOf, useFeedSelection } from './RankedList';

const pad = (n: number) => String(n).padStart(2, '0');

// Enter opens the selected row, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

/** How an empty band reads under the Project filter. */
export function useEmptyBandText(): string {
  const { filter } = useProjectFilter();
  const { projectById } = useProjects();
  if (filter === 'everything') return 'Nothing here.';
  if (filter === 'unfiled') return 'Nothing Unfiled in this band.';
  return `Nothing for ${projectById(filter)?.name ?? 'this Project'} in this band.`;
}

/**
 * The Dashboard Section's sheet, after the prototype's FEED: "What needs you", the Project filter,
 * then the ranked list in bands (Now, Today, Waiting on others, FYI), driven from the keyboard, with
 * the side column holding today's Daily Note and the open Todos.
 */
export function DashboardSheet() {
  const dashboard = useDashboard();
  const { shown, rows, counts, loaded } = dashboard;
  const { filter } = useProjectFilter();
  const { projectById } = useProjects();
  const { active } = useSection();
  const openSection = useOpenSection();
  const selection = useFeedSelection(shown);
  const { selected } = selection;
  const badges = useBadgePicker(dashboard.apply, (entryId) => void dashboard.undo(entryId));
  const empty = useEmptyBandText();
  const now = dashboard.rankedAt;

  useTabCount(loaded ? tabCount(shown) : null);

  // Coming back reads everything again; leaving lets go of the rows ticked here.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) dashboard.reload();
    if (!active && wasActive.current) dashboard.leave();
    wasActive.current = active;
  }, [active, dashboard.reload, dashboard.leave]);

  // The header's band meter jumps to a band: its first row selected, its header in view.
  const { jump } = dashboard;
  const { select } = selection;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new jump moves the selection
  useEffect(() => {
    if (!jump) return;
    const first = shown.find((row) => row.band === jump.band);
    if (first) select(first.item.id);
    document
      .querySelector(`[data-testid="section-dashboard"] section[data-band="${jump.band}"]`)
      ?.scrollIntoView?.({
        block: 'start',
      });
  }, [jump]);

  const open = (row: FeedRow) => {
    const section = openIn(row);
    if (!section) return;
    openSection(section[0]);
    requestReveal(section[0], revealId(row));
  };
  const settle = (row: FeedRow, op: 'accept' | 'dismiss') => void dashboard.settleSuggestion(row, op);
  useShortcuts([
    { keys: 'j', label: 'Next row', run: () => selection.move(1) },
    { keys: 'k', label: 'Previous row', run: () => selection.move(-1) },
    {
      keys: 'Enter',
      label: 'Open it in its Section',
      when: () => !onPressable(),
      run: () => selected && open(selected),
    },
    { keys: 'x', label: 'Tick or untick the Todo', run: () => selected && void dashboard.tick(selected) },
    { keys: 'e', label: 'Clear it from the Dashboard', run: () => selected && dashboard.clear(selected) },
    {
      keys: 'a',
      label: 'Add Ares’s suggested Todo',
      run: () => selected?.suggestion && settle(selected, 'accept'),
    },
    {
      keys: 'b',
      label: 'File under a Project',
      run: () => {
        if (!selected) return;
        if (selected.suggestion) {
          toast('Add it first: a suggestion takes the Project of its Block');
          return;
        }
        badges.open({ id: selected.item.id, title: titleOf(selected), filing: selected.item.filing });
      },
    },
    { keys: 'Ctrl+z', label: 'Undo', run: () => void dashboard.undo() },
  ]);

  const project = projectById(filter);
  const { rankedBy } = dashboard;
  const total = shown.filter((row) => !row.done).length;
  const today = localDay(now.getTime());
  return (
    <>
      <SectionSheet
        span="wide"
        title="What needs you"
        size="dashboard"
        status={
          <SheetStripCell data-testid="ranked-at" title={rankedBy.why ?? undefined}>
            {rankedBy.by === 'ares' && rankedBy.at
              ? `Ranked by Ares · ${clockTime(rankedBy.at).slice(0, 5)}`
              : `Ranked by rules · ${clockTime(now).slice(0, 5)}`}
          </SheetStripCell>
        }
        meta={<SheetStripCell>Todos and Linear merged</SheetStripCell>}
        subtitle={
          <>
            {weekday(today)} {longDate(today)} ·{' '}
            <b>
              {total} item{total === 1 ? '' : 's'}
            </b>
            {filter !== 'everything' && ` ${project ? `in ${project.name}` : 'Unfiled'}`}, {counts.now} of
            them in Now
          </>
        }
        aside={<Keys />}
        className="flex flex-col"
      >
        <SectionProjectFilter items={rows.filter((row) => !row.done).map((row) => row.item)} />
        <PickBadgeProvider value={badges.open}>
          <div className="flex-1 pb-[110px]">
            <RankedList
              rows={shown}
              selectedId={selected?.item.id ?? null}
              now={now.getTime()}
              empty={empty}
              onSelect={(row) => selection.select(row.item.id)}
              onOpen={open}
              onTick={(row) => void dashboard.tick(row)}
              onClear={dashboard.clear}
              onSettle={settle}
            />
            <FeedEnd ranked={shown.length} cleared={dashboard.cleared} onBringBack={dashboard.bringBack} />
          </div>
        </PickBadgeProvider>
        {badges.picker}
      </SectionSheet>
      <aside className="relative col-span-2 min-w-0" aria-label="Today’s Daily Note and your Todos">
        <div className="sticky top-(--body) mr-4 ml-3.5 flex max-h-[calc(100vh-var(--body))] flex-col gap-3.5 overflow-auto pt-3.5 pb-6 [scrollbar-width:none]">
          <DailyNoteCard day={today} active={active} openTodos={dashboard.openTodos} />
        </div>
      </aside>
    </>
  );
}

// The end of the list (.fend): how many are ranked, and the cleared rows a click away.
function FeedEnd({
  ranked,
  cleared,
  onBringBack,
}: {
  ranked: number;
  cleared: number;
  onBringBack: () => void;
}) {
  return (
    <div className="hatch mt-7.5 mr-5 ml-13 flex items-center gap-4 border border-dashed border-line px-[18px] py-3.5 text-heading text-muted">
      <span className="font-mono text-label-lg leading-none font-semibold uppercase tracking-tag whitespace-nowrap">
        End · {pad(ranked)} ranked
      </span>
      <span>
        {cleared ? (
          <>
            <b className="font-semibold text-text">{cleared} cleared</b> from the Dashboard.{' '}
            <button
              type="button"
              onClick={onBringBack}
              className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-ink underline underline-offset-3"
            >
              Bring them back
            </button>
          </>
        ) : (
          'That’s everything. The rest lives in its Section.'
        )}
      </span>
    </div>
  );
}

// Today's Daily Note entry point (.dn): the day, what's written so far, the open Todos, and the way in.
function DailyNoteCard({ day, active, openTodos }: { day: string; active: boolean; openTodos: number }) {
  const { dailyNote } = useDashboard();
  const openSection = useOpenSection();
  const [written, setWritten] = useState<string[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    dailyNote(day).then(
      (lines) => current && setWritten(lines),
      () => current && setWritten(null),
    );
    return () => {
      current = false;
    };
  }, [dailyNote, day, active]);
  return (
    <SideCard
      label="Today’s Daily Note"
      title={<span className="truncate">Daily Note · today</span>}
      note={notePartNumber(day)}
    >
      <div className="px-3 pt-3 pb-2.5">
        <div className="font-sans text-[22px] leading-[0.95] font-extrabold uppercase tracking-[-0.01em] text-ink font-stretch-(--stretch-widest)">
          {weekday(day)}
        </div>
        <div className="mt-1 font-sans text-ui leading-tight font-light text-muted">{longDate(day)}</div>
        <p
          className="m-0 mt-2.5 line-clamp-3 text-small leading-[18px] text-text"
          data-testid="daily-note-excerpt"
        >
          {written?.length ? (
            written.join(' ')
          ) : (
            <span className="text-faint">Nothing written yet today.</span>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={() => openSection('todos')}
        className="flex w-full cursor-pointer items-center justify-between border-0 border-y border-line2 bg-transparent px-3 py-1.5 font-mono text-label leading-[1.2] font-medium uppercase tracking-tag text-muted hover:bg-raise hover:text-ink"
      >
        <span>
          {openTodos} open Todo{openTodos === 1 ? '' : 's'}
        </span>
        <span className="font-semibold text-ink">{pad(openTodos)} ↗</span>
      </button>
      <button
        type="button"
        onClick={() => openSection('notes')}
        className="flex h-9 w-full cursor-pointer items-center justify-between border-0 bg-ink pr-2.5 pl-3 font-mono text-label-lg leading-none font-semibold uppercase tracking-caps text-sheet [&_kbd]:border-current [&_kbd]:text-inherit"
      >
        <span>Open the Daily Note</span>
        <Kbd>2</Kbd>
      </button>
    </SideCard>
  );
}

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="enter">↵</Kbd>, 'Open'],
  [
    <>
      <Kbd>1</Kbd>–<Kbd>8</Kbd>
    </>,
    'Sections',
  ],
  [<Kbd key="x">X</Kbd>, 'Tick'],
  [<Kbd key="e">E</Kbd>, 'Clear'],
  [<Kbd key="a">A</Kbd>, 'Add'],
  [
    <>
      <Kbd>P</Kbd>
      <Kbd>1</Kbd>–<Kbd>9</Kbd>
    </>,
    'Project',
  ],
  [<Kbd key="b">B</Kbd>, 'Badge'],
];

/** The Dashboard's keys at a glance, beside its title (.fkeys). All of them are in the `?` cheat sheet. */
function Keys() {
  return (
    <div className="grid grid-cols-[auto_auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted max-[1440px]:grid-cols-[auto_auto] [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}
