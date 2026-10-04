import type { Filing } from './items';
import type { Project } from './projects';

/*
  Block Projects (#13, #25): a Block's own Project, set with the `#LT` shorthand in its text or by the
  User from the Badge picker, and otherwise its parent's, all the way up; a top-level Block with none
  is Unfiled. Shared by the window (which reads the shorthand as the User types) and the Core (which
  keeps every Block's effective Project on its Item, filed as inherited).

  The shorthand is `#` followed directly by letters, standing on its own (at the start, or after a
  space or an opening bracket) and ending at anything but a letter or digit. Only an active Project's
  code counts, in any case; anything else stays plain text. `# ` with a space is a heading, not this.
*/

type Coded = Pick<Project, 'id' | 'code' | 'archived'>;

/** Every `#letters` in a Block's text, with where it starts and ends. */
const TAG = /(^|[\s([{])#([A-Za-z]+)(?![A-Za-z0-9_])/g;

export interface BlockTag {
  projectId: string;
  /** The Project's code, as stored (upper case). */
  code: string;
  /** Where `#` is in the text, and just past the code. */
  start: number;
  end: number;
}

/** Every known Project code written in the text, in order. */
export function blockTags(text: string, projects: readonly Coded[]): BlockTag[] {
  const byCode = new Map(projects.filter((p) => !p.archived).map((p) => [p.code.toUpperCase(), p]));
  const tags: BlockTag[] = [];
  for (const match of text.matchAll(TAG)) {
    const letters = match[2] ?? '';
    const project = byCode.get(letters.toUpperCase());
    if (!project) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    tags.push({ projectId: project.id, code: project.code, start, end: start + 1 + letters.length });
  }
  return tags;
}

/** The Block's own Project as its text names it: the first known code, or null. */
export function blockTag(text: string, projects: readonly Coded[]): BlockTag | null {
  return blockTags(text, projects)[0] ?? null;
}

/**
 * The text with its first known code changed to `code`, or removed (with one space next to it) when
 * `code` is null. Text without one is returned as it is.
 */
export function replaceBlockTag(text: string, projects: readonly Coded[], code: string | null): string {
  const tag = blockTag(text, projects);
  if (!tag) return text;
  if (code) return `${text.slice(0, tag.start)}#${code}${text.slice(tag.end)}`;
  const before = text.slice(0, tag.start);
  const after = text.slice(tag.end);
  if (after.startsWith(' ')) return before + after.slice(1);
  if (before.endsWith(' ')) return before.slice(0, -1) + after;
  return before + after;
}

/**
 * The shorthand being typed: `#` and at least one letter just before the caret, standing on its own.
 * Its letters (the picker's query) and where `#` is; null otherwise.
 */
export function tagBeingTyped(text: string, caret: number): { query: string; start: number } | null {
  const match = /(^|[\s([{])#([A-Za-z]+)$/.exec(text.slice(0, caret));
  if (!match) return null;
  if (/^[A-Za-z0-9_]/.test(text.slice(caret))) return null;
  const query = match[2] ?? '';
  return { query, start: caret - query.length - 1 };
}

/** Whether an Item's Project is its own (by the User, a Rule or Ares) rather than inherited. */
export function isOwnFiling(filing: Filing): boolean {
  return filing !== null && filing.filedBy !== 'inherited';
}

/** The filing a Block (or a Todo made from one) takes from the Item it follows. */
export function inheritedFiling(from: Filing): Filing {
  return from ? { projectId: from.projectId, filedBy: 'inherited' } : null;
}
