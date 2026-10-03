import type { ActivityEntry, ItemChange, NewProject, Project } from '@commander/domain';
import type { ItemStoreClient } from '../item-store/client';

/*
  The renderer's view of Projects in the Item store: reading and creating Projects, and filing any
  Item into one. Like every window request, filing is recorded as the User's, so it shows in the
  activity log and can be undone.
*/

export interface ProjectsClient {
  /** The Projects offered for filing and filtering (not archived), in their order. */
  list(): Promise<Project[]>;
  /** Creates a Project. Rejects with the reason when it is refused (a taken code, say). */
  create(project: NewProject): Promise<Project>;
  /** Files an Item into a Project by the User, or unfiles it with null. */
  file(itemId: string, projectId: string | null): Promise<ActivityEntry>;
}

export function projectsIn(itemStore: ItemStoreClient): ProjectsClient {
  return {
    list() {
      return itemStore({ op: 'projects', query: {} });
    },

    create(project) {
      return itemStore({ op: 'change-project', action: { type: 'create', project } });
    },

    file(itemId, projectId) {
      return itemStore({
        op: 'record',
        action: {
          type: 'update',
          itemId,
          changes: { filing: projectId ? { projectId, filedBy: 'user' } : null },
        },
      });
    },
  };
}

/** What a change of filing did, for an Item's history: "Filed under LT", "Unfiled". */
export function describeFiling(
  change: Extract<ItemChange, { field: 'filing' }>,
  projects: readonly Project[],
): string {
  if (!change.after) return 'Unfiled';
  const { projectId } = change.after;
  const project = projects.find((p) => p.id === projectId);
  return project ? `Filed under ${project.code}` : 'Filed under a Project';
}
