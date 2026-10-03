import type { ActivityEntry, Item } from '@commander/domain';
import { toast } from '@commander/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TodoLink, Todos } from './todos';

export interface TodosState {
  /** Every Todo: the open ones in the order they were added, then the ticked ones; null until the first load. */
  list: Item[] | null;
  /** The open Todos, in the order they were added. */
  open: Item[];
  /** The ticked Todos, most recently changed first. */
  done: Item[];
  /** How many Todos are open, for the notebook tab. */
  openCount: number;
  /** Whether the Done group is expanded. It starts collapsed. */
  doneShown: boolean;
  /** Expands or collapses the Done group; toggles it when no value is given. */
  showDone(shown?: boolean): void;
  /** The selected Todo, which `x` ticks and the detail pane shows. Always one that is shown. */
  selected: Item | null;
  /** The selected Todo's activity log, newest first. */
  history: ActivityEntry[];
  /** The selected Todo's Links, both ways. */
  links: TodoLink[];
  /** Whether the detail pane is open. */
  detailOpen: boolean;
  setDetailOpen(open: boolean): void;
  select(todoId: string): void;
  /** Selects a Todo wherever it is, expanding the Done group if it is there. */
  jumpTo(todoId: string): void;
  /** Moves the selection down (1) or up (-1) the shown Todos. */
  moveSelection(step: 1 | -1): void;
  /** Adds a Todo and selects it. Resolves false when nothing was added. */
  add(title: string): Promise<boolean>;
  /** Ticks an open Todo or unticks a ticked one; the selected Todo when no id is given. */
  toggle(todoId?: string): Promise<ActivityEntry | null>;
  /** Changes a Todo's title (the selected one's by default). Resolves false when nothing changed. */
  rename(title: string, todoId?: string): Promise<boolean>;
  /** Deletes a Todo (the selected one by default). */
  remove(todoId?: string): Promise<ActivityEntry | null>;
  /** Undoes one change made here: the given entry, or the latest not yet undone. */
  undo(entryId?: number): Promise<void>;
  /** Reads the Todos again, for changes made outside this Section. */
  refresh(): void;
}

/**
 * The Todos Section's state, kept in step with the Item store: it reloads after every change it
 * makes (and on `refresh`), and remembers the changes made this session so they can be undone in
 * turn. Failures are shown as a toast.
 */
export function useTodos(todos: Todos): TodosState {
  const [list, setList] = useState<Item[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doneShown, setDoneShown] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [links, setLinks] = useState<TodoLink[]>([]);
  const [version, setVersion] = useState(0);
  // Entries recorded here this session, oldest first: what undo works back through.
  const undoable = useRef<number[]>([]);
  // Where the selection last was among the shown Todos, so it stays put when its Todo leaves.
  const lastIndex = useRef(0);

  const changed = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    let current = true;
    todos.list().then((next) => current && setList(next), report);
    return () => {
      current = false;
    };
  }, [todos, version]);

  const open = useMemo(() => list?.filter((todo) => todo.status !== 'done') ?? [], [list]);
  const done = useMemo(() => list?.filter((todo) => todo.status === 'done') ?? [], [list]);
  const shown = useMemo(() => (doneShown ? [...open, ...done] : open), [open, done, doneShown]);

  // Should the selected Todo stop being shown some other way (the Done group collapsed, a change
  // elsewhere), the one that took its place is selected instead.
  const selected =
    shown.find((todo) => todo.id === selectedId) ??
    shown[Math.min(lastIndex.current, shown.length - 1)] ??
    null;
  const selectedTodoId = selected?.id ?? null;

  useEffect(() => {
    if (selected) lastIndex.current = shown.indexOf(selected);
  }, [selected, shown]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a reload after a change
  useEffect(() => {
    if (!selectedTodoId) {
      setHistory([]);
      setLinks([]);
      return;
    }
    let current = true;
    todos.history(selectedTodoId).then((next) => current && setHistory(next), report);
    todos.links(selectedTodoId).then((next) => current && setLinks(next), report);
    return () => {
      current = false;
    };
  }, [todos, selectedTodoId, version]);

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      if (!shown.length) return;
      const index = selected ? shown.indexOf(selected) : -1;
      const next = shown[Math.min(shown.length - 1, Math.max(0, index + step))];
      if (next) setSelectedId(next.id);
    },
    [shown, selected],
  );

  const showDone = useCallback((value?: boolean) => setDoneShown((now) => value ?? !now), []);

  const jumpTo = useCallback(
    (todoId: string) => {
      if (done.some((todo) => todo.id === todoId)) setDoneShown(true);
      setSelectedId(todoId);
    },
    [done],
  );

  // Records one change, keeps it for undo and reloads. Resolves null (after a toast) if it failed.
  const run = useCallback(
    async (change: () => Promise<ActivityEntry>) => {
      try {
        const entry = await change();
        undoable.current.push(entry.id);
        changed();
        return entry;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [changed],
  );

  // Before the selected Todo leaves the shown list (deleted, or ticked while Done is collapsed),
  // the selection moves on to its neighbour, as after archiving an email.
  const stepOffIfSelected = useCallback(
    (todo: Item) => {
      if (todo.id !== selected?.id) return;
      const index = shown.indexOf(todo);
      setSelectedId((shown[index + 1] ?? shown[index - 1])?.id ?? null);
    },
    [shown, selected],
  );

  const find = useCallback(
    (todoId?: string) => (todoId ? list?.find((todo) => todo.id === todoId) : selected) ?? null,
    [list, selected],
  );

  const add = useCallback(
    async (title: string) => {
      if (!title.trim()) return false;
      const entry = await run(() => todos.add(title));
      if (entry) setSelectedId(entry.itemId);
      return !!entry;
    },
    [todos, run],
  );

  const toggle = useCallback(
    async (todoId?: string) => {
      const todo = find(todoId);
      if (!todo) return null;
      const ticking = todo.status !== 'done';
      const entry = await run(() => todos.setDone(todo.id, ticking));
      if (entry && ticking && !doneShown) stepOffIfSelected(todo);
      return entry;
    },
    [todos, find, run, doneShown, stepOffIfSelected],
  );

  const rename = useCallback(
    async (title: string, todoId?: string) => {
      const todo = find(todoId);
      if (!todo || !title.trim() || title.trim() === todo.title) return false;
      return !!(await run(() => todos.rename(todo.id, title)));
    },
    [todos, find, run],
  );

  const remove = useCallback(
    async (todoId?: string) => {
      const todo = find(todoId);
      if (!todo) return null;
      const entry = await run(() => todos.remove(todo.id));
      if (entry) stepOffIfSelected(todo);
      return entry;
    },
    [todos, find, run, stepOffIfSelected],
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

  return {
    list,
    open,
    done,
    openCount: open.length,
    doneShown,
    showDone,
    selected,
    history,
    links,
    detailOpen,
    setDetailOpen,
    select: setSelectedId,
    jumpTo,
    moveSelection,
    add,
    toggle,
    rename,
    remove,
    undo,
    refresh: changed,
  };
}

function report(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
