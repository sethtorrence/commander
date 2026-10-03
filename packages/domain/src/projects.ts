import { z } from 'zod';

// Projects: the bodies of work Items are filed into. A Project is not an Item (ADR 0002); every Item
// has a Project or is Unfiled, and shows it with the Project's Badge: its two-letter code on its
// accent colour.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// Two letters, stored upper-case. Codes are unique across all Projects, archived ones included.
export const projectCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'A Badge code is two letters')
  .transform((code) => code.toUpperCase());

// A palette accent's name (`blue`, from the palette of 8 in @commander/ui), or a custom colour as
// `#RRGGBB`, which the window derives per theme and checks for contrast before offering it.
export const projectAccent = z
  .string({ error: 'A Project needs an accent colour' })
  .regex(/^(?:[a-z]+|#[0-9A-Fa-f]{6})$/, 'A Project needs an accent colour');

export const project = z.object({
  id,
  name: z.string().min(1),
  code: z.string().regex(/^[A-Z]{2}$/),
  accent: projectAccent,
  // Its place in the filter bar and the Badge picker: lower comes first. The User sets it by
  // dragging in Settings → Projects; a new or unarchived Project goes to the end.
  order: z.number().int().nonnegative(),
  // Archived Projects leave the filter bar and the Badge picker; their Items keep their Badges.
  archived: z.boolean(),
  createdAt: timestamp,
});
export type Project = z.infer<typeof project>;

const projectName = z.string().trim().min(1, 'A Project needs a name');

export const newProject = z.object({
  name: projectName,
  code: projectCode,
  accent: projectAccent,
});
export type NewProject = z.input<typeof newProject>;

// What renaming, recoding or recolouring a Project may change: any of its name, code and accent.
export const projectChanges = z
  .object({ name: projectName, code: projectCode, accent: projectAccent })
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, 'Nothing to change');
export type ProjectChanges = z.input<typeof projectChanges>;

// Every change to Projects is one of these, and each is kept in the Project log so it can be undone.
export const projectAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), project: newProject }),
  // Rename, recode or recolour.
  z.object({ type: z.literal('update'), projectId: id, changes: projectChanges }),
  z.object({ type: z.literal('archive'), projectId: id }),
  z.object({ type: z.literal('unarchive'), projectId: id }),
  // Every Project that isn't archived, in its new order.
  z.object({ type: z.literal('reorder'), projectIds: z.array(id) }),
  // Moves every Item of `projectId` into `into`, keeping how each was filed, and removes `projectId`.
  z.object({ type: z.literal('merge'), projectId: id, into: id }),
  // Reverses an entry in the Project log (undoing a merge puts every Item back). Undoing an undo
  // redoes it.
  z.object({ type: z.literal('undo'), changeId: z.number().int().positive() }),
]);
export type ProjectAction = z.input<typeof projectAction>;

export const projectChangeAction = z.enum([
  'create',
  'update',
  'archive',
  'unarchive',
  'reorder',
  'merge',
  'undo',
]);
export type ProjectChangeAction = z.infer<typeof projectChangeAction>;

// One entry in the Project log: what a Project action did. Projects are not Items (ADR 0002), so
// their changes are logged apart from the activity log; the Items a merge moves get an activity
// entry each as well.
export const projectChange = z.object({
  id: z.number().int().positive(),
  at: timestamp,
  action: projectChangeAction,
  // The Project changed (the one kept, for a merge) as it is now; null for a reorder.
  project: project.nullable(),
  // For a merge, and undoing one: the Project merged away.
  mergedId: id.nullable(),
  // How many Items the change moved between Projects (a merge, or undoing one).
  moved: z.number().int().nonnegative(),
  // For an undo: the entry it reversed.
  undoes: z.number().int().positive().nullable(),
});
export type ProjectChange = z.infer<typeof projectChange>;

export const projectQuery = z.object({ includeArchived: z.boolean().optional() });
export type ProjectQuery = z.input<typeof projectQuery>;
