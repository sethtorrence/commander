import type { Filing, Project } from '@commander/domain';
import type { ProjectFilterValue } from '@commander/ui';

/*
  The one Project filter shared by every Section: Everything, Unfiled, or one Project (by its id).
  Remembered in localStorage across restarts, like the appearance settings, until the Core keeps the
  User's settings.
*/
export type ProjectFilter = ProjectFilterValue;

export const FILTER_STORAGE_KEY = 'commander.projects.filter';

type Filed = { filing: Filing };

/** Whether an Item shows under the filter. */
export function inFilter(filter: ProjectFilter, item: Filed): boolean {
  if (filter === 'everything') return true;
  if (filter === 'unfiled') return item.filing === null;
  return item.filing?.projectId === filter;
}

/** How many Items each filter would show, for the filter bar. */
export function countByFilter(items: readonly Filed[]): {
  everything: number;
  unfiled: number;
  project(projectId: string): number;
} {
  const byProject = new Map<string, number>();
  let unfiled = 0;
  for (const { filing } of items) {
    if (filing) byProject.set(filing.projectId, (byProject.get(filing.projectId) ?? 0) + 1);
    else unfiled += 1;
  }
  return { everything: items.length, unfiled, project: (id) => byProject.get(id) ?? 0 };
}

/** Where an Item added under the filter is filed: into the selected Project, by the User. */
export function filingForNew(filter: ProjectFilter): Filing {
  return filter === 'everything' || filter === 'unfiled' ? null : { projectId: filter, filedBy: 'user' };
}

/** The filter, or Everything when it names a Project that is no longer offered. */
export function validFilter(filter: ProjectFilter, projects: readonly Project[]): ProjectFilter {
  if (filter === 'everything' || filter === 'unfiled') return filter;
  return projects.some((project) => project.id === filter) ? filter : 'everything';
}

export function loadFilter(storage: Storage): ProjectFilter {
  try {
    return storage.getItem(FILTER_STORAGE_KEY) || 'everything';
  } catch {
    return 'everything';
  }
}

export function saveFilter(storage: Storage, filter: ProjectFilter): void {
  try {
    storage.setItem(FILTER_STORAGE_KEY, filter);
  } catch {
    // Storage unavailable: the filter still applies for this session.
  }
}
