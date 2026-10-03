// The Item store's Projects: the bodies of work Items are filed into. They live in the same database,
// written only through the Item store, but they are not Items (ADR 0002): changing one records an
// entry in the Project log (project_changes), not the activity log. Filing an Item is an Item change,
// recorded and undoable like any other, so the Items a merge moves get an activity entry each too.
import { randomUUID } from 'node:crypto';
import {
  type Filing,
  type Project,
  type ProjectAction,
  type ProjectChange,
  type ProjectChangeAction,
  type ProjectQuery,
  projectAction,
  projectQuery,
} from '@commander/domain';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import * as schema from './schema';

type ProjectRow = schema.ProjectRowState;
type ChangeRow = typeof schema.projectChanges.$inferSelect;

export type Projects = {
  list(query?: ProjectQuery): Project[];
  // Makes one change to Projects and logs it. Call inside a transaction: a merge also moves Items.
  change(action: ProjectAction): ProjectChange;
  // Throws unless the filing names a Project that exists (or is Unfiled).
  checkFiling(filing: Filing | undefined): void;
};

// What Projects need from the Items side of the store, for merging and undoing a merge.
export type ProjectItems = {
  // Files every Item under `from` (deleted ones too) into `into`, keeping how each was filed, with an
  // activity entry each saying `why`. Returns those entries' ids.
  refile(from: string, into: string, why: string): number[];
  // Undoes the given activity entries, skipping any already undone and any Item filed elsewhere
  // since. Returns the ids of the undo entries.
  undo(entryIds: readonly number[], why: string): number[];
};

function toProject(row: ProjectRow): Project {
  const { position, mergedInto: _, ...rest } = row;
  return { ...rest, order: position };
}

// The first problem zod found, as a sentence for the User ("A Badge code is two letters").
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That Project isn’t valid';
}

const label = (row: ProjectRow) => `${row.name} (${row.code})`;

export function projectsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
  invalid: (message: string) => Error,
  items: ProjectItems,
): Projects {
  const { projects, projectChanges } = schema;
  const live = isNull(projects.mergedInto);

  // Projects that haven't been merged away, by code or id.
  const byCode = (code: string) =>
    db
      .select()
      .from(projects)
      .where(and(eq(projects.code, code), live))
      .get();
  const byId = (id: string) =>
    db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), live))
      .get();
  const anyById = (id: string) => db.select().from(projects).where(eq(projects.id, id)).get();

  function requireProject(id: string): ProjectRow {
    const row = byId(id);
    if (!row) throw invalid(`No Project ${id}`);
    return row;
  }

  function checkCode(code: string, ownId: string) {
    const taken = byCode(code);
    if (taken && taken.id !== ownId) throw invalid(`${code} is already the Badge code for ${taken.name}`);
  }

  function ordered(includeArchived: boolean): ProjectRow[] {
    return db
      .select()
      .from(projects)
      .where(and(live, includeArchived ? undefined : eq(projects.archived, false)))
      .orderBy(asc(projects.position), asc(projects.createdAt))
      .all();
  }

  function nextPosition(): number {
    const last = db
      .select({ position: max(projects.position) })
      .from(projects)
      .where(live)
      .get()?.position;
    return last == null ? 0 : last + 1;
  }

  function write(row: ProjectRow): ProjectRow {
    const { id, ...values } = row;
    db.update(projects).set(values).where(eq(projects.id, id)).run();
    return row;
  }

  function toChange(row: ChangeRow): ProjectChange {
    const project = row.projectId ? anyById(row.projectId) : undefined;
    return {
      id: row.id,
      at: row.at,
      action: row.action,
      project: project ? toProject(project) : null,
      mergedId: row.mergedId,
      moved: row.itemEntries.length,
      undoes: row.undoes,
    };
  }

  function log(entry: {
    action: ProjectChangeAction;
    projectId: string | null;
    mergedId?: string | null;
    before: ProjectRow[];
    after: ProjectRow[];
    itemEntries?: number[];
    undoes?: number | null;
  }): ProjectChange {
    const row = db
      .insert(projectChanges)
      .values({
        at: now(),
        action: entry.action,
        projectId: entry.projectId,
        mergedId: entry.mergedId ?? null,
        before: entry.before,
        after: entry.after,
        itemEntries: entry.itemEntries ?? [],
        undoes: entry.undoes ?? null,
      })
      .returning()
      .get();
    return toChange(row);
  }

  function create(project: { name: string; code: string; accent: string }): ProjectChange {
    checkCode(project.code, '');
    const row = db
      .insert(projects)
      .values({
        id: randomUUID(),
        ...project,
        position: nextPosition(),
        archived: false,
        createdAt: now(),
      })
      .returning()
      .get();
    return log({ action: 'create', projectId: row.id, before: [], after: [row] });
  }

  function setArchived(id: string, archived: boolean): ProjectChange {
    const row = requireProject(id);
    if (row.archived === archived)
      throw invalid(archived ? `${row.name} is already archived` : `${row.name} isn’t archived`);
    // Unarchived, it comes back at the end of the order.
    const after = write({ ...row, archived, position: archived ? row.position : nextPosition() });
    return log({ action: archived ? 'archive' : 'unarchive', projectId: id, before: [row], after: [after] });
  }

  function reorder(projectIds: string[]): ProjectChange {
    const before = ordered(true);
    const offered = before.filter((row) => !row.archived);
    const wanted = new Set(projectIds);
    if (
      wanted.size !== projectIds.length ||
      wanted.size !== offered.length ||
      !offered.every((row) => wanted.has(row.id))
    ) {
      throw invalid('Put every Project that isn’t archived in order, each once');
    }
    const byIdBefore = new Map(before.map((row) => [row.id, row]));
    // Archived Projects keep their order among themselves, after the rest.
    const sequence = [...projectIds, ...before.filter((row) => row.archived).map((row) => row.id)];
    const after = sequence.map((id, position) => {
      const row = byIdBefore.get(id) as ProjectRow;
      return write({ ...row, position });
    });
    return log({ action: 'reorder', projectId: null, before, after });
  }

  function merge(projectId: string, intoId: string): ProjectChange {
    if (projectId === intoId) throw invalid('A Project can’t be merged into itself');
    const from = requireProject(projectId);
    const into = requireProject(intoId);
    const itemEntries = items.refile(from.id, into.id, `Merged ${label(from)} into ${label(into)}`);
    // Rules (M2) move here too: every Rule filing into `from` should file into `into` instead.
    const gone = write({ ...from, mergedInto: into.id });
    return log({
      action: 'merge',
      projectId: into.id,
      mergedId: from.id,
      before: [from],
      after: [gone],
      itemEntries,
    });
  }

  function undo(changeId: number): ProjectChange {
    const target = db.select().from(projectChanges).where(eq(projectChanges.id, changeId)).get();
    if (!target) throw invalid(`No Project change ${changeId}`);
    if (target.action === 'create') throw invalid('Making a Project can’t be undone. Archive it instead');
    if (db.select().from(projectChanges).where(eq(projectChanges.undoes, changeId)).get())
      throw invalid('That change is already undone');

    const current = target.before.map((row) => anyById(row.id) as ProjectRow);
    // Only undoing a merge (or redoing one) may bring a merged Project back: it puts the Items back too.
    const mergedSince = current.find((row) => row.mergedInto !== null);
    if (mergedSince && !target.mergedId) throw invalid(`${mergedSince.name} has been merged since`);
    for (const row of target.before) if (row.mergedInto === null) checkCode(row.code, row.id);
    for (const row of target.before) write(row);

    let itemEntries: number[] = [];
    if (target.itemEntries.length) {
      const merged = target.mergedId ? anyById(target.mergedId) : undefined;
      const kept = target.projectId ? anyById(target.projectId) : undefined;
      const what = merged && kept ? `merging ${label(merged)} into ${label(kept)}` : 'a merge';
      const why = target.action === 'undo' ? `Redid ${what}` : `Undid ${what}`;
      itemEntries = items.undo(target.itemEntries, why);
    }
    return log({
      action: 'undo',
      projectId: target.projectId,
      mergedId: target.mergedId,
      before: current,
      after: target.before,
      itemEntries,
      undoes: target.id,
    });
  }

  return {
    list(input = {}) {
      const query = projectQuery.parse(input);
      return ordered(query.includeArchived ?? false).map(toProject);
    },

    change(input) {
      const parsed = projectAction.safeParse(input);
      if (!parsed.success) throw invalid(firstIssue(parsed.error));
      const action = parsed.data;
      switch (action.type) {
        case 'create':
          return create(action.project);
        case 'update': {
          const row = requireProject(action.projectId);
          if (action.changes.code) checkCode(action.changes.code, row.id);
          const after = write({ ...row, ...action.changes });
          return log({ action: 'update', projectId: row.id, before: [row], after: [after] });
        }
        case 'archive':
          return setArchived(action.projectId, true);
        case 'unarchive':
          return setArchived(action.projectId, false);
        case 'reorder':
          return reorder(action.projectIds);
        case 'merge':
          return merge(action.projectId, action.into);
        case 'undo':
          return undo(action.changeId);
      }
    },

    checkFiling(filing) {
      if (filing && !byId(filing.projectId)) throw invalid(`No Project ${filing.projectId}`);
    },
  };
}
