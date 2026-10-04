import { z } from 'zod';
import { gmailCatalog } from './email';
import { githubCatalog } from './github';
import { linearCatalog } from './linear';

// What each Account's Source keeps beside its Items, as its last sync fetched it: Linear's picker
// options (each team's states, members, labels, cycles and Linear projects), GitHub's repo health,
// and Gmail's labels (#135).
export const sourceCatalog = z.discriminatedUnion('kind', [linearCatalog, githubCatalog, gmailCatalog]);
export type SourceCatalog = z.infer<typeof sourceCatalog>;
