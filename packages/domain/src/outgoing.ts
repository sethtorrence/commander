import { z } from 'zod';
import { itemKind, source } from './items';

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

// Where a message written in Commander is looked after (#138, #139): its sending in the Outbox (or, held
// by Microsoft for later, in Scheduled), its draft in Drafts. Those changes keep the Outbox's own
// Retry and Undo; nothing elsewhere discards them, so a message is never dropped by surprise.
export const messageViews = ['outbox', 'scheduled', 'drafts'] as const;
export const messageView = z.enum(messageViews);
export type MessageView = z.infer<typeof messageView>;

// A queued change as Settings → Accounts lists it (#206): what it was in Commander's words ("Move to
// In Review"), the Item it is on, and, for a message written in Commander, where the Outbox has it.
export const outgoingEntry = outgoingChange.extend({
  what: z.string().min(1),
  item: z.object({
    title: z.string(),
    // The Source's short name for it (ENG-418), when it has one.
    label: z.string().nullable(),
    kind: itemKind,
  }),
  message: messageView.nullable(),
});
export type OutgoingEntry = z.infer<typeof outgoingEntry>;

// What Settings asks for: one Account's queued changes, or (no Account) every Account's.
export const outgoingEntriesQuery = z.object({ account: id.optional() });
export type OutgoingEntriesQuery = z.input<typeof outgoingEntriesQuery>;

// Retry and Discard name the changes by their ids.
export const outgoingIds = z.array(z.number().int().positive()).min(1).max(1000);
