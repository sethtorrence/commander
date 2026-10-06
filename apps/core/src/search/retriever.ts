import type { FoundBy, ItemKind } from '@commander/domain';
import type { QueryVector } from './meaning-index';

/*
  A retriever finds Items for a query, best first, applying every filter itself. Search runs each
  one and fuses their lists (fuse below). Two: the word index (FTS5), and the meaning index (#73),
  over embeddings of the same text, which answers only when the query comes with its embedding.
  Tantivy could replace the first without callers changing.
*/

export type SearchFilters = {
  kinds?: ItemKind[];
  projectId?: string | null;
  accounts?: string[];
  from?: number;
  to?: number;
};

export type RetrievedHit = {
  itemId: string;
  // The query is the Item's identifier or its whole title: it goes first, whatever the fusion says.
  exact: boolean;
};

export type RetrieverQuery = SearchFilters & {
  text: string;
  // What the text means, embedded: only the meaning index reads it.
  meaning?: QueryVector;
};

export interface Retriever {
  readonly foundBy: FoundBy;
  retrieve(query: RetrieverQuery, limit: number): RetrievedHit[];
}

export type FusedHit = RetrievedHit & { foundBy: FoundBy[] };

// Reciprocal rank fusion's constant: how much a top place counts over a lower one.
const RRF_K = 60;

/**
 * Merges ranked lists into one by reciprocal rank fusion: an Item's score is the sum of
 * 1 / (k + rank) over the lists it is in. Exact matches stay on top. With one list it keeps its order.
 */
export function fuse(lists: { foundBy: FoundBy; hits: RetrievedHit[] }[], limit: number): FusedHit[] {
  return fuseRanked(
    lists.map(({ foundBy, hits }) => ({
      foundBy,
      hits: hits.map(({ itemId, exact }) => ({ id: itemId, exact })),
    })),
    limit,
  ).map(({ id, exact, foundBy }) => ({ itemId: id, exact, foundBy }));
}

/**
 * `fuse` for anything ranked by id, found by retrievers of any names: Memory (../memory) fuses its
 * word index with its lookup by fields the same way.
 */
export function fuseRanked<Found extends string>(
  lists: { foundBy: Found; hits: { id: string; exact: boolean }[] }[],
  limit: number,
): { id: string; exact: boolean; foundBy: Found[] }[] {
  const merged = new Map<
    string,
    { id: string; exact: boolean; foundBy: Found[]; score: number; first: number }
  >();
  let seen = 0;
  for (const { foundBy, hits } of lists) {
    hits.forEach((hit, rank) => {
      const known = merged.get(hit.id);
      const score = 1 / (RRF_K + rank + 1);
      if (known) {
        known.score += score;
        known.exact ||= hit.exact;
        if (!known.foundBy.includes(foundBy)) known.foundBy.push(foundBy);
      } else {
        merged.set(hit.id, { id: hit.id, exact: hit.exact, foundBy: [foundBy], score, first: seen++ });
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.first - b.first)
    .slice(0, limit)
    .map(({ id, exact, foundBy }) => ({ id, exact, foundBy }));
}
