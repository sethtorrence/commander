import { z } from 'zod';
import { source } from './items';

// Two-way sync's outgoing queue, as the window sees it: each change made in Commander to a Source
// Item's synced field, waiting to reach the Source. Changes queue per Account with the time they were
// made, survive restarts, wait while offline and retry with back-off; after repeated failure (or a
// change the Source refuses outright) they stop as "Couldn't sync" until the User retries or undoes.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

// pending: waiting to be sent (or to retry); sending: on its way now; failed: Couldn't sync.
export const outgoingStatuses = ['pending', 'sending', 'failed'] as const;
export const outgoingStatus = z.enum(outgoingStatuses);
export type OutgoingStatus = z.infer<typeof outgoingStatus>;

export const outgoingChange = z.object({
  id: z.number().int().positive(),
  itemId: id,
  source,
  account: id,
  // The synced field (see synced-fields.ts), e.g. `priority` or `comment:<id>`.
  field: z.string().min(1),
  status: outgoingStatus,
  // When the User made the change: the time the conflict rule compares with the Source's history.
  madeAt: timestamp,
  attempts: z.number().int().nonnegative(),
  // Why the last attempt failed, in plain words.
  error: z.string().nullable(),
});
export type OutgoingChange = z.infer<typeof outgoingChange>;

export const outgoingQuery = z.object({
  itemIds: z.array(id).max(1000).optional(),
  account: id.optional(),
});
export type OutgoingQuery = z.input<typeof outgoingQuery>;
