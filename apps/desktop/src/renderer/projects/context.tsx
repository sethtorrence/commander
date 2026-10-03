import type {
  ActivityEntry,
  Filing,
  Item,
  NewProject,
  Project,
  ProjectAction,
  ProjectChange,
} from '@commander/domain';
import { toast } from '@commander/ui';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useShortcuts } from '../shortcuts/react';
import { filingForNew, inFilter, loadFilter, type ProjectFilter, saveFilter, validFilter } from './filter';
import type { ProjectsClient } from './projects';

/*
  Projects for the whole window: the frame mounts one <ProjectsProvider>, and every Section and
  Settings read it through `useProjects()`. It holds the Projects, the one Project filter shared by
  every Section (remembered across restarts), the `p` then 0–9 / u keys that set the filter, and
  `p` then o, which opens the selected Project's page (the frame shows it, through `onOpenPage`).
*/

export interface ProjectsApi {
  /** The Projects offered for filing and filtering (not archived), in their order. Empty until loaded. */
  projects: readonly Project[];
  /** The archived Projects, in their order: their Items keep their Badges. */
  archived: readonly Project[];
  /** The Project an Item is filed under, archived or not, if it is filed (and the Project is known). */
  projectOf(filing: Filing): Project | undefined;
  /** A Project by its id, archived or not. */
  projectById(projectId: string): Project | undefined;
  /** Creates a Project. Rejects with the reason when it is refused. */
  create(project: NewProject): Promise<Project>;
  /**
   * Renames, recolours, reorders, archives, merges or undoes, then reloads the Projects. Rejects with
   * the reason when it is refused.
   */
  change(action: ProjectAction): Promise<ProjectChange>;
  /** Files an Item into a Project by the User, or unfiles it with null. */
  file(itemId: string, projectId: string | null): Promise<ActivityEntry>;
  /** The current Project filter, the same in every Section. */
  filter: ProjectFilter;
  setFilter(filter: ProjectFilter): void;
  /** Opens a Project's page as a temporary tab; undefined where there are no pages (a component test). */
  openPage?: (projectId: string) => void;
  /** Whether the Projects have loaded. */
  loaded: boolean;
}

const ProjectsContext = createContext<ProjectsApi | null>(null);

export function ProjectsProvider({
  client,
  storage = window.localStorage,
  onOpenPage,
  children,
}: {
  client: ProjectsClient;
  storage?: Storage;
  /** Shows a Project's page; the frame passes it. */
  onOpenPage?: (projectId: string) => void;
  children: ReactNode;
}) {
  const [all, setAll] = useState<Project[] | null>(null);
  const [chosen, setChosen] = useState<ProjectFilter>(() => loadFilter(storage));

  const reload = useCallback(
    () =>
      client.list().then(setAll, (error: unknown) => {
        toast(error instanceof Error ? error.message : String(error));
      }),
    [client],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  const setFilter = useCallback(
    (next: ProjectFilter) => {
      setChosen(next);
      saveFilter(storage, next);
    },
    [storage],
  );

  const api = useMemo<ProjectsApi>(() => {
    const list = all ?? [];
    const offered = list.filter((project) => !project.archived);
    const byId = new Map(list.map((project) => [project.id, project]));
    return {
      projects: offered,
      archived: list.filter((project) => project.archived),
      projectOf: (filing) => (filing ? byId.get(filing.projectId) : undefined),
      projectById: (projectId) => byId.get(projectId),
      async create(project) {
        const created = await client.create(project);
        await reload();
        return created;
      },
      async change(action) {
        try {
          return await client.change(action);
        } finally {
          await reload();
        }
      },
      file: (itemId, projectId) => client.file(itemId, projectId),
      // Until the Projects load, a remembered Project can't be checked, so it is kept as it is.
      filter: all ? validFilter(chosen, offered) : chosen,
      setFilter,
      openPage: onOpenPage,
      loaded: all !== null,
    };
  }, [all, chosen, client, reload, setFilter, onOpenPage]);

  return (
    <ProjectsContext.Provider value={api}>
      <ProjectFilterKeys />
      {children}
    </ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsApi {
  const api = useContext(ProjectsContext);
  if (!api) throw new Error('useProjects needs a <ProjectsProvider> above it');
  return api;
}

/**
 * The Project filter as a Section applies it: which Items to show, and how to file an Item added
 * while a Project is selected.
 */
export function useProjectFilter(): {
  filter: ProjectFilter;
  include: (item: Pick<Item, 'filing'>) => boolean;
  filingForNew: Filing;
} {
  const { filter } = useProjects();
  const include = useCallback((item: Pick<Item, 'filing'>) => inFilter(filter, item), [filter]);
  return { filter, include, filingForNew: filingForNew(filter) };
}

/**
 * `p` then 0 (Everything), 1–9 (the nth Project) or u (Unfiled), anywhere in the window; and `p`
 * then o, the selected Project's page.
 */
function ProjectFilterKeys() {
  const { projects, filter, setFilter, openPage } = useProjects();
  const group = 'Project filter';
  useShortcuts([
    { keys: 'p 0', label: 'Show everything', group, run: () => setFilter('everything') },
    ...projects.slice(0, 9).map((project, index) => ({
      keys: `p ${index + 1}`,
      label: `Only ${project.name} (${project.code})`,
      group,
      run: () => setFilter(project.id),
    })),
    { keys: 'p u', label: 'Only Unfiled', group, run: () => setFilter('unfiled') },
    {
      keys: 'p o',
      label: 'Open the selected Project’s page',
      group,
      run: () => {
        const selected = projects.find((project) => project.id === filter);
        if (!openPage) return;
        if (selected) openPage(selected.id);
        else toast('Choose a Project first: P then its number');
      },
    },
  ]);
  return null;
}
