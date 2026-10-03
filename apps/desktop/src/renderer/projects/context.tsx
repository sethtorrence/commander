import type { ActivityEntry, Filing, Item, NewProject, Project } from '@commander/domain';
import { toast } from '@commander/ui';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useShortcuts } from '../shortcuts/react';
import { filingForNew, inFilter, loadFilter, type ProjectFilter, saveFilter, validFilter } from './filter';
import type { ProjectsClient } from './projects';

/*
  Projects for the whole window: the frame mounts one <ProjectsProvider>, and every Section and
  Settings read it through `useProjects()`. It holds the Projects, the one Project filter shared by
  every Section (remembered across restarts), and the `p` then 0–9 / u keys that set the filter.
*/

export interface ProjectsApi {
  /** The Projects offered for filing and filtering, in their order. Empty until loaded. */
  projects: readonly Project[];
  /** The Project an Item is filed under, if it is filed (and the Project is known). */
  projectOf(filing: Filing): Project | undefined;
  /** Creates a Project. Rejects with the reason when it is refused. */
  create(project: NewProject): Promise<Project>;
  /** Files an Item into a Project by the User, or unfiles it with null. */
  file(itemId: string, projectId: string | null): Promise<ActivityEntry>;
  /** The current Project filter, the same in every Section. */
  filter: ProjectFilter;
  setFilter(filter: ProjectFilter): void;
}

const ProjectsContext = createContext<ProjectsApi | null>(null);

export function ProjectsProvider({
  client,
  storage = window.localStorage,
  children,
}: {
  client: ProjectsClient;
  storage?: Storage;
  children: ReactNode;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [chosen, setChosen] = useState<ProjectFilter>(() => loadFilter(storage));

  const reload = useCallback(
    () =>
      client.list().then(setProjects, (error: unknown) => {
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
    const list = projects ?? [];
    const byId = new Map(list.map((project) => [project.id, project]));
    return {
      projects: list,
      projectOf: (filing) => (filing ? byId.get(filing.projectId) : undefined),
      async create(project) {
        const created = await client.create(project);
        await reload();
        return created;
      },
      file: (itemId, projectId) => client.file(itemId, projectId),
      // Until the Projects load, a remembered Project can't be checked, so it is kept as it is.
      filter: projects ? validFilter(chosen, projects) : chosen,
      setFilter,
    };
  }, [projects, chosen, client, reload, setFilter]);

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

/** `p` then 0 (Everything), 1–9 (the nth Project) or u (Unfiled), anywhere in the window. */
function ProjectFilterKeys() {
  const { projects, setFilter } = useProjects();
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
  ]);
  return null;
}
