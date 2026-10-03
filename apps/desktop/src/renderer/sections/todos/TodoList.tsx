import type { Item } from '@commander/domain';
import { TodoRow } from './TodoRow';
import type { MadeFrom } from './todos';

/** A group's rows, numbered on from `first`, or "Nothing here." */
export function TodoList({
  todos,
  first,
  madeFrom,
  selectedId,
  onSelect,
  onOpen,
  onTick,
}: {
  todos: Item[];
  first: number;
  /** Where the Todos made from a Block were made, by Todo id, for their origin. */
  madeFrom: ReadonlyMap<string, MadeFrom>;
  selectedId: string | null;
  onSelect: (todoId: string) => void;
  onOpen: (todoId: string) => void;
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
          madeFrom={madeFrom.get(todo.id)}
          selected={todo.id === selectedId}
          onSelect={() => onSelect(todo.id)}
          onOpen={() => onOpen(todo.id)}
          onTick={() => onTick(todo.id)}
        />
      ))}
    </ul>
  );
}
