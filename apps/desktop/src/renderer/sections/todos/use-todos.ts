import type { ActivityEntry, Item } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Todos } from './todos';

export interface TodosState {
  /** The Todos, in the order they were added; null until the first load. */
  list: Item[] | null;
  /** The selected Todo, which `x` ticks and whose history shows. */
  selected: Item | null;
  /** The selected Todo's activity log, newest first. */
  history: ActivityEntry[];
  select(todoId: string): void;
  /** Moves the selection down (1) or up (-1) the list. */
  moveSelection(step: 1 | -1): void;
  /** Adds a Todo and selects it. Resolves false when nothing was added. */
  add(title: string): Promise<boolean>;
  /** Ticks an open Todo or unticks a ticked one; the selected Todo when no id is given. */
  toggle(todoId?: string): Promise<ActivityEntry | null>;
  /** Undoes one change made here: the given entry, or the latest not yet undone. */
  undo(entryId?: number): Promise<void>;
}

/**
 * The Todos Section's state, kept in step with the Item store: it reloads after every change it
 * makes, and remembers the changes made this session so they can be undone in turn. Failures are
 * shown as a toast.
 */
export function useTodos(todos: Todos): TodosState {
  const [list, setList] = useState<Item[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [version, setVersion] = useState(0);
  // Entries recorded here this session, oldest first: what undo works back through.
  const undoable = useRef<number[]>([]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    let current = true;
    todos.list().then((next) => current && setList(next), report);
    return () => {
      current = false;
    };
  }, [todos, version]);

  // The selection falls back to the first Todo when there is none, or its Todo has gone.
  const selected = list?.find((todo) => todo.id === selectedId) ?? list?.[0] ?? null;
  const selectedTodoId = selected?.id ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!selectedTodoId) return setHistory([]);
    let current = true;
    todos.history(selectedTodoId).then((next) => current && setHistory(next), report);
    return () => {
      current = false;
    };
  }, [todos, selectedTodoId, version]);

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      if (!list?.length) return;
      const index = selected ? list.indexOf(selected) : -1;
      const next = list[Math.min(list.length - 1, Math.max(0, index + step))];
      if (next) setSelectedId(next.id);
    },
    [list, selected],
  );

  const add = useCallback(
    async (title: string) => {
      if (!title.trim()) return false;
      try {
        const entry = await todos.add(title);
        undoable.current.push(entry.id);
        setSelectedId(entry.itemId);
        changed();
        return true;
      } catch (error) {
        report(error);
        return false;
      }
    },
    [todos, changed],
  );

  const toggle = useCallback(
    async (todoId?: string) => {
      const todo = todoId ? list?.find((t) => t.id === todoId) : selected;
      if (!todo) return null;
      try {
        const entry = await todos.setDone(todo.id, todo.status !== 'done');
        undoable.current.push(entry.id);
        changed();
        return entry;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [todos, list, selected, changed],
  );

  const undo = useCallback(
    async (entryId?: number) => {
      const target = entryId ?? undoable.current.at(-1);
      if (target === undefined) {
        toast('Nothing to undo here');
        return;
      }
      undoable.current = undoable.current.filter((id) => id !== target);
      try {
        await todos.undo(target);
      } catch (error) {
        report(error);
      }
      changed();
    },
    [todos, changed],
  );

  return { list, selected, history, select: setSelectedId, moveSelection, add, toggle, undo };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
