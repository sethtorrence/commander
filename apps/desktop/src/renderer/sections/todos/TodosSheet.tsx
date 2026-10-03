import { cn, toast } from '@commander/ui';
import { useEffect, useRef } from 'react';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { AddTodo } from './AddTodo';
import { TodoDetail } from './detail/TodoDetail';
import { Keys } from './Keys';
import { sectionFor } from './links';
import { TodoGroup } from './TodoGroup';
import { TodoList } from './TodoList';
import type { TodoLink, Todos } from './todos';
import { useTodos } from './use-todos';

// Enter opens the selected Todo, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

/**
 * The Todos Section's sheet, after the prototype's Section pattern: the sheet header, then the list
 * (open Todos, then the collapsed Done group) and, once a Todo is opened, the detail pane beside it.
 * Closed, the sheet spans columns A–F like the prototype's Todos sheet; open, it spans A–H with
 * the detail pane in the last three eighths, like its Calendar.
 */
export function TodosSheet({ todos }: { todos: Todos }) {
  // Projects (projects/): the filter narrows the list, `b` or a Badge click files a Todo.
  const { filter, include, filingForNew } = useProjectFilter();
  const { projects } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const state = useTodos(todos, include);
  const { open, done, selected, detailOpen, setDetailOpen, undo, refresh } = state;
  const badges = useBadgePicker(state.apply, undo);
  const input = useRef<HTMLInputElement>(null);
  const openSection = useOpenSection();

  useTabCount(state.list ? state.openCount : null);
  useRefreshWhenShown(refresh);

  const tick = async (todoId?: string) => {
    const todo = todoId ? state.list?.find((t) => t.id === todoId) : selected;
    const entry = await state.toggle(todoId);
    if (!entry || !todo) return;
    toast(`Todo ${todo.status === 'done' ? 'unticked' : 'ticked'}: ${todo.title}`, {
      action: { label: 'Undo', onClick: () => undo(entry.id) },
    });
  };

  const remove = async () => {
    const todo = selected;
    const entry = await state.remove();
    if (!entry || !todo) return;
    toast(`Todo deleted: ${todo.title}`, { action: { label: 'Undo', onClick: () => undo(entry.id) } });
  };

  const openLink = ({ other }: TodoLink) => {
    if (other.deletedAt !== null) return;
    if (other.kind === 'todo') return state.jumpTo(other.id);
    const section = sectionFor(other.kind);
    if (section) openSection(section);
  };

  const openTodo = (todoId: string) => {
    state.select(todoId);
    setDetailOpen(true);
  };

  useShortcuts([
    { keys: 'j', label: 'Next Todo', run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous Todo', run: () => state.moveSelection(-1) },
    { keys: 'Enter', label: 'Open the Todo', when: () => !onPressable(), run: () => setDetailOpen(true) },
    { keys: 'Escape', label: 'Close the Todo', when: () => detailOpen, run: () => setDetailOpen(false) },
    { keys: 'x', label: 'Tick or untick', run: () => tick() },
    { keys: 'Delete', label: 'Delete the Todo', run: () => remove() },
    { keys: 'd', label: 'Show or hide Done', run: () => state.showDone() },
    { keys: 'Ctrl+z', label: 'Undo', run: () => undo() },
    { keys: 'n', label: 'New Todo', run: () => input.current?.focus() },
    { keys: 'b', label: 'File under a Project', run: () => selected && badges.open(selected) },
  ]);

  return (
    <SectionSheet
      span={detailOpen ? 'full' : 'wide'}
      subtitle={
        <>
          <b>{open.length} open</b>
          {filter !== 'everything' &&
            ` ${filtered ? `in ${filtered.name}` : 'Unfiled'} (of ${state.allOpen.length})`}{' '}
          · {done.length} done · from Linear, Email, the Daily Note and you
        </>
      }
      aside={<Keys />}
      className="flex flex-col"
    >
      <SectionProjectFilter items={state.allOpen} />
      <PickBadgeProvider value={badges.open}>
        <div className={cn('flex-1', detailOpen && 'grid grid-cols-[minmax(0,5fr)_minmax(0,3fr)]')}>
          <div className="min-w-0 pb-30">
            <TodoGroup no="G1" title="Open" count={open.length}>
              <TodoList
                todos={open}
                first={1}
                selectedId={selected?.id ?? null}
                onSelect={state.select}
                onOpen={openTodo}
                onTick={tick}
              />
              <AddTodo input={input} add={(title) => state.add(title, filingForNew)} project={filtered} />
            </TodoGroup>
            <TodoGroup
              no="G2"
              title="Done"
              count={done.length}
              expanded={state.doneShown}
              onExpandedChange={state.showDone}
            >
              <TodoList
                todos={done}
                first={open.length + 1}
                selectedId={selected?.id ?? null}
                onSelect={state.select}
                onOpen={openTodo}
                onTick={tick}
              />
            </TodoGroup>
          </div>
          {detailOpen && (
            <TodoDetail
              todo={selected}
              links={state.links}
              history={state.history}
              onRename={(title) => state.rename(title)}
              onTick={() => tick()}
              onDelete={remove}
              onClose={() => setDetailOpen(false)}
              onOpenLink={openLink}
            />
          )}
        </div>
      </PickBadgeProvider>
      {badges.picker}
    </SectionSheet>
  );
}

// Reads the Todos again whenever the Section comes back into view or the window regains focus, so
// changes made elsewhere (another Section, Ares) show without a restart.
function useRefreshWhenShown(refresh: () => void) {
  const { active } = useSection();
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
}
