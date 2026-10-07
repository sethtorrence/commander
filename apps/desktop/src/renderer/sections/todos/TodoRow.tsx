import type { Item } from '@commander/domain';
import { labelBlockLinks } from '@commander/domain';
import { CheckIcon, cn } from '@commander/ui';
import { useEffect, useRef } from 'react';
import { AskAres } from '../../links/AresButton';
import { ItemWarning } from '../../links/ItemWarning';
import { ChipText } from '../../links/MentionedIn';
import { useChipLabel } from '../../links/use-chip-label';
import { originLabel } from './origin';
import { TodoBadge } from './project';
import type { MadeFrom } from './todos';

const pad = (n: number) => String(n).padStart(3, '0');

/** A Todo's row (.td): number, tick box, Badge, title and origin. */
export function TodoRow({
  todo,
  number,
  madeFrom,
  backing,
  selected,
  onSelect,
  onOpen,
  onTick,
}: {
  todo: Item;
  number: number;
  /** For a Todo made from a Block: where, for its origin ("Daily Note · 3 Oct"). */
  madeFrom?: MadeFrom;
  /** For a backed Todo: the Item behind it, for its origin ("Linear · ENG-418"). */
  backing?: Item;
  selected: boolean;
  /** Selects the row (clicking its tick box). */
  onSelect: () => void;
  /** Selects the row and opens it in the detail pane (clicking the rest of the row). */
  onOpen: () => void;
  onTick: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const done = todo.status === 'done';
  // A Todo made from a Block has its text as title, `[[` links included: they read as chips.
  const label = useChipLabel();
  const title = labelBlockLinks(todo.title, (target) => label(target).text);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // Opening with the mouse; the keyboard moves the selection with j and k and opens with Enter.
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k and Enter work from the keyboard (TodosSheet's shortcuts)
    <li
      ref={row}
      aria-current={selected || undefined}
      onClick={onOpen}
      className={cn(
        'relative flex min-h-10 cursor-default items-start border-b border-line2 py-[5px] pr-5 pl-13',
        selected
          ? 'bg-signal-focus shadow-[inset_3px_0_0_var(--signal)]'
          : 'hover:bg-[color-mix(in_srgb,var(--raise)_55%,transparent)]',
      )}
    >
      <span
        className={cn(
          'absolute top-[5px] left-0 w-10 text-center font-mono text-label leading-[30px]',
          selected ? 'font-semibold text-signal-ink' : 'font-medium text-faint',
        )}
      >
        {pad(number)}
      </span>
      {/* The box ticks; clicking it selects the row without opening it. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox inside takes the keyboard */}
      <label
        className="grid h-7.5 w-6 flex-none cursor-pointer place-items-center"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <input type="checkbox" checked={done} onChange={onTick} aria-label={title} className="peer sr-only" />
        <span
          aria-hidden="true"
          className={cn(
            'grid size-3.5 place-items-center border-[1.5px] text-sheet peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal',
            done ? 'border-ink bg-ink' : 'border-muted hover:border-ink',
          )}
        >
          {done && <CheckIcon />}
        </span>
      </label>
      <span className="ml-1.5 flex h-7.5 w-[25px] items-center">
        <TodoBadge todo={todo} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 pl-1.5 text-row leading-[30px]',
          done ? 'text-faint line-through decoration-1' : 'text-text',
        )}
      >
        <ChipText text={todo.title} label={label} />
      </span>
      <ItemWarning item={todo} className="mt-[5px] ml-3" />
      <AskAres item={todo} className="mt-[5px] ml-2" />
      <span className="mt-[5px] ml-3 inline-flex h-5 flex-none items-center border border-line bg-sheet px-[7px] font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted">
        {originLabel(todo, madeFrom, backing)}
      </span>
    </li>
  );
}
