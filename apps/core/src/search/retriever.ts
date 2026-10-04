import type { FoundBy, ItemKind } from '@commander/domain';

/*
  A retriever finds Items for a query, best first, applying every filter itself. Search runs each
  one and fuses their lists (fuse below). Today there is one, the word index (FTS5); search by
  meaning (#73) adds a second, over embeddings of the same text, and Tantivy could replace the
  first, without callers changing.
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

export interface Retriever {
  readonly foundBy: FoundBy;
  retrieve(query: SearchFilters & { text: string }, limit: number): RetrievedHit[];
}

export type FusedHit = RetrievedHit & { foundBy: FoundBy[] };

// Reciprocal rank fusion's constant: how much a top place counts over a lower one.
const RRF_K = 60;

/**
 * Merges ranked lists into one by reciprocal rank fusion: an Item's score is the sum of
 * 1 / (k + rank) over the lists it is in. Exact matches stay on top. With one list it keeps its order.
 */
export function fuse(lists: { foundBy: FoundBy; hits: RetrievedHit[] }[], limit: number): FusedHit[] {
  const merged = new Map<string, FusedHit & { score: number; first: number }>();
  let seen = 0;
  for (const { foundBy, hits } of lists) {
    hits.forEach((hit, rank) => {
      const known = merged.get(hit.itemId);
      const score = 1 / (RRF_K + rank + 1);
      if (known) {
        known.score += score;
        known.exact ||= hit.exact;
        if (!known.foundBy.includes(foundBy)) known.foundBy.push(foundBy);
      } else {
        merged.set(hit.itemId, { ...hit, foundBy: [foundBy], score, first: seen++ });
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.first - b.first)
    .slice(0, limit)
    .map(({ itemId, exact, foundBy }) => ({ itemId, exact, foundBy }));
}
