import { z } from 'zod';
import { item, itemKind } from './items';
import { memory } from './memory';
import { person } from './people';
import { project } from './projects';

// Global search: what the window asks the Core's search module, and what it answers. Search is
// local only and never waits on a model. Results are ranked by how well their words match, with
// exact identifier (ENG-418) and title matches first.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

export const searchQuery = z.object({
  // What the User typed, without the filter chips (the window reads those). The last word matches
  // as a prefix, so results come as the User types.
  text: z.string().max(500),
  // Only Items of these kinds (a Section: Notes is blocks and daily notes).
  kinds: z.array(itemKind).optional(),
  // Only Items filed under this Project, or Unfiled ones with null.
  projectId: id.nullable().optional(),
  // Only Items from these Accounts.
  accounts: z.array(id).optional(),
  // Only Items last changed in this range, epoch milliseconds: from inclusive, to exclusive.
  from: timestamp.optional(),
  to: timestamp.optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type SearchQuery = z.input<typeof searchQuery>;

// How a result was found: by its words (FTS5), or, once search by meaning arrives, by what it means.
export const foundBy = z.enum(['words', 'meaning']);
export type FoundBy = z.infer<typeof foundBy>;

export const searchHit = z.object({
  item,
  // The calendar day a Block or Daily Note belongs to, for opening it in Notes; null otherwise.
  day: z.iso.date().nullable(),
  // The query is the Item's identifier (ENG-418) or its whole title.
  exact: z.boolean(),
  foundBy: z.array(foundBy).min(1),
});
export type SearchHit = z.infer<typeof searchHit>;

export const searchResult = z.object({
  // Best first.
  hits: z.array(searchHit),
  // Projects whose name or code matches, in their order (not archived). Only when no filter narrows
  // the search to Items.
  projects: z.array(project),
  // People whose name or a handle matches (#117), the User first, then by name. Only when no filter
  // narrows the search to Items.
  people: z.array(person).optional(),
  // What Ares knows (#74) whose words match, best first. Only when no filter narrows the search.
  memories: z.array(memory).optional(),
});
export type SearchResult = z.infer<typeof searchResult>;
