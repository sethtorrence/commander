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
// `#RRGGBB` (custom accents arrive with managing Projects).
export const projectAccent = z
  .string({ error: 'A Project needs an accent colour' })
  .regex(/^(?:[a-z]+|#[0-9A-Fa-f]{6})$/, 'A Project needs an accent colour');

export const project = z.object({
  id,
  name: z.string().min(1),
  code: z.string().regex(/^[A-Z]{2}$/),
  accent: projectAccent,
  // Its place in the filter bar and the Badge picker, from 0. Creation order until Projects can be
  // reordered.
  order: z.number().int().nonnegative(),
  // Archived Projects leave the filter bar and the Badge picker; their Items keep their Badges.
  archived: z.boolean(),
  createdAt: timestamp,
});
export type Project = z.infer<typeof project>;

export const newProject = z.object({
  name: z.string().trim().min(1, 'A Project needs a name'),
  code: projectCode,
  accent: projectAccent,
});
export type NewProject = z.input<typeof newProject>;

// Every change to Projects is one of these. Rename, reorder, archive and merge join them when
// Projects can be managed.
export const projectAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), project: newProject }),
]);
export type ProjectAction = z.input<typeof projectAction>;

export const projectQuery = z.object({ includeArchived: z.boolean().optional() });
export type ProjectQuery = z.input<typeof projectQuery>;
