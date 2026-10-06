import {
  type QueuedAction,
  type RowAction,
  type SnoozeChoice,
  UPDATE_GROUP_NAMES,
  UPDATE_SECTION_NAMES,
  type UpdateRow,
  type UpdateViewLine,
  updateGroups,
} from '@commander/domain';
import {
  AresText,
  Button,
  ButtonGroup,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@commander/ui';
import { useRef, useState } from 'react';
import type { PanelState } from './context';
import { acceptLabel, foldedSummary, lineRows, lineStatus, ROW_ACTION_LABELS, rowName } from './updates';

const pad = (n: number) => String(n).padStart(2, '0');
const when = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface UpdatePanelProps {
  state: PanelState;
  onClose(): void;
  onAct(line: UpdateViewLine, action: QueuedAction, snooze?: SnoozeChoice): void;
  /** Open on a line, or on one of its Items where it lives (`reply`: at the message waiting on the User). */
  onOpen(line: UpdateViewLine, row?: UpdateRow, reply?: boolean): void;
  /** One of a line's Items, acted on: accept, dismiss, tick, or Not an instruction. */
  onActRow(line: UpdateViewLine, row: UpdateRow, action: RowAction): void;
  onShowHistory(): void;
  onReopen(id: number): void;
}

/**
 * The Update (#70): what Ares has queued, in three groups (needs you now, waiting on your decision,
 * for your information), each line one or two plain sentences with Done, Dismiss, Snooze and Open,
 * and suggestions accepted in place. Under each line, its Items (#186): each named, stamped with its
 * Section, with where it stands and its own actions, opening where it lives; folded when there are
 * many. After real time away the smaller things fold below the lead. Esc closes it; anything
 * untouched stays queued. Past Updates reopens earlier ones.
 */
export function UpdatePanel({
  state,
  onClose,
  onAct,
  onOpen,
  onActRow,
  onShowHistory,
  onReopen,
}: UpdatePanelProps) {
  const content = useRef<HTMLDivElement>(null);
  const open = state.mode !== 'closed';
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="w-[min(720px,calc(100vw-48px))]"
        data-testid="update-panel"
        ref={content}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        <DialogHeader partNumber="UPD">
          <DialogTitle>{titleOf(state)}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          What Ares has queued for you since you last asked. Esc closes it; anything you leave stays queued.
        </DialogDescription>
        <div className="max-h-[calc(100vh-180px)] overflow-auto">
          {state.mode === 'loading' && <Note>Ares is putting your Update together…</Note>}
          {state.mode === 'history' && <History list={state.list} onReopen={onReopen} />}
          {state.mode === 'update' && (
            <Update state={state} onAct={onAct} onOpen={onOpen} onActRow={onActRow} />
          )}
        </div>
        {state.mode !== 'loading' && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
            <span className="font-mono text-label uppercase tracking-label text-faint">
              {state.mode === 'update' && state.view?.voice === 'template'
                ? 'Plain sentences: Ares’s model wasn’t available'
                : ''}
            </span>
            {state.mode === 'history' ? (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Close
              </Button>
            ) : (
              <Button size="sm" onClick={onShowHistory}>
                Past Updates
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function titleOf(state: PanelState): string {
  if (state.mode === 'history') return 'Past Updates';
  if (state.mode === 'update' && state.view) {
    return `${state.past ? 'Past Update' : 'Update'} · ${when.format(state.view.at)}`;
  }
  return 'Update';
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="hatch m-0 px-6 py-6 text-heading text-muted">{children}</p>;
}

type LineHandlers = Pick<UpdatePanelProps, 'onAct' | 'onOpen' | 'onActRow'>;

function Update({ state, ...handlers }: { state: Extract<PanelState, { mode: 'update' }> } & LineHandlers) {
  const { view } = state;
  if (!view) return <Note>Nothing new since you last asked.</Note>;
  const lead = view.lines.filter((line) => !line.folded);
  const folded = foldedSummary(view.lines);
  return (
    <div>
      {updateGroups.map((group) => {
        const lines = lead.filter((line) => line.group === group);
        if (!lines.length) return null;
        return (
          <section key={group} aria-label={UPDATE_GROUP_NAMES[group]} className="border-b border-line2">
            <h3 className="m-0 flex h-7.5 items-center justify-between border-b border-line2 px-3 font-mono text-label leading-none font-semibold uppercase tracking-label text-ink">
              {UPDATE_GROUP_NAMES[group]}
              <span className="font-medium text-faint">{pad(lines.length)}</span>
            </h3>
            <ol className="m-0 list-none p-0">
              {lines.map((line) => (
                <Line key={line.queuedId} line={line} {...handlers} />
              ))}
            </ol>
          </section>
        );
      })}
      {folded.count > 0 && (
        <details className="border-b border-line2" data-testid="update-folded">
          <summary className="cursor-pointer px-3 py-2.5 text-note text-muted">
            <span className="font-semibold text-ink">{folded.text}</span>
            {folded.bySection.length > 0 && (
              <span> · {folded.bySection.map((each) => `${each.count} in ${each.name}`).join(' · ')}</span>
            )}
          </summary>
          <ol className="m-0 list-none p-0" aria-label="The smaller things">
            {view.lines
              .filter((line) => line.folded)
              .map((line) => (
                <Line key={line.queuedId} line={line} {...handlers} />
              ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function Line({ line, onAct, onOpen, onActRow }: { line: UpdateViewLine } & LineHandlers) {
  const [snoozing, setSnoozing] = useState(false);
  const status = lineStatus(line, Date.now());
  const accept = acceptLabel(line);
  const { rows, folded } = lineRows(line);
  const waiting = line.queued?.status === 'queued';
  return (
    <li
      data-testid="update-line"
      aria-label={line.text}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5 border-b border-line2 px-3 py-2.5 last:border-b-0',
        waiting && !status && 'shadow-[inset_3px_0_0_var(--signal)]',
      )}
    >
      <p className="m-0 min-w-0 text-row leading-6 text-ink">
        {line.fresh && waiting && (
          <span className="mr-2 border border-signal px-[5px] font-mono text-label uppercase tracking-label text-signal-ink">
            New
          </span>
        )}
        <AresText inline text={line.text} sources={line.sources} />
      </p>
      <div className="flex items-center gap-2">
        {status ? (
          <span
            data-testid="update-line-status"
            className="font-mono text-label uppercase tracking-label text-muted"
          >
            {status}
          </span>
        ) : null}
      </div>
      {rows.length > 0 &&
        (folded ? (
          <details className="col-span-2" data-testid="update-rows-folded">
            <summary className="cursor-pointer text-note text-muted">Show all {rows.length}</summary>
            <Rows line={line} rows={rows} onOpen={onOpen} onActRow={onActRow} />
          </details>
        ) : (
          <Rows line={line} rows={rows} onOpen={onOpen} onActRow={onActRow} />
        ))}
      {waiting && (
        <div className="col-span-2 flex flex-wrap items-center gap-2">
          {accept && (
            <Button size="sm" variant="signal" onClick={() => onAct(line, 'accept')}>
              {accept}
            </Button>
          )}
          <ButtonGroup>
            <Button size="sm" onClick={() => onAct(line, 'done')}>
              Done
            </Button>
            <Button size="sm" onClick={() => onAct(line, 'dismiss')}>
              Dismiss
            </Button>
            <Button size="sm" aria-expanded={snoozing} onClick={() => setSnoozing((now) => !now)}>
              Snooze
            </Button>
            <Button size="sm" onClick={() => onOpen(line)}>
              Open
            </Button>
          </ButtonGroup>
          {snoozing && (
            <ButtonGroup aria-label="Snooze until">
              <Button size="sm" variant="ghost" onClick={() => onAct(line, 'snooze', 'later-today')}>
                Later today
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onAct(line, 'snooze', 'tomorrow')}>
                Tomorrow
              </Button>
            </ButtonGroup>
          )}
        </div>
      )}
    </li>
  );
}

/** A line's Items: each named (opening where it lives), stamped with its Section, with its own actions. */
function Rows({
  line,
  rows,
  onOpen,
  onActRow,
}: { line: UpdateViewLine; rows: UpdateRow[] } & Pick<LineHandlers, 'onOpen' | 'onActRow'>) {
  return (
    <ul aria-label="Its items" className="col-span-2 m-0 list-none border-l border-line2 p-0 pl-3">
      {rows.map((row) => {
        const name = rowName(row);
        const actions = row.actions.filter((action) => action !== 'open');
        return (
          <li
            key={row.itemId}
            data-testid="update-row"
            aria-label={row.label ? `${row.label} ${row.title}` : row.title}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1 text-note leading-5"
          >
            <span className="min-w-0">
              <span
                data-testid="update-row-section"
                className="mr-2 border border-line px-[5px] font-mono text-label uppercase tracking-label text-muted"
              >
                {UPDATE_SECTION_NAMES[row.section]}
              </span>
              <button
                type="button"
                aria-label={`Open ${name}`}
                onClick={() => onOpen(line, row)}
                className="cursor-pointer border-0 bg-transparent p-0 text-left text-ink underline-offset-2 hover:underline"
              >
                {row.label && (
                  <span className="mr-1.5 font-mono text-label font-semibold tracking-label">
                    {row.label}
                  </span>
                )}
                {row.title}
              </button>
              <span className="text-muted"> · {row.state}</span>
              {row.quote && (
                <q data-testid="update-row-quote" className="mt-0.5 block text-muted italic">
                  {row.quote}
                </q>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              {row.settled ? (
                <span className="font-mono text-label uppercase tracking-label text-muted">
                  {row.settled}
                </span>
              ) : (
                actions.map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="ghost"
                    aria-label={`${ROW_ACTION_LABELS[action]}: ${name}`}
                    onClick={() =>
                      action === 'reply' ? onOpen(line, row, true) : onActRow(line, row, action as RowAction)
                    }
                  >
                    {ROW_ACTION_LABELS[action]}
                  </Button>
                ))
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function History({
  list,
  onReopen,
}: {
  list: Extract<PanelState, { mode: 'history' }>['list'];
  onReopen(id: number): void;
}) {
  if (!list) return <Note>Loading…</Note>;
  if (!list.length) return <Note>No Updates yet.</Note>;
  return (
    <ol className="m-0 list-none p-0" aria-label="Past Updates">
      {list.map((update) => (
        <li key={update.id} className="border-b border-line2 last:border-b-0">
          <button
            type="button"
            onClick={() => onReopen(update.id)}
            className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-3 py-2.5 text-left text-row text-ink hover:bg-raise"
          >
            <span>{when.format(update.at)}</span>
            <span className="font-mono text-label uppercase tracking-label text-muted">
              {update.lines} thing{update.lines === 1 ? '' : 's'}
              {update.folded ? ' · after time away' : ''}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
