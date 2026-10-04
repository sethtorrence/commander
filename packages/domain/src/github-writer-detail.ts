import { z } from 'zod';

/*
  What the oversight summary's writer (Ares, #121) reads about each pull request in a summary (#119),
  beyond what GitHub sync keeps: its description, its linked issues' titles and bodies, its reviews
  and review comments, its first GITHUB_WRITER_COMMENTS conversation comments, and a change outline
  (files changed grouped by top-level area, with additions and deletions per area, from the first
  GITHUB_WRITER_FILES files). Never the diff itself.

  The Core fetches it after GitHub syncs, batched with GraphQL, and keeps it beside the Item's detail
  for the detail's `updatedAt` it was fetched for: once the pull request changes, it is fetched again.
  Every body is Markdown written by other people: untrusted Source content, for the prompt builder's
  outside blocks only.
*/

const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const login = z.string().min(1).nullable();

// The conversation comments read, from the first.
export const GITHUB_WRITER_COMMENTS = 30;
// The files the change outline counts, from the first.
export const GITHUB_WRITER_FILES = 100;
// Pull requests asked about per GraphQL query.
export const GITHUB_WRITER_BATCH = 25;

export const changeArea = z.object({ area: z.string(), files: count, additions: count, deletions: count });
export type ChangeArea = z.infer<typeof changeArea>;

export const changeOutlineSchema = z.object({
  // Biggest change (additions and deletions) first.
  areas: z.array(changeArea),
  // The files counted, and how many the pull request changes in all.
  files: count,
  totalFiles: count,
});
export type ChangeOutline = z.infer<typeof changeOutlineSchema>;

export const githubWriterDetail = z.object({
  // The pull request's detail `updatedAt` it was fetched for.
  forUpdatedAt: timestamp,
  fetchedAt: timestamp,
  description: z.string(),
  linkedIssues: z.array(
    z.object({
      owner: z.string(),
      name: z.string(),
      number: z.number().int().positive(),
      title: z.string(),
      body: z.string(),
    }),
  ),
  // Reviews with a verdict or a body, oldest first.
  reviews: z.array(
    z.object({
      author: login,
      state: z.enum(['approved', 'changes-requested', 'commented', 'dismissed']),
      body: z.string(),
      at: timestamp,
    }),
  ),
  // Comments on lines of the code, oldest first.
  reviewComments: z.array(
    z.object({ author: login, body: z.string(), at: timestamp, path: z.string().nullable() }),
  ),
  // The first conversation comments; `moreComments`: there were more.
  comments: z.array(z.object({ author: login, body: z.string(), at: timestamp })),
  moreComments: z.boolean(),
  changeOutline: changeOutlineSchema,
});
export type GitHubWriterDetail = z.infer<typeof githubWriterDetail>;

// Folders that hold one package each in a monorepo: their packages are the areas.
const CONTAINERS = new Set(['apps', 'packages', 'libs', 'services', 'crates', 'modules', 'plugins', 'tools']);

/** A changed file's area: a monorepo package ("apps/core"), else its top folder, else "(root)". */
export function areaOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  const [top, second] = parts as [string, string];
  return CONTAINERS.has(top) && parts.length > 2 ? `${top}/${second}` : top;
}

/** The change outline of the files read: per area, biggest change first. */
export function changeOutline(
  files: readonly { path: string; additions: number; deletions: number }[],
  totalFiles: number,
): ChangeOutline {
  const areas = new Map<string, ChangeArea>();
  for (const file of files) {
    const area = areaOf(file.path);
    const found = areas.get(area) ?? { area, files: 0, additions: 0, deletions: 0 };
    found.files += 1;
    found.additions += file.additions;
    found.deletions += file.deletions;
    areas.set(area, found);
  }
  return {
    areas: [...areas.values()].sort(
      (a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.area.localeCompare(b.area),
    ),
    files: files.length,
    totalFiles: Math.max(totalFiles, files.length),
  };
}
