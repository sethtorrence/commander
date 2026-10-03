import type { ActivityEntry, Item } from '@commander/domain';
import { cn, Kbd } from '@commander/ui';
import type { ReactNode } from 'react';
import { shortDate } from '../../../frame/calendar';
import { originLabel } from '../origin';
import { TodoProject } from '../project';
import type { MadeFrom, TodoLink } from '../todos';
import { timeOfDay } from '../when';
import { Eyebrow } from './parts';
import { TitleField } from './TitleField';
import { TodoActivity } from './TodoActivity';
import { TodoLinks } from './TodoLinks';

/**
 * The detail pane beside the list, after the prototype's reader and Calendar detail: actions along
 * the top, then the editable title, its facts, its Links both ways and its activity log.
 */
export function TodoDetail({
  todo,
  madeFrom,
  links,
  history,
  onRename,
  onTick,
  onDelete,
  onClose,
  onOpenLink,
}: {
  todo: Item | null;
  /** For a Todo made from a Block: where, for its origin. */
  madeFrom?: MadeFrom;
  links: TodoLink[];
  history: ActivityEntry[];
  onRename: (title: string) => void;
  onTick: () => void;
  onDelete: () => void;
  onClose: () => void;
  onOpenLink: (link: TodoLink) => void;
}) {
  const done = todo?.status === 'done';
  return (
    <section aria-label="Todo detail" className="min-w-0 border-l border-line">
      <div className="sticky top-(--body) max-h-[calc(100vh-var(--body))] overflow-auto [scrollbar-width:thin]">
        <div className="sticky top-0 z-2 flex h-11 items-stretch border-b border-line bg-sheet">
          {todo && (
            <>
              <Action keys="X" onClick={onTick}>
                {done ? 'Untick' : 'Tick'}
              </Action>
              <Action keys="Del" onClick={onDelete}>
                Delete
              </Action>
            </>
          )}
          <span className="flex-1" />
          <Action keys="Esc" onClick={onClose} className="border-r-0 border-l">
            Close
          </Action>
        </div>
        {todo ? (
          <div className="px-[22px] pt-[18px] pb-24">
            <Eyebrow>{done ? 'Done' : 'Open'} · Todo</Eyebrow>
            <TitleField key={todo.id} title={todo.title} onSave={onRename} />
            <p className="m-0 font-sans text-[16px] leading-[1.3] font-light text-muted">
              Added {shortDate(new Date(todo.createdAt))} · {timeOfDay(todo.createdAt)}
            </p>
            <dl className="mt-3.5 mb-0 border-t border-line">
              <Fact label="Status">{done ? 'Done' : 'Open'}</Fact>
              <Fact label="Origin">{originLabel(todo, madeFrom)}</Fact>
              <Fact label="Project">
                <TodoProject todo={todo} />
              </Fact>
            </dl>
            <TodoLinks links={links} onOpen={onOpenLink} />
            <TodoActivity entries={history} />
          </div>
        ) : (
          <p className="m-0 px-[22px] py-[18px] text-note text-faint">No Todo selected.</p>
        )}
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2.5 border-b border-line2 py-[7px] font-mono text-label-lg leading-[1.3] font-medium uppercase tracking-tag">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 text-right font-semibold text-ink">{children}</dd>
    </div>
  );
}

function Action({
  keys,
  onClick,
  className,
  children,
}: {
  keys: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center gap-[9px] border-0 border-r border-line2 bg-transparent px-3.5 font-mono text-label-lg leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink hover:bg-raise [&_kbd]:h-[18px] [&_kbd]:text-label',
        className,
      )}
    >
      <Kbd>{keys}</Kbd>
      {children}
    </button>
  );
}
