import type { Item, Project } from '@commander/domain';
import { Badge, Kbd, SectionHeader, Sheet, SheetStripCell, toast } from '@commander/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '../../frame/use-now';
import type { ItemStoreClient } from '../../item-store/client';
import { MappingRules } from '../../rules/MappingRules';
import { ProjectRankedList } from '../../sections/dashboard/ProjectRankedList';
import { TodoGroup } from '../../sections/todos/TodoGroup';
import { TodoList } from '../../sections/todos/TodoList';
import { todosIn } from '../../sections/todos/todos';
import { useTodos } from '../../sections/todos/use-todos';
import { useShortcuts } from '../../shortcuts/react';
import { PickBadgeProvider, useBadgePicker } from '../BadgePicker';
import { SectionProjectFilter } from '../badges';
import { useProjects } from '../context';
import { ManageProject } from './ManageProject';
import { filingBreakdown, projectPartNumber, sectionCounts } from './project-page';
import { SideCard } from './SideCard';

/** The shortcut scope of the Project page: its keys work only while it is shown. */
export const PROJECT_PAGE_SCOPE = 'project-page';

const pad = (n: number) => String(n).padStart(2, '0');

export interface ProjectPageProps {
  projectId: string;
  /** Whether the page is the one shown (it reloads when it comes back into view). */
  active: boolean;
  itemStore: ItemStoreClient;
  /** Where `Esc` and the bar's back control go: the Section the User came from. */
  back: { label: string; onClick: () => void };
  /** Opens a Section (a per-Section count opens it scoped to the Project). */
  onOpenSection: (sectionId: string) => void;
}

/**
 * A Project's page, opened as a temporary tab: the sheet header with its Badge, per-Section counts,
 * the Dashboard's ranked list scoped to the Project, the Project's open Todos (which behave as in the
 * Todos Section: `j`/`k`, `x`, `b`), and in the side column how its Items were filed, its mapping
 * Rules, and the controls to rename, recolour, archive and merge it. Its schedule joins it with the
 * Calendar milestone.
 */
export function ProjectPage({ projectId, active, itemStore, back, onOpenSection }: ProjectPageProps) {
  const { projectById, setFilter, openPage, loaded } = useProjects();
  const project = projectById(projectId);
  const todos = useMemo(() => todosIn(itemStore), [itemStore]);
  const include = useCallback((todo: Item) => todo.filing?.projectId === projectId, [projectId]);
  const state = useTodos(todos, include);
  const { open, undo, refresh } = state;
  const badges = useBadgePicker(state.apply, undo);
  const items = useProjectItems(itemStore, projectId, state.list);
  const today = useNow(60_000);

  // Back in view: read everything again, for changes made in the Sections meanwhile.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);

  // The page lists open Todos only, so a tick takes the Todo off it; the toast can bring it back.
  const tick = async (todoId?: string) => {
    const todo = todoId ? open.find((t) => t.id === todoId) : state.selected;
    const entry = await state.toggle(todoId);
    if (!entry || !todo) return;
    toast(`Todo ticked: ${todo.title}`, { action: { label: 'Undo', onClick: () => undo(entry.id) } });
  };

  useShortcuts([
    { keys: 'j', label: 'Next Todo', scope: PROJECT_PAGE_SCOPE, run: () => state.moveSelection(1) },
    { keys: 'k', label: 'Previous Todo', scope: PROJECT_PAGE_SCOPE, run: () => state.moveSelection(-1) },
    { keys: 'x', label: 'Tick the Todo', scope: PROJECT_PAGE_SCOPE, run: () => tick() },
    {
      keys: 'b',
      label: 'File the Todo under a Project',
      scope: PROJECT_PAGE_SCOPE,
      run: () => state.selected && badges.open(state.selected),
    },
    { keys: 'Ctrl+z', label: 'Undo', scope: PROJECT_PAGE_SCOPE, run: () => undo() },
    { keys: 'Escape', label: 'Close the Project page', scope: PROJECT_PAGE_SCOPE, run: back.onClick },
  ]);

  if (!project) {
    return (
      <Sheet
        data-testid="project-page"
        className="col-span-6 ml-3.5 min-h-[calc(100vh-var(--body))] border-t-0"
      >
        {loaded && (
          <SectionHeader eyebrow="Project" title="Gone" subtitle="This Project was merged into another." />
        )}
      </Sheet>
    );
  }

  const counts = sectionCounts(items.own);
  const openTodos = open;
  const sections: [string, string, string, number][] = [
    ['todos', 'Todos', 'open', counts.todos],
    ['notes', 'Notes', 'blocks', counts.notes],
  ];
  const showIn = (sectionId: string) => {
    if (!project.archived) setFilter(project.id);
    onOpenSection(sectionId);
  };

  return (
    <>
      <Sheet
        data-testid="project-page"
        className="col-span-6 ml-3.5 flex min-h-[calc(100vh-var(--body))] flex-col border-t-0"
      >
        <SectionHeader
          size="dashboard"
          eyebrow="Project"
          partNumber={projectPartNumber(project.code, today)}
          meta={<SheetStripCell>{project.name} · across all Sections</SheetStripCell>}
          title={
            <span className="flex items-center gap-4.5">
              <Badge size="lg" code={project.code} accent={project.accent} project={project.name} />
              <span className="min-w-0 truncate">{project.name}</span>
            </span>
          }
          subtitle={
            <>
              Project · <b>{items.own.length} items</b> filed here · {openTodos.length} open Todo
              {openTodos.length === 1 ? '' : 's'}
              {project.archived && ' · Archived: off the filter bar and the Badge picker'}
            </>
          }
          aside={<PageKeys />}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and form semantics */}
        <div
          role="group"
          aria-label="In each Section"
          className="flex h-[50px] items-stretch border-b border-line bg-sheet"
        >
          <span
            title="This Project in each Section"
            className="grid w-[41px] flex-none place-items-center border-r border-line2 font-mono text-micro leading-none font-semibold tracking-label text-faint"
          >
            IN
          </span>
          {sections.map(([id, label, what, count]) => (
            <button
              key={id}
              type="button"
              title={`Open ${label}, showing ${project.name}`}
              onClick={() => showIn(id)}
              className="flex min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-[5px] border-0 border-r border-line2 bg-transparent px-3 text-left last:border-r-0 hover:bg-raise"
            >
              <span className="font-mono text-tiny leading-none font-medium uppercase tracking-caps whitespace-nowrap text-muted">
                {label}
                <i className="not-italic"> · {what}</i>
              </span>
              <span
                className={
                  count
                    ? 'font-sans text-lead leading-none font-bold tabular-nums text-ink font-stretch-[112%]'
                    : 'font-sans text-lead leading-none font-normal tabular-nums text-faint font-stretch-[112%]'
                }
              >
                {pad(count)}
              </span>
            </button>
          ))}
        </div>
        <SectionProjectFilter
          items={items.everyOpen}
          selected={project.archived ? 'everything' : project.id}
          page={project.id}
          back={back}
          onSelect={(value) => {
            if (value !== 'everything' && value !== 'unfiled') return openPage?.(value);
            setFilter(value);
            back.onClick();
          }}
        />
        <PickBadgeProvider value={badges.open}>
          <div className="flex-1 pb-30">
            <ProjectRankedList
              projectId={project.id}
              projectName={project.name}
              onOpenSection={onOpenSection}
            />
            <TodoGroup no="G1" title="Open Todos" count={openTodos.length}>
              <TodoList
                todos={openTodos}
                first={1}
                madeFrom={state.madeFrom}
                selectedId={state.selected?.id ?? null}
                onSelect={state.select}
                onOpen={state.select}
                onTick={tick}
              />
            </TodoGroup>
            {/* #52 adds "Mentioned in" here: the refers-to Links that point at this Project. */}
          </div>
        </PickBadgeProvider>
        {badges.picker}
      </Sheet>
      <aside className="relative col-span-2 min-w-0" aria-label={`${project.name}: filing and management`}>
        <div className="sticky top-(--body) mr-4 ml-3.5 flex max-h-[calc(100vh-var(--body))] flex-col gap-3.5 overflow-auto pt-3.5 pb-6 [scrollbar-width:none]">
          <FiledCard project={project} items={items.own} />
          <MappingRules project={project} itemStore={itemStore} active={active} onChanged={refresh} />
          <ManageProject project={project} itemStore={itemStore} onChanged={refresh} />
        </div>
      </aside>
    </>
  );
}

/** The Project's Items (for its counts), and every open Item (for the filter bar's counts). */
function useProjectItems(
  itemStore: ItemStoreClient,
  projectId: string,
  reloadWhen: unknown,
): { own: Item[]; everyOpen: Item[] } {
  const [items, setItems] = useState<{ own: Item[]; everyOpen: Item[] }>({ own: [], everyOpen: [] });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadWhen` asks for a reload after a change
  useEffect(() => {
    let current = true;
    Promise.all([
      itemStore({ op: 'query', query: { projectId, limit: 1000 } }),
      itemStore({ op: 'query', query: { statuses: ['open'], limit: 1000 } }),
    ]).then(
      ([own, everyOpen]) => current && setItems({ own, everyOpen }),
      (error: unknown) => toast(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [itemStore, projectId, reloadWhen]);
  return items;
}

/** How the Project's Items were filed: by a Rule, by the User, from their source, by Ares (.kv). */
function FiledCard({ project, items }: { project: Project; items: readonly Item[] }) {
  const by = filingBreakdown(items);
  const rows: [string, number, boolean][] = [
    ['By Rule', by.rule, false],
    ['Set by you', by.user, false],
    ['Follows its source', by.inherited, false],
    ['Filed by Ares', by.ares, true],
  ];
  return (
    <SideCard
      label="How its Items were filed"
      title={
        <>
          <Badge size="sm" code={project.code} accent={project.accent} project={project.name} />
          {project.name} · Filing
        </>
      }
      note={pad(items.length)}
    >
      <dl className="m-0">
        {rows.map(([label, count, ares]) => (
          <div
            key={label}
            className={
              ares
                ? 'flex justify-between px-2.5 py-1.5 font-mono text-label leading-[1.2] font-medium uppercase tracking-tag text-signal-ink'
                : 'flex justify-between border-b border-line2 px-2.5 py-1.5 font-mono text-label leading-[1.2] font-medium uppercase tracking-tag'
            }
          >
            <dt className={ares ? '' : 'text-muted'}>{label}</dt>
            <dd className={ares ? 'm-0 font-semibold' : 'm-0 font-semibold text-ink'}>{pad(count)}</dd>
          </div>
        ))}
      </dl>
    </SideCard>
  );
}

const KEYS: [ReactNode, string][] = [
  [
    <>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd>
    </>,
    'Move',
  ],
  [<Kbd key="x">X</Kbd>, 'Tick'],
  [<Kbd key="b">B</Kbd>, 'Badge'],
  [<Kbd key="z">Ctrl Z</Kbd>, 'Undo'],
  [
    <>
      <Kbd>P</Kbd>
      <Kbd>1</Kbd>–<Kbd>9</Kbd>
    </>,
    'Project',
  ],
  [<Kbd key="esc">Esc</Kbd>, 'Back'],
];

/** The page's keys at a glance, beside its title (.fkeys). */
function PageKeys() {
  return (
    <div className="grid grid-cols-[auto_auto_auto] gap-x-3.5 gap-y-[5px] pb-0.5 font-mono text-label leading-[19px] font-medium uppercase tracking-label whitespace-nowrap text-muted max-[1440px]:grid-cols-[auto_auto] [&_kbd]:h-[17px] [&_kbd]:min-w-[17px] [&_kbd]:text-label">
      {KEYS.map(([caps, label]) => (
        <span key={label} className="flex items-center gap-[7px]">
          {caps} {label}
        </span>
      ))}
    </div>
  );
}
