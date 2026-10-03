import type { ActivityEntry, Item, TodoOrigin } from '@commander/domain';
import { Badge, CheckIcon, cn, Kbd, toast } from '@commander/ui';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useShortcuts } from '../../shortcuts/react';
import { type SectionDefinition, SectionSheet } from '../section';
import { describeEntry, type Todos, todosIn } from './todos';
import { type TodosState, useTodos } from './use-todos';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const ORIGIN_LABELS: Record<TodoOrigin, string> = { manual: 'Manual', ares: 'Ares', linear: 'Linear' };

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// The Todos Section: the User's Todos, added here and ticked with `x`. It talks to the Item store
// only through the Todos module (todos.ts), via the window's bridge.
function TodosSection() {
  const todos = useMemo(() => todosIn(window.commander.itemStore), []);
  return <TodosSheet todos={todos} />;
}

export function TodosSheet({ todos }: { todos: Todos }) {
  const state = useTodos(todos);
  const { list, selected, history, toggle, undo, moveSelection } = state;
  const input = useRef<HTMLInputElement>(null);

  const tick = async (todoId?: string) => {
    const entry = await toggle(todoId);
    const todo = list?.find((t) => t.id === entry?.itemId);
    if (!entry || !todo) return;
    toast(`Todo ${todo.status === 'done' ? 'unticked' : 'ticked'}: ${todo.title}`, {
      action: { label: 'Undo', onClick: () => undo(entry.id) },
    });
  };

  useShortcuts([
    { keys: 'j', label: 'Next Todo', run: () => moveSelection(1) },
    { keys: 'k', label: 'Previous Todo', run: () => moveSelection(-1) },
    { keys: 'x', label: 'Tick a Todo', run: () => tick() },
    { keys: 'Ctrl+z', label: 'Undo', run: () => undo() },
    { keys: 'n', label: 'New Todo', run: () => input.current?.focus() },
  ]);

  const open = list?.filter((todo) => todo.status !== 'done') ?? [];
  const done = list?.filter((todo) => todo.status === 'done') ?? [];

  return (
    <>
      <SectionSheet
        span="wide"
        subtitle={
          <>
            <b>{open.length} open</b> · {done.length} ticked · from Linear, Email, the Daily Note and you
          </>
        }
        aside={<Keys />}
      >
        <TodoGroup no="G1" title="Yours" count={open.length}>
          <TodoList todos={open} first={1} state={state} onTick={tick} />
          <AddTodo input={input} add={state.add} />
        </TodoGroup>
        <TodoGroup no="G2" title="Ticked" count={done.length}>
          <TodoList todos={done} first={open.length + 1} state={state} onTick={tick} />
        </TodoGroup>
      </SectionSheet>
      <aside className="col-span-2 min-w-0">
        <div className="sticky top-(--body) mr-4 ml-3.5 py-3.5">
          <History todo={selected} entries={history} />
        </div>
      </aside>
    </>
  );
}

function Keys() {
  const keys: [ReactNode, string][] = [
    [
      <>
        <Kbd>J</Kbd>
        <Kbd>K</Kbd>
      </>,
      'Move',
    ],
    [<Kbd key="x">X</Kbd>, 'Tick'],
    [<Kbd key="n">N</Kbd>, 'New'],
    [<Kbd key="z">Ctrl Z</Kbd>, 'Undo'],
  ];
  return (
    <div className="grid grid-cols-[auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {keys.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}

/** A numbered group of Todos, headed like the prototype's group headers (.gh). */
function TodoGroup({
  no,
  title,
  count,
  children,
}: {
  no: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="[&+&]:mt-5.5 [&+&>h2]:border-t">
      <h2 className="relative m-0 flex h-8 items-center gap-2.5 border-b border-line pr-5 pl-13 font-sans text-[12px] leading-none font-bold uppercase tracking-heading text-ink font-stretch-(--stretch-wider)">
        <span className="absolute left-0 w-10 text-center font-mono text-label font-semibold tracking-normal text-muted">
          {no}
        </span>
        {title}
        <span className="ml-auto font-mono text-label-lg font-semibold tracking-label text-muted">
          {pad(count)}
        </span>
      </h2>
      {children}
    </section>
  );
}

function TodoList({
  todos,
  first,
  state,
  onTick,
}: {
  todos: Item[];
  first: number;
  state: TodosState;
  onTick: (todoId: string) => void;
}) {
  if (!todos.length)
    return (
      <p className="hatch m-0 border-b border-line2 py-3 pr-5 pl-13 text-heading text-faint">Nothing here.</p>
    );
  return (
    <ul className="m-0 list-none p-0">
      {todos.map((todo, index) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          number={first + index}
          selected={todo.id === state.selected?.id}
          onSelect={() => state.select(todo.id)}
          onTick={() => onTick(todo.id)}
        />
      ))}
    </ul>
  );
}

function TodoRow({
  todo,
  number,
  selected,
  onSelect,
  onTick,
}: {
  todo: Item;
  number: number;
  selected: boolean;
  onSelect: () => void;
  onTick: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const done = todo.status === 'done';
  const origin = todo.detail?.kind === 'todo' ? todo.detail.origin : 'manual';
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    // Selecting with the mouse; the keyboard moves the selection with j and k.
    // biome-ignore lint/a11y/useKeyWithClickEvents: j/k select from the keyboard (see useShortcuts above)
    <li
      ref={row}
      aria-current={selected || undefined}
      onClick={onSelect}
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
        {pad(number, 3)}
      </span>
      {/* Clicking the row selects it; the box ticks (and the click also selects). */}
      <label className="grid h-7.5 w-6 flex-none cursor-pointer place-items-center">
        <input
          type="checkbox"
          checked={done}
          onChange={onTick}
          aria-label={todo.title}
          className="peer sr-only"
        />
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
      {/* Filed Todos get their Project's Badge once Projects land. */}
      <span className="ml-1.5 flex h-7.5 w-[25px] items-center">
        {!todo.filing && <Badge kind="unfiled" />}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 pl-1.5 text-row leading-[30px]',
          done ? 'text-faint line-through decoration-1' : 'text-text',
        )}
      >
        {todo.title}
      </span>
      <span className="mt-[5px] ml-3 inline-flex h-5 flex-none items-center border border-line bg-sheet px-[7px] font-mono text-label leading-none font-medium uppercase tracking-label whitespace-nowrap text-muted">
        {ORIGIN_LABELS[origin]}
      </span>
    </li>
  );
}

function AddTodo({ input, add }: { input: RefObject<HTMLInputElement | null>; add: TodosState['add'] }) {
  const [title, setTitle] = useState('');
  return (
    <label className="flex items-center gap-2.5 border-b border-line2 py-2 pr-5 pl-13">
      <span className="grid w-6 flex-none place-items-center">
        <span className="size-3.5 border-[1.5px] border-dashed border-muted" />
      </span>
      <input
        ref={input}
        type="text"
        aria-label="New Todo"
        placeholder="New Todo…"
        autoComplete="off"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={async (event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (await add(title)) setTitle('');
        }}
        className="h-7.5 min-w-0 flex-1 border-0 bg-transparent font-sans text-row leading-[30px] text-ink caret-signal outline-none placeholder:text-faint"
      />
      <Kbd className="opacity-70">↵</Kbd>
    </label>
  );
}

/** The selected Todo's activity log, newest first: who changed it, and when. */
function History({ todo, entries }: { todo: Item | null; entries: ActivityEntry[] }) {
  return (
    <section aria-label="History" className="border border-line bg-sheet text-note leading-[18px]">
      <h2 className="m-0 flex h-7.5 items-center justify-between gap-2 border-b border-line px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-label whitespace-nowrap text-ink">
        History
        <span className="font-medium text-faint">{pad(entries.length)}</span>
      </h2>
      {todo ? (
        <>
          <p className="m-0 border-b border-line2 px-2.5 py-2 font-semibold text-ink">{todo.title}</p>
          <ol className="m-0 list-none p-0">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex justify-between gap-2.5 border-b border-line2 px-2.5 py-[7px] last:border-b-0"
              >
                <span className="text-text">{describeEntry(entry, entries)}</span>
                <time
                  dateTime={new Date(entry.at).toISOString()}
                  className="font-mono text-label-lg leading-[18px] text-muted tabular-nums"
                >
                  {time.format(entry.at)}
                </time>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="m-0 px-2.5 py-2 text-faint">Pick a Todo to see its history.</p>
      )}
    </section>
  );
}

export const todos: SectionDefinition = {
  id: 'todos',
  label: 'Todos',
  code: 'TDO',
  Component: TodosSection,
};
