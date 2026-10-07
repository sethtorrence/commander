import { z } from 'zod';
import { turnAuthor } from './conversations';
import { item, itemKind } from './items';
import { memory } from './memory';
import { person } from './people';
import { project } from './projects';

// Global search: what the window asks the Core's search module, and what it answers. Search is
// local only. Results are ranked by how well their words match, with exact identifier (ENG-418) and
// title matches first; search by meaning (#73) merges in what an embedding model running on this
// machine finds, in a second answer, so word results never wait on it. Conversations with Ares are
// found the same way, turn by turn (#195).

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

// How a result was found: by its words (FTS5), or by what it means (an embedding, #73).
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

// A Conversation with Ares that matches (#195): the turn that matches best, and its matching line.
export const conversationHit = z.object({
  conversationId: id,
  // The Conversation as the list names it (conversationName): its first words, or its day.
  title: z.string().nullable(),
  day: z.iso.date(),
  daily: z.boolean(),
  // The turn that matched, which opening the Conversation shows, and who wrote it.
  turnId: z.number().int().positive(),
  by: turnAuthor,
  // The line of that turn that matched (shortened around the words when long).
  line: z.string(),
  foundBy: z.array(foundBy).min(1),
});
export type ConversationHit = z.infer<typeof conversationHit>;

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
  // Conversations with Ares whose turns match (#195), best first, one hit each. Only when no filter
  // narrows the search.
  conversations: z.array(conversationHit).optional(),
});
export type SearchResult = z.infer<typeof searchResult>;

const count = z.number().int().nonnegative();

// Where search by meaning stands (#73), for Settings → Ares: the embedding model is downloaded once
// (with progress), loaded, then embeds every Item and memory in the background.
export const searchByMeaningStates = ['off', 'waiting', 'downloading', 'loading', 'ready', 'failed'] as const;
export const searchByMeaningStatus = z.object({
  // The User's setting.
  on: z.boolean(),
  state: z.enum(searchByMeaningStates),
  model: z.object({ name: z.string(), downloadBytes: count }),
  // While downloading.
  receivedBytes: count,
  totalBytes: count,
  // Items and memories embedded by the model, out of all there are to embed.
  embedded: count,
  total: count,
  // Why it failed (it tries again later), or null.
  problem: z.string().nullable(),
});
export type SearchByMeaningStatus = z.infer<typeof searchByMeaningStatus>;
