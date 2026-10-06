import { z } from 'zod';
import { teamsCatalog } from './channel-posts';
import { gmailCatalog, outlookCatalog } from './email';
import { githubCatalog } from './github';
import { linearCatalog } from './linear';

// What each Account's Source keeps beside its Items, as its last sync fetched it: Linear's picker
// options (each team's states, members, labels, cycles and Linear projects), GitHub's repo health,
// Gmail's labels (#135), Outlook's folders (#136) and
// the teams and channels a Teams Account can sync (#111).
export const sourceCatalog = z.discriminatedUnion('kind', [
  linearCatalog,
  githubCatalog,
  gmailCatalog,
  outlookCatalog,
  teamsCatalog,
]);
export type SourceCatalog = z.infer<typeof sourceCatalog>;
