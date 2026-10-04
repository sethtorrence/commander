import type { LinkEnd, LinkType } from '@commander/domain';
import { SOURCE_NAMES, type TodoLink } from './todos';

// How the detail pane words a Todo's Links and the Items at their other ends.

// Each Link type read from its start ("made from") and from its end ("made into").
const LABELS: Record<LinkType, [from: string, to: string]> = {
  'made-from': ['Made from', 'Made into'],
  'refers-to': ['Refers to', 'Mentioned in'],
  finishes: ['Finishes', 'Finished by'],
  about: ['About', 'Subject of'],
  'caused-by': ['Caused by', 'Led to'],
};

/** What a Link is to the Todo: "Made from" the email, or "Mentioned in" a Daily Note. */
export function linkLabel(link: TodoLink): string {
  return LABELS[link.type][link.backlink ? 1 : 0];
}

// Keyed by string, not ItemKind, so a kind added later (a Daily Note) falls back instead of failing.
const KINDS: Record<string, { tag: string; section: string | null }> = {
  email: { tag: 'EML', section: 'email' },
  event: { tag: 'CAL', section: 'calendar' },
  'linear-issue': { tag: 'LIN', section: 'linear' },
  'pull-request': { tag: 'GH', section: 'github' },
  'review-request': { tag: 'GH', section: 'github' },
  chat: { tag: 'TMS', section: 'teams' },
  'channel-post': { tag: 'TMS', section: null },
  todo: { tag: 'TDO', section: 'todos' },
  block: { tag: 'DN', section: 'notes' },
  'daily-note': { tag: 'DN', section: 'notes' },
  // Not an Item: a refers-to Link may point at a Project, which opens its Project page.
  project: { tag: 'PRJ', section: null },
};

/** The short code an Item's kind is tagged with, as on the prototype's tags: EML, LIN, DN. */
export function kindTag(kind: string): string {
  return KINDS[kind]?.tag ?? kind.slice(0, 3).toUpperCase();
}

/** The id of the Section that holds Items of this kind, or null while none does (Channel posts). */
export function sectionFor(kind: string): string | null {
  return KINDS[kind]?.section ?? null;
}

/** "deleted in Gmail" for a tombstone, "deleted" for an Item deleted in Commander, else null. */
export function goneNote(item: LinkEnd): string | null {
  if (item.kind === 'project' || item.deletedAt === null) return null;
  return item.source ? `deleted in ${SOURCE_NAMES[item.source]}` : 'deleted';
}
