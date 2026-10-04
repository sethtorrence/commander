import type {
  ActivityEntry,
  ItemChange,
  NewProject,
  Project,
  ProjectAction,
  ProjectChange,
} from '@commander/domain';
import type { ItemStoreClient } from '../item-store/client';

/*
  The renderer's view of Projects in the Item store: reading, creating and managing Projects, and
  filing any Item into one. Like every window request, filing is recorded as the User's, so it shows
  in the activity log and can be undone. Changes to Projects themselves go to the Project log, and
  each can be undone through `change({ type: 'undo', changeId })`.
*/

export interface ProjectsClient {
  /** Every Project, archived ones included, in their order. */
  list(): Promise<Project[]>;
  /** Creates a Project. Rejects with the reason when it is refused (a taken code, say). */
  create(project: NewProject): Promise<Project>;
  /** Renames, recolours, reorders, archives, merges or undoes. Rejects with the reason when refused. */
  change(action: ProjectAction): Promise<ProjectChange>;
  /** Files an Item into a Project by the User, or unfiles it with null. */
  file(itemId: string, projectId: string | null): Promise<ActivityEntry>;
  /**
   * Answers Ares's filing suggestion (the dashed Badge, #71): its own Project confirms it, another
   * changes it, null turns it down. Resolves with the filing's activity entry (for Undo), if one.
   */
  settleFiling(proposalId: number, projectId: string | null): Promise<ActivityEntry | null>;
}

/** The window's autonomy channel, where Ares's suggestions are answered. */
type AutonomyBridge = Window['commander']['autonomy'];

export function projectsIn(
  itemStore: ItemStoreClient,
  autonomy: () => AutonomyBridge = () => window.commander.autonomy,
): ProjectsClient {
  const change = (action: ProjectAction) => itemStore({ op: 'change-project', action });
  return {
    list() {
      return itemStore({ op: 'projects', query: { includeArchived: true } });
    },

    async create(project) {
      const created = (await change({ type: 'create', project })).project;
      if (!created) throw new Error('The Project wasn’t created');
      return created;
    },

    change,

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

    async settleFiling(proposalId, projectId) {
      const { proposal, entryId } = await autonomy()({ op: 'settle-filing', proposalId, projectId });
      if (entryId === null) return null;
      const entries = await itemStore({ op: 'activity', query: { itemId: proposal.itemId, limit: 50 } });
      return entries.find((entry) => entry.id === entryId) ?? null;
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

/**
 * The User's answer to Ares's filing, for an Item's history (#71): "Confirmed Ares’s filing under TL",
 * "Corrected Ares: TL → TX", "Corrected Ares: not TL".
 */
export function describeFilingAnswer(entry: ActivityEntry, projects: readonly Project[]): string {
  const change = entry.changes.find((each) => each.field === 'filing');
  const code = (filing: unknown) => {
    const projectId = (filing as { projectId?: string } | null)?.projectId;
    return projects.find((p) => p.id === projectId)?.code ?? (projectId ? 'a Project' : null);
  };
  const suggested = code(change?.before) ?? 'a Project';
  if (entry.action === 'confirmation') return `Confirmed Ares’s filing under ${suggested}`;
  const chosen = code(change?.after);
  return chosen ? `Corrected Ares: ${suggested} → ${chosen}` : `Corrected Ares: not ${suggested}`;
}
