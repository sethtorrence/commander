import type { FiledBy, Item } from '@commander/domain';
import { dayOfYear } from '../../frame/calendar';

/*
  The numbers on a Project page, computed over the Project's Items. In M1 there are Todos and the
  Notes' Blocks; the Sections that come later (Email, Linear, Calendar, GitHub) add their own counts.
*/

/**
 * Per-Section counts: open Todos, Blocks in the Notes, Teams Chats, and open GitHub pull requests and
 * issues (#118; a review request is its pull request's shadow, so it isn't counted again).
 */
export function sectionCounts(items: readonly Pick<Item, 'kind' | 'status'>[]): {
  todos: number;
  notes: number;
  teams: number;
  github: number;
} {
  let todos = 0;
  let notes = 0;
  let teams = 0;
  let github = 0;
  for (const { kind, status } of items) {
    if (kind === 'todo' && status === 'open') todos += 1;
    if (kind === 'block') notes += 1;
    if (kind === 'chat' || kind === 'channel-post') teams += 1;
    if ((kind === 'pull-request' || kind === 'github-issue') && status === 'open') github += 1;
  }
  return { todos, notes, teams, github };
}

/** How the Items were filed: by a Rule, by Ares, by the User, or inherited from their source. */
export function filingBreakdown(items: readonly Pick<Item, 'filing'>[]): Record<FiledBy, number> {
  const counts: Record<FiledBy, number> = { rule: 0, ares: 0, user: 0, inherited: 0 };
  for (const { filing } of items) if (filing) counts[filing.filedBy] += 1;
  return counts;
}

/** The Project sheet's part number, as the prototype labels it: PRJ-LT-274. */
export function projectPartNumber(code: string, date: Date): string {
  return `PRJ-${code}-${String(dayOfYear(date)).padStart(3, '0')}`;
}
