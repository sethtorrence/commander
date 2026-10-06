import type { MemoryKind } from '@commander/domain';
import type { QueryVector } from '../search/meaning-index';

/*
  The seam inside Memory's lookup. A retriever finds live memories for a lookup, best first; Memory
  runs each one and fuses their lists by reciprocal rank (search/retriever.ts's fuseRanked), so a
  memory two of them find comes before one only one finds. Three:

  - words: the FTS5 word index over each memory's text and keywords (words.ts);
  - fields: what a memory is about, matched by who and what an Item involves (a Person, any of their
    handles, a Project) (fields.ts);
  - meaning (#73): embeddings of the same text (meaning.ts), answering only when the lookup brings
    the embedding of what it is about (`meaning`).

  Each hears of every memory as it is saved (`put`) and deleted (`drop`).
*/

export type MemoryFoundBy = 'words' | 'fields' | 'meaning';

export type RetrieverQuery = {
  // The words to find memories by: what the User typed (`typed`), or what Ares is working on.
  text: string;
  typed?: boolean;
  // Who and what it is about, already widened to every handle of each Person named.
  personIds: string[];
  handles: string[];
  projectIds: string[];
  kinds?: readonly MemoryKind[];
  // The text embedded, for the meaning retriever.
  meaning?: QueryVector;
};

export type RetrievedMemory = { id: string; exact: boolean };

// What a retriever indexes of a memory as it is saved.
export type IndexedMemory = {
  id: string;
  kind: MemoryKind;
  text: string;
  keywords: string;
  handles: readonly string[];
};

export interface MemoryRetriever {
  readonly foundBy: MemoryFoundBy;
  retrieve(query: RetrieverQuery, limit: number): RetrievedMemory[];
  // Called with each memory as it is saved, and each one deleted, inside the change's transaction.
  put?(memory: IndexedMemory): void;
  drop?(memoryId: string): void;
}
