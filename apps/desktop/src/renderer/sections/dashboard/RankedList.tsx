import {
  type DashboardBand,
  dashboardBands,
  type FiledBy,
  githubIdentifier,
  type Item,
} from '@commander/domain';
import { AresText, CheckIcon, cn, Kbd, Led } from '@commander/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AskAres } from '../../links/AresButton';
import { ItemWarning } from '../../links/ItemWarning';
import { usePickBadge } from '../../projects/BadgePicker';
import { ItemBadge, useAccentBar } from '../../projects/badges';
import { useProjects } from '../../projects/context';
import { CalendarSwatch } from '../calendar/EventRow';
import { WorkStateIcon } from '../github/glyphs';
import { StateIcon } from '../linear/glyphs';
import { ChatTypeGlyph } from '../teams/ChatRow';
import { sectionFor } from '../todos/links';
import { type FeedRow, rowMeta, sourceTag } from './feed';
import { RowPrep } from './RowPrep';

/*
  The ranked list, after the prototype's FEED (.band, .it): band headers with their counts, then the
  rows, each with its number, tick box or state mark, Badge and accent bar, title, Source stamp and
  reason (Ares's words, shown as AresText), and when it is selected the bar of what can be done with
  it. A suggested Todo of Ares's is drawn as a suggestion (a dashed box and frame) with Add and
  Dismiss. The Dashboard drives it from the keyboard; a Project page shows it scoped to the Project.
*/

export const BANDS: Record<DashboardBand, { no: string; name: string; subtitle: string }> = {
  now: { no: 'B1', name: 'Now', subtitle: 'Overdue or urgent' },
  today: { no: 'B2', name: 'Today', subtitle: 'Before the day ends' },
  waiting: { no: 'B3', name: 'Waiting on others', subtitle: 'Someone else has the next move' },
  fyi: { no: 'B4', name: 'FYI', subtitle: 'Worth knowing. Nothing to do.' },
};

const SECTION_LABELS: Record<string, string> = {
  todos: 'Todos',
  linear: 'Linear',
  calendar: 'Calendar',
  teams: 'Teams',
  github: 'GitHub',
  email: 'Email',
};

/** Where in it to show: the message that put a Chat on the Dashboard, or a Teams suggestion's message. */
export const revealFocus = (row: FeedRow) => row.focus?.messageId ?? row.suggestion?.fromMessage?.messageId;

/** The Item to show when a row is opened in its Section: a suggestion's Block, else the row's Item. */
export const revealId = (row: FeedRow) =>
  row.suggestion?.blockId ??
  // A review request opens its pull request.
  (row.item.detail?.kind === 'review-request' ? row.item.detail.pullRequestId : null) ??
  row.item.id;
const HOW: Record<FiledBy, string> = {
  user: 'Set by you',
  rule: 'Filed by a Rule',
  ares: 'Filed by Ares',
  inherited: 'Follows its source',
};

const pad = (n: number) => String(n).padStart(2, '0');
/** A row's title as the Badge picker and the row name it: a Linear issue with its identifier. */
export const titleOf = ({ item }: FeedRow) => {
  const prefix = identifierOf(item);
  return prefix ? `${prefix} ${item.title}` : item.title;
};

// What people call it, shown before its title: a Linear issue's ENG-418, a GitHub acme/api#12.
function identifierOf(item: Item): string | null {
  if (item.detail?.kind === 'linear-issue') return item.detail.identifier;
  if (item.detail?.kind === 'review-request' || item.detail?.kind === 'pull-request')
    return githubIdentifier(item.detail.repo, item.detail.number);
  return null;
}

/**
 * Which Section an Item opens in, by its id, with its name: ["todos", "Todos"]. A suggestion opens its
 * Block, or its Chat for one from Teams.
 */
export function openIn(row: FeedRow): [string, string] | null {
  if (row.suggestion) return row.suggestion.fromMessage ? ['teams', 'Teams'] : ['notes', 'Notes'];
  const section = sectionFor(row.item.kind);
  return section ? [section, SECTION_LABELS[section] ?? section] : null;
}

/** The list's selection: always a shown row, kept at the same place when its row goes (cleared). */
export function useFeedSelection(rows: readonly FeedRow[]): {
  selected: FeedRow | null;
  select(itemId: string): void;
  move(step: 1 | -1): void;
} {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const selected =
    rows.find((row) => row.item.id === selectedId) ??
    rows[Math.min(lastIndex.current, rows.length - 1)] ??
    null;
  useEffect(() => {
    if (selected) lastIndex.current = rows.indexOf(selected);
  }, [selected, rows]);
  return {
    selected,
    select: setSelectedId,
    move(step) {
      if (!rows.length) return;
      const index = selected ? rows.indexOf(selected) : -1;
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))];
      if (next) setSelectedId(next.item.id);
    },
  };
}

export interface RowActions {
  onSelect(row: FeedRow): void;
  onOpen(row: FeedRow): void;
  onTick(row: FeedRow): void;
  onClear(row: FeedRow): void;
  /** Adds a suggested Todo, or dismisses it. */
  onSettle(row: FeedRow, op: 'accept' | 'dismiss'): void;
}

/**
 * The ranked list: the four bands in order, each with its header and rows (or a hatched "Nothing
 * here"), numbered down the list. `empty` words an empty band (it depends on the Project filter).
 */
export function RankedList({
  rows,
  selectedId,
  now,
  empty,
  ...actions
}: {
  rows: readonly FeedRow[];
  selectedId: string | null;
  now: number;
  empty: string;
} & RowActions) {
  let number = 0;
  return (
    <div data-testid="ranked-list">
      {dashboardBands.map((band) => {
        const inBand = rows.filter((row) => row.band === band);
        return (
          <Band key={band} band={band} rows={inBand}>
            {inBand.length ? (
              <ol className="m-0 list-none p-0">
                {inBand.map((row) => {
                  number += 1;
                  return (
                    <Row
                      key={row.item.id}
                      row={row}
                      number={number}
                      selected={row.item.id === selectedId}
                      now={now}
                      {...actions}
                    />
                  );
                })}
              </ol>
            ) : (
              <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">
                {empty}
              </p>
            )}
          </Band>
        );
      })}
    </div>
  );
}

function Band({
  band,
  rows,
  children,
}: {
  band: DashboardBand;
  rows: readonly FeedRow[];
  children: ReactNode;
}) {
  const { no, name, subtitle } = BANDS[band];
  const done = rows.filter((row) => row.done).length;
  const open = rows.length - done;
  return (
    <section
      aria-label={name}
      data-band={band}
      className="[&+&]:mt-3.5 [&+&>h2]:border-t [&+&>h2]:border-line"
    >
      <h2 className="sticky top-(--body) z-5 m-0 flex h-[34px] items-center gap-3 border-b border-line bg-sheet pr-5 pl-13">
        <span className="absolute left-0 w-10 text-center font-mono text-label leading-none font-semibold tracking-mono text-muted">
          {no}
        </span>
        <span
          className={cn(
            'font-sans text-[12.5px] leading-none font-extrabold uppercase tracking-heading whitespace-nowrap font-stretch-(--stretch-wider)',
            band === 'now' ? 'bg-ink px-2 pt-[5px] pb-1 text-sheet' : 'text-ink',
            !rows.length && 'opacity-50',
          )}
        >
          {name}
        </span>
        <span className="flex min-w-0 items-center gap-2 truncate font-sans text-note font-normal tracking-normal normal-case text-muted">
          {band === 'now' && open > 0 && <Led size="sm" />}
          {subtitle}
        </span>
        <span
          className="ml-auto font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink"
          data-testid="band-count"
        >
          {pad(open)} <span className="font-medium text-faint">{band === 'fyi' ? 'to know' : 'open'}</span>
          {done > 0 && (
            <>
              {' · '}
              {pad(done)} <span className="font-medium text-faint">done</span>
            </>
          )}
        </span>
      </h2>
      {children}
    </section>
  );
}

function Row({
  row,
  number,
  selected,
  now,
  onSelect,
  onOpen,
  onTick,
  onClear,
  onSettle,
}: { row: FeedRow; number: number; selected: boolean; now: number } & RowActions) {
  const element = useRef<HTMLLIElement>(null);
  const { item, done, suggestion } = row;
  const tag = sourceTag(item, !!suggestion);
  const [big, small] = rowMeta(row, now);
  const section = openIn(row);
  const title = titleOf(row);
  useEffect(() => {
    if (selected) element.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // The mouse selects and double-click opens; the keyboard moves with j/k and opens with Enter.
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k, Enter, x, e and b work from the keyboard (the Dashboard's shortcuts)
    <li
      ref={element}
      aria-current={selected || undefined}
      aria-label={title}
      data-testid="dashboard-row"
      data-band={row.band}
      data-suggestion={suggestion ? '' : undefined}
      onClick={() => onSelect(row)}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) onOpen(row);
      }}
      className={cn(
        'relative grid scroll-mt-[120px] grid-cols-[24px_25px_minmax(0,1fr)_88px] gap-x-3 border-b border-line2 pt-2.5 pr-5 pb-[11px] pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
        suggestion && 'outline-1 -outline-offset-4 outline-dashed outline-line',
      )}
    >
      <span
        className={cn(
          'absolute top-2.5 left-0 w-10 text-center font-mono text-label leading-[22px] tabular-nums select-none',
          selected ? 'font-semibold text-signal-ink' : 'font-medium text-faint',
        )}
      >
        {pad(number)}
      </span>
      <Marker row={row} onTick={() => onTick(row)} />
      <span className="flex h-[22px] items-center">
        <RowBadge row={row} title={title} />
      </span>
      <div className="min-w-0">
        <div
          className={cn(
            'font-sans text-row leading-[22px] font-semibold tracking-[-0.006em]',
            done ? 'text-faint line-through decoration-1' : 'text-ink',
          )}
        >
          {identifierOf(item) && (
            <span className="mr-[9px] font-mono text-code-lg leading-[22px] font-medium tracking-mono text-muted no-underline">
              {identifierOf(item)}
            </span>
          )}
          {item.title}
        </div>
        <div className={cn('mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-[5px]', done && 'opacity-55')}>
          <span
            data-testid="source-stamp"
            className="inline-flex h-[19px] items-center gap-1.5 border border-line bg-sheet px-1.5 font-mono text-label leading-none font-medium uppercase tracking-tag whitespace-nowrap text-muted"
          >
            <b className="font-semibold text-ink">{tag.stamp}</b>
            {tag.text}
          </span>
          <ItemWarning item={item} className="h-[19px]" />
          {!suggestion && <AskAres item={item} className="size-[19px]" />}
          {/* A reason may be Ares's words: shown as AresText, linking only what the Item holds. */}
          <span className="ml-1 text-note leading-[19px] text-muted" data-testid="row-reason">
            <AresText
              inline
              text={row.reason}
              sources={suggestion ? [item.title, suggestion.source] : wordsOf(item)}
            />
          </span>
          {suggestion && (
            <span className="ml-auto flex">
              <button
                type="button"
                className={cn(
                  barButton,
                  'h-[22px] border-ink bg-ink text-sheet hover:bg-ink hover:opacity-90',
                )}
                title="Add it as a Todo (A)"
                onClick={(event) => {
                  event.stopPropagation();
                  onSettle(row, 'accept');
                }}
              >
                Add
              </button>
              <button
                type="button"
                className={cn(barButton, 'h-[22px]')}
                title="Ares won’t offer it again for this Block’s text"
                onClick={(event) => {
                  event.stopPropagation();
                  onSettle(row, 'dismiss');
                }}
              >
                Dismiss
              </button>
            </span>
          )}
        </div>
        {/* A meeting's prep (#130), folded under its row. */}
        <RowPrep item={item} />
      </div>
      <div className="pt-px text-right">
        <b className="block font-mono text-[12px] leading-5 font-semibold tracking-badge uppercase tabular-nums text-ink">
          {big}
        </b>
        <span className="block font-mono text-tiny leading-[1.2] font-medium uppercase tracking-caps text-muted">
          {small}
        </span>
      </div>
      {selected && (
        <ActionBar
          row={row}
          section={section}
          onOpen={() => onOpen(row)}
          onTick={() => onTick(row)}
          onClear={() => onClear(row)}
          onAdd={() => onSettle(row, 'accept')}
        />
      )}
    </li>
  );
}

// A Todo's tick box (a button: it ticks), a Linear issue's workflow state, a meeting's calendar
// colour, a Chat's type, or a suggestion's dashed box.
function Marker({ row, onTick }: { row: FeedRow; onTick: () => void }) {
  const { item, done } = row;
  if (item.detail?.kind === 'event')
    return (
      <span className="grid h-[22px] place-items-center" title={item.detail.calendar.name}>
        <CalendarSwatch colour={item.detail.calendar.colour} />
      </span>
    );
  if (row.suggestion)
    return (
      <span className="grid h-[22px] place-items-center" title="Suggested by Ares">
        <span aria-hidden="true" className="size-3.5 border-[1.5px] border-dashed border-muted" />
      </span>
    );
  if (item.detail?.kind === 'linear-issue')
    return (
      <span className="grid h-[22px] place-items-center" title={item.detail.state.name}>
        <StateIcon type={item.detail.state.type} />
      </span>
    );
  if (item.detail?.kind === 'chat')
    return (
      <span className="grid h-[22px] place-items-center">
        <ChatTypeGlyph type={item.detail.chatType} className="w-6" />
      </span>
    );
  // A Channel post (#111): nothing to tick (it is answered in the Teams Section).
  if (item.detail?.kind === 'channel-post')
    return (
      <span
        className="grid h-[22px] place-items-center font-mono text-label-lg font-semibold text-muted"
        title={`Channel post in ${item.detail.team.name} / ${item.detail.channel.name}`}
      >
        #
      </span>
    );
  // An email thread: nothing to tick (it is answered, or sorted, in the Email Section).
  if (item.detail?.kind === 'email')
    return (
      <span className="grid h-[22px] place-items-center" title="Email">
        <EnvelopeGlyph />
      </span>
    );
  // The User's pull request: nothing to tick, its state instead.
  if (item.detail?.kind === 'pull-request')
    return (
      <span className="grid h-[22px] place-items-center" title={item.detail.draft ? 'Draft' : 'Open'}>
        <WorkStateIcon state={item.detail.draft ? 'draft' : 'open'} />
      </span>
    );
  return (
    <button
      type="button"
      title="Tick (X)"
      aria-label={`${done ? 'Untick' : 'Tick'} ${item.title}`}
      aria-pressed={done}
      onClick={(event) => {
        event.stopPropagation();
        onTick();
      }}
      className="grid h-[22px] cursor-pointer place-items-center border-0 bg-transparent p-0 text-sheet [&:hover>span]:border-ink"
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-3.5 place-items-center border-[1.5px]',
          done ? 'border-ink bg-ink' : 'border-muted',
        )}
      >
        {done && <CheckIcon />}
      </span>
    </button>
  );
}

// The row's Badge, with its Project's accent as the thin left bar. Clicking it opens the Badge picker.
function RowBadge({ row, title }: { row: FeedRow; title: string }) {
  const pick = usePickBadge();
  const bar = useAccentBar(row.item.filing);
  const { item } = row;
  return (
    <>
      {bar && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-px bottom-0 left-[39px] w-0.5"
          style={{ background: bar }}
        />
      )}
      {pick && !row.suggestion ? (
        <button
          type="button"
          data-item-id={item.id}
          title="Change the Project (B)"
          aria-label={`Project of ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            pick(
              { id: item.id, title, filing: item.filing, filingSuggestion: item.filingSuggestion },
              event.currentTarget,
            );
          }}
          className="flex cursor-pointer border-0 bg-transparent p-0 hover:outline hover:outline-offset-1 hover:outline-ink focus-visible:outline focus-visible:outline-offset-1 focus-visible:outline-ink"
        >
          <ItemBadge filing={item.filing} suggestion={item.filingSuggestion} />
        </button>
      ) : (
        <span data-item-id={item.id} className="flex">
          <ItemBadge filing={item.filing} suggestion={item.filingSuggestion} />
        </span>
      )}
    </>
  );
}

const barButton =
  'flex h-7 cursor-pointer items-center gap-2 border border-line bg-sheet px-2.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:bg-raise [&+&]:border-l-0 [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:border-current [&_kbd]:text-label [&_kbd]:text-inherit [&_kbd]:opacity-80';

// Everything an Item says, for what Ares writes about it to link to (AresText).
function wordsOf(item: Item): string[] {
  if (item.detail?.kind === 'chat')
    return [item.title, ...item.detail.messages.map((message) => message.text)];
  if (item.detail?.kind === 'channel-post')
    return [item.title, item.detail.post.text, ...item.detail.replies.map((message) => message.text)];
  if (item.detail?.kind === 'pull-request') return [item.title, item.detail.body];
  if (item.detail?.kind !== 'linear-issue') return [item.title];
  const { description, comments } = item.detail;
  return [item.title, description ?? '', ...comments.map((comment) => comment.body)];
}

// What can be done with the selected row (.bar): tick, open in its Section, clear; and its Project.
function ActionBar({
  row,
  section,
  onOpen,
  onTick,
  onClear,
  onAdd,
}: {
  row: FeedRow;
  section: [string, string] | null;
  onOpen: () => void;
  onTick: () => void;
  onClear: () => void;
  onAdd: () => void;
}) {
  const { projectOf } = useProjects();
  const project = projectOf(row.item.filing);
  const stop = (run: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    run();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics
    <div role="group" aria-label="Actions" className="col-[3/5] mt-2.5 flex flex-wrap items-center">
      <ItemWarning item={row.item} variant="pane" className="mb-2.5 basis-full" />
      {row.suggestion && (
        <button type="button" className={barButton} onClick={stop(onAdd)}>
          <Kbd>A</Kbd>
          Add
        </button>
      )}
      {row.item.kind === 'todo' && !row.suggestion && (
        <button type="button" className={barButton} onClick={stop(onTick)}>
          <Kbd>X</Kbd>
          {row.done ? 'Untick' : 'Tick'}
        </button>
      )}
      {section && (
        <button
          type="button"
          className={cn(barButton, 'border-ink bg-ink text-sheet hover:bg-ink hover:opacity-90')}
          onClick={stop(onOpen)}
        >
          <Kbd>↵</Kbd>
          Open in {section[1]}
        </button>
      )}
      <button type="button" className={barButton} onClick={stop(onClear)}>
        <Kbd>E</Kbd>
        Clear
      </button>
      {!row.suggestion && (
        <AskAres item={row.item} variant="pane" className="ml-2.5 h-7 px-2.5 text-label-lg" />
      )}
      <span className="ml-3.5 font-mono text-label leading-none font-medium uppercase tracking-label text-faint">
        Clear hides it here. It stays in its Section.
      </span>
      <span className="mt-2.5 flex basis-full items-center gap-2 font-mono text-label leading-none font-medium uppercase tracking-label text-muted [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-label">
        <ItemBadge filing={row.item.filing} suggestion={row.item.filingSuggestion} size="sm" />
        <b className="font-semibold text-ink">{project ? project.name : 'Unfiled'}</b>
        {row.item.filing && <> · {HOW[row.item.filing.filedBy]}</>}
        {!row.suggestion && (
          <>
            {' '}
            · <Kbd>B</Kbd> to change
          </>
        )}
      </span>
    </div>
  );
}

function EnvelopeGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 text-muted">
      <path d="M2 3.5h12v9H2zM2 4l6 4.5L14 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
