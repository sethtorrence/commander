import { fromMessageOf, type Item } from '@commander/domain';
import { Button, cn, toast } from '@commander/ui';
import { useEffect, useRef, useState } from 'react';
import { requestReveal, useReveal } from '../../frame/reveal';
import type { ItemChanges } from '../../item-store/changes';
import { useCommands } from '../../palette/commands';
import { PickBadgeProvider, useBadgePicker } from '../../projects/BadgePicker';
import { SectionProjectFilter } from '../../projects/badges';
import { useProjectFilter, useProjects } from '../../projects/context';
import { useShortcuts } from '../../shortcuts/react';
import { useSendToLinear } from '../linear/SendToLinear';
import { SectionSheet, useOpenSection, useSection, useTabCount } from '../section';
import { AddTodo } from './AddTodo';
import { TodoDetail } from './detail/TodoDetail';
import { Keys } from './Keys';
import { sectionFor } from './links';
import { TodoGroup } from './TodoGroup';
import { TodoList } from './TodoList';
import { type LinearState, linearIssueOf, type TodoLink, type Todos } from './todos';
import { useTodos } from './use-todos';

// Enter opens the selected Todo, except on a control that Enter presses (a button, a link).
const onPressable = () => !!document.activeElement?.closest('button, a[href], summary, [role="button"]');

/**
 * The Todos Section's sheet, after the prototype's Section pattern: the sheet header, then the list
 * (open Todos, then the collapsed Done group) and, once a Todo is opened, the detail pane beside it.
 * Closed, the sheet spans columns A–F like the prototype's Todos sheet; open, it spans A–H with
 * the detail pane in the last three eighths, like its Calendar.
 */
export function TodosSheet({
  todos,
  changes,
  planFocusTime,
}: {
  todos: Todos;
  changes?: ItemChanges;
  /** Asks Ares to find time for the Todos now (#131); the Calendar Section then shows his suggestions. */
  planFocusTime?: () => Promise<void>;
}) {
  // Projects (projects/): the filter narrows the list, `b` or a Badge click files a Todo.
  const { filter, include, filingForNew } = useProjectFilter();
  const { projects, openPage } = useProjects();
  const filtered = projects.find((project) => project.id === filter);
  const state = useTodos(todos, include);
  const { open, done, selected, detailOpen, setDetailOpen, undo, refresh } = state;
  const badges = useBadgePicker(state.apply, undo);
  const input = useRef<HTMLInputElement>(null);
  const openSection = useOpenSection();
  // A Linear Todo: its issue (while it is still in Linear), the states it can move to, and whether
  // Set Linear state…'s menu is open.
  const behind = selected ? state.backing.get(selected.id) : undefined;
  const issue = behind?.deletedAt === null ? linearIssueOf(behind) : null;
  const linearStates = useLinearStates(todos, issue);
  const [stateMenuOpen, setStateMenuOpen] = useState(false);
  // Send to Linear: the selected Todo becomes a new issue, and is backed by it. Undone here too.
  const linearSend = useSendToLinear({
    send: async (draft) => {
      const entry = await state.apply(() => todos.sendToLinear(draft));
      return entry && { issueId: entry.itemId, undo: () => void undo(entry.id) };
    },
  });
  const canSend = !!selected && !issue;
  const sendToLinear = () => {
    if (!selected || issue) return;
    linearSend.open({ from: selected.id });
  };

  useTabCount(state.list ? state.openCount : null);
  useRefreshWhenShown(refresh);
  // Changes made elsewhere (a Todo ticked in the Daily Note) show at once.
  useEffect(() => changes?.(refresh), [changes, refresh]);
  // A Block's Todo, opened from the Daily Note.
  useReveal('todos', (todoId) => {
    state.jumpTo(todoId);
    setDetailOpen(true);
  });

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
    if (other.kind === 'project') return openPage?.(other.id);
    if (other.deletedAt !== null) return;
    if (other.kind === 'todo') return state.jumpTo(other.id);
    const section = sectionFor(other.kind);
    // A Block opens in its Daily Note, scrolled to and highlighted; a Linear issue, or a GitHub pull
    // request, issue or review request (its pull request), opens selected; a Chat opens at the message
    // an Ares Todo came from (#110).
    if (section && (other.kind === 'block' || other.kind === 'linear-issue' || section === 'github'))
      requestReveal(section, other.id);
    if (other.kind === 'chat') {
      const from = fromMessageOf(selected);
      requestReveal('teams', other.id, from?.itemId === other.id ? from.messageId : undefined);
    }
    if (section) openSection(section);
  };

  const openIssue = () => {
    if (!issue) return;
    requestReveal('linear', issue.id);
    openSection('linear');
  };

  const setLinearState = async (to: LinearState) => {
    const identifier = issue?.detail.identifier;
    const entry = await state.setLinearState(to);
    if (!entry) return;
    toast(`${identifier} moved to ${to.name}`, { action: { label: 'Undo', onClick: () => undo(entry.id) } });
  };

  // Set Linear state… from the palette or `s`: the detail pane opens with its menu open.
  const chooseLinearState = () => {
    if (!issue) return;
    setDetailOpen(true);
    setStateMenuOpen(true);
  };

  const openTodo = (todoId: string) => {
    state.select(todoId);
    setDetailOpen(true);
  };

  // From the palette: start a new Todo (a Todo it found opens through useReveal above).
  useCommands([
    {
      label: 'New Todo',
      run: () => {
        openSection('todos');
        requestAnimationFrame(() => input.current?.focus());
      },
    },
    { label: 'Set Linear state…', when: () => !!issue, run: chooseLinearState },
    { label: 'Send Todo to Linear', keys: 'l', when: () => canSend, run: sendToLinear },
  ]);

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
    { keys: 's', label: 'Set Linear state…', when: () => !!issue, run: chooseLinearState },
  ]);

  return (
    <SectionSheet
      span={detailOpen ? 'full' : 'wide'}
      subtitle={
        <>
          <b>{open.length} open</b>
          {filter !== 'everything' &&
            ` ${filtered ? `in ${filtered.name}` : 'Unfiled'} (of ${state.allOpen.length})`}{' '}
          · {done.length} done · from Linear, GitHub, Email, the Daily Note and you
        </>
      }
      aside={
        <div className="flex items-end gap-5">
          {planFocusTime && (
            <Button
              onClick={() =>
                planFocusTime().then(
                  () => {
                    toast('Ares is looking for time for your Todos.');
                    openSection('calendar');
                  },
                  (error) => toast(error instanceof Error ? error.message : String(error)),
                )
              }
            >
              Plan focus time
            </Button>
          )}
          <Keys />
        </div>
      }
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
                madeFrom={state.madeFrom}
                backing={state.backing}
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
                madeFrom={state.madeFrom}
                backing={state.backing}
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
              madeFrom={selected ? state.madeFrom.get(selected.id) : undefined}
              linear={
                behind && linearIssueOf(behind)
                  ? {
                      issue: behind,
                      states: linearStates,
                      menuOpen: stateMenuOpen && !!issue,
                      onMenuOpenChange: setStateMenuOpen,
                      onSetState: setLinearState,
                      onOpenIssue: openIssue,
                    }
                  : undefined
              }
              backing={behind}
              links={state.links}
              history={state.history}
              onRename={(title) => state.rename(title)}
              onTick={() => tick()}
              onDelete={remove}
              onSendToLinear={canSend ? sendToLinear : undefined}
              onClose={() => setDetailOpen(false)}
              onOpenLink={openLink}
            />
          )}
        </div>
      </PickBadgeProvider>
      {badges.picker}
      {linearSend.dialog}
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

// The states a Linear Todo's issue can move to, read again whenever another issue is selected.
function useLinearStates(todos: Todos, issue: Item | null): LinearState[] {
  const [states, setStates] = useState<LinearState[]>([]);
  const key = issue ? `${issue.id}:${issue.updatedAt}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the issue
  useEffect(() => {
    if (!issue) {
      setStates([]);
      return;
    }
    let current = true;
    todos.linearStates(issue).then(
      (next) => current && setStates(next),
      () => current && setStates([]),
    );
    return () => {
      current = false;
    };
  }, [todos, key]);
  return states;
}
