// The Item store's Projects: the bodies of work Items are filed into. They live in the same database,
// written only through the Item store, but they are not Items (ADR 0002), so changing one records no
// activity entry. Filing an Item is an Item change, recorded and undoable like any other.
import { randomUUID } from 'node:crypto';
import {
  type Filing,
  type Project,
  type ProjectAction,
  type ProjectQuery,
  projectAction,
  projectQuery,
} from '@commander/domain';
import { asc, eq, max } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import * as schema from './schema';

type ProjectRow = typeof schema.projects.$inferSelect;

export type Projects = {
  list(query?: ProjectQuery): Project[];
  change(action: ProjectAction): Project;
  // Throws unless the filing names a Project that exists (or is Unfiled).
  checkFiling(filing: Filing | undefined): void;
};

function toProject(row: ProjectRow): Project {
  const { position, ...rest } = row;
  return { ...rest, order: position };
}

// The first problem zod found, as a sentence for the User ("A Badge code is two letters").
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'That Project isn’t valid';
}

export function projectsIn(
  db: BetterSQLite3Database<typeof schema>,
  now: () => number,
  invalid: (message: string) => Error,
): Projects {
  const { projects } = schema;

  const byCode = (code: string) => db.select().from(projects).where(eq(projects.code, code)).get();
  const byId = (id: string) => db.select().from(projects).where(eq(projects.id, id)).get();

  return {
    list(input = {}) {
      const query = projectQuery.parse(input);
      return db
        .select()
        .from(projects)
        .where(query.includeArchived ? undefined : eq(projects.archived, false))
        .orderBy(asc(projects.position))
        .all()
        .map(toProject);
    },

    change(input) {
      const parsed = projectAction.safeParse(input);
      if (!parsed.success) throw invalid(firstIssue(parsed.error));
      const { project } = parsed.data;
      const taken = byCode(project.code);
      if (taken) throw invalid(`${project.code} is already the Badge code for ${taken.name}`);
      const last = db
        .select({ position: max(projects.position) })
        .from(projects)
        .get()?.position;
      const row = db
        .insert(projects)
        .values({
          id: randomUUID(),
          ...project,
          position: last == null ? 0 : last + 1,
          archived: false,
          createdAt: now(),
        })
        .returning()
        .get();
      return toProject(row);
    },

    checkFiling(filing) {
      if (filing && !byId(filing.projectId)) throw invalid(`No Project ${filing.projectId}`);
    },
  };
}
