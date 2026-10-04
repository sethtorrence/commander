import { z } from 'zod';
import { githubCatalog } from './github';
import { linearCatalog } from './linear';

// What each Account's Source keeps beside its Items, as its last sync fetched it: Linear's picker
// options (each team's states, members, labels, cycles and Linear projects), and GitHub's repo health.
export const sourceCatalog = z.discriminatedUnion('kind', [linearCatalog, githubCatalog]);
export type SourceCatalog = z.infer<typeof sourceCatalog>;
