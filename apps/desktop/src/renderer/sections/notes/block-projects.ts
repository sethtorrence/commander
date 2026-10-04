import {
  blockTag,
  type DailyNoteProjects,
  type Filing,
  inheritedFiling,
  isOwnFiling,
  type Project,
  replaceBlockTag,
} from '@commander/domain';
import { inFilter, type ProjectFilter } from '../../projects/filter';
import type { Block, BlockChange, Edit, Outline } from './outline';

/*
  Block Projects in the Notes Section (#51). A Block's own Project comes from the `#LT` shorthand in
  its text or from the Badge picker on its margin Badge; without one it shows its parent's, all the
  way up. In the outline a Block carries the filing its Item holds (`block.filing`), but only its own
  is trusted here: what a Block shows is worked out from the tree (effectiveFilings), so a re-filed
  parent shows on its children at once. The Item store keeps the same rule for every Block's Item
  (block-filing.ts in the Core), and re-files Todos made from Blocks alongside.
*/

type Coded = Pick<Project, 'id' | 'code' | 'archived'>;

/** A Block's own Project, if it has one (not inherited). */
export const ownFiling = (block: Pick<Block, 'filing'>): Filing =>
  block.filing && isOwnFiling(block.filing) ? block.filing : null;

/** The Project each Block shows: its own, or else its parent's, as inherited; null when Unfiled. */
export function effectiveFilings(outline: Outline): Map<string, Filing> {
  const found = new Map<string, Filing>();
  const resolve = (block: Block, depth: number): Filing => {
    const known = found.get(block.id);
    if (known !== undefined) return known;
    const own = ownFiling(block);
    const parent = block.parentId === null ? undefined : outline.get(block.parentId);
    // A depth guard, should a broken outline ever loop.
    const filing = own ?? (parent && depth < 1000 ? inheritedFiling(resolve(parent, depth + 1)) : null);
    found.set(block.id, filing);
    return filing;
  };
  for (const block of outline.values()) resolve(block, 0);
  return found;
}

// A Block as the shorthand in its new text files it, given the text it had before this change.
function tagged(block: Block, was: string | undefined, projects: readonly Coded[]): Block {
  const before = was === undefined ? null : blockTag(was, projects);
  const after = blockTag(block.text, projects);
  if (before?.projectId === after?.projectId) return block;
  return { ...block, filing: after ? { projectId: after.projectId, filedBy: 'user' } : null };
}

/**
 * An outline edit with the shorthand read: a Block whose text gains a known `#LT` is filed under LT
 * by the User, and one whose text loses it goes back to inheriting. `before` is the outline the edit
 * was made from.
 */
export function withTags(edit: Edit, before: Outline, projects: readonly Coded[]): Edit {
  if (!projects.length) return edit;
  let outline: Map<string, Block> | null = null;
  const changes = edit.changes.map((change): BlockChange => {
    if (change.type === 'delete') return change;
    const block = tagged(change.block, before.get(change.block.id)?.text, projects);
    if (block === change.block) return change;
    outline ??= new Map(edit.outline);
    outline.set(block.id, block);
    return { ...change, block };
  });
  return outline ? { ...edit, outline, changes } : edit;
}

/**
 * The Badge picker on a Block: files it under a Project by the User, or (null) back to inheriting.
 * A shorthand in its text follows: it changes to the Project's code, or goes for Unfiled.
 */
export function fileBlock(
  outline: Outline,
  id: string,
  projectId: string | null,
  projects: readonly (Coded & { id: string })[],
): Edit | null {
  const block = outline.get(id);
  if (!block) return null;
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
  if (projectId && !project) return null;
  const filing: Filing = project ? { projectId: project.id, filedBy: 'user' } : null;
  const text = replaceBlockTag(block.text, projects, project?.code ?? null);
  if (text === block.text && JSON.stringify(ownFiling(block)) === JSON.stringify(filing)) return null;
  const next: Block = { ...block, text, filing };
  return { outline: new Map(outline).set(id, next), changes: [{ type: 'update', block: next }] };
}

export interface FilterView {
  /** Blocks not shown: neither in the Project nor above one that is. */
  hidden: Set<string>;
  /** Blocks shown only as the context of those below them. */
  dimmed: Set<string>;
  /** How many Blocks are in the Project (or Unfiled). */
  matching: number;
}

/**
 * What a Daily Note shows under the Project filter: the Blocks in the chosen Project (or Unfiled),
 * with the Blocks above them dimmed as context. `keep` are Blocks the User is writing in, shown
 * whatever their Project so they don't vanish under the caret.
 */
export function filterView(outline: Outline, filter: ProjectFilter, keep?: ReadonlySet<string>): FilterView {
  if (filter === 'everything') return { hidden: new Set(), dimmed: new Set(), matching: outline.size };
  const filings = effectiveFilings(outline);
  const matched = new Set<string>();
  for (const [id, filing] of filings) if (inFilter(filter, { filing })) matched.add(id);
  const shown = new Set<string>();
  const dimmed = new Set<string>();
  const show = (id: string) => {
    shown.add(id);
    for (let parent = outline.get(id)?.parentId ?? null; parent && outline.has(parent); ) {
      if (shown.has(parent)) break;
      shown.add(parent);
      if (!matched.has(parent) && !keep?.has(parent)) dimmed.add(parent);
      parent = outline.get(parent)?.parentId ?? null;
    }
  };
  for (const id of matched) show(id);
  for (const id of keep ?? []) if (outline.has(id)) show(id);
  for (const id of shown) if (matched.has(id) || keep?.has(id)) dimmed.delete(id);
  const hidden = new Set([...outline.keys()].filter((id) => !shown.has(id)));
  return { hidden, dimmed, matching: matched.size };
}

/** The Projects a Daily Note's written Blocks are in, and whether any is Unfiled; null if none is written. */
export function dayProjects(day: string, outline: Outline): DailyNoteProjects | null {
  const filings = effectiveFilings(outline);
  const projectIds = new Set<string>();
  let unfiled = false;
  let written = false;
  for (const block of outline.values()) {
    if (block.text === '') continue;
    written = true;
    const filing = filings.get(block.id);
    if (filing) projectIds.add(filing.projectId);
    else unfiled = true;
  }
  return written ? { day, projectIds: [...projectIds], unfiled } : null;
}

/**
 * The Project filter's counts in Notes: how many Daily Notes have a written Block in each Project
 * (and Unfiled, and at all). `saved` is what the Item store says of every day; the days on screen
 * count as they are now, edits not yet saved included.
 */
export function noteCounts(
  saved: readonly DailyNoteProjects[],
  onScreen: readonly { day: string; outline: Outline }[],
): { everything: number; unfiled: number; project(projectId: string): number } {
  const byDay = new Map(saved.map((row) => [row.day, row]));
  for (const { day, outline } of onScreen) {
    const now = dayProjects(day, outline);
    if (now) byDay.set(day, now);
    else byDay.delete(day);
  }
  const perProject = new Map<string, number>();
  let unfiled = 0;
  for (const row of byDay.values()) {
    if (row.unfiled) unfiled += 1;
    for (const id of new Set(row.projectIds)) perProject.set(id, (perProject.get(id) ?? 0) + 1);
  }
  return { everything: byDay.size, unfiled, project: (id) => perProject.get(id) ?? 0 };
}
