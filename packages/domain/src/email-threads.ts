import { z } from 'zod';
import { emailBody } from './email';
import { item } from './items';

// The Email Section's reads: the inbox as threads (across Accounts, or one), and one thread's
// messages with their plain-text bodies. Emails are Items, one per message (ADR 0001); a thread is
// the messages of one Account sharing a thread key (threadMessages).

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

// Threads with at least one message in the inbox, newest first. `account`: one Account's only.
export const emailThreadQuery = z.object({
  account: id.optional(),
  limit: z.number().int().positive().max(2000).optional(),
});
export type EmailThreadQuery = z.input<typeof emailThreadQuery>;

export const emailThreadSummary = z.object({
  account: id,
  threadKey: id,
  // The latest message's subject.
  subject: z.string(),
  // Who wrote in it, oldest first, each once ("me" for the User's own).
  senders: z.array(z.string()),
  // The latest message's snippet.
  snippet: z.string(),
  latestAt: timestamp,
  messageCount: count,
  unreadCount: count,
  hasAttachments: z.boolean(),
  // The latest message's Item: its Project (Badge), and any warning mark.
  latest: item,
  // Every message's Item id, oldest first (filing a thread files them all).
  itemIds: z.array(id),
});
export type EmailThreadSummary = z.infer<typeof emailThreadSummary>;

export const emailThreadList = z.object({
  threads: z.array(emailThreadSummary),
  // Threads in the inbox with unread mail (the Email tab's count), and all threads in the inbox,
  // for the Accounts the query covers.
  unreadThreads: count,
  total: count,
});
export type EmailThreadList = z.infer<typeof emailThreadList>;

// One thread's messages, oldest first, each with its bodies (null if none were kept).
export const emailThread = z.object({
  account: id,
  threadKey: id,
  messages: z.array(z.object({ item, body: emailBody.nullable() })),
});
export type EmailThread = z.infer<typeof emailThread>;
