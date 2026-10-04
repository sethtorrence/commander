import { z } from 'zod';
import { emailBody, emailLabel } from './email';
import { item } from './items';

// The Email Section's reads: the inbox as threads (across Accounts, or one), and one thread's
// messages with their plain-text bodies. Emails are Items, one per message (ADR 0001); a thread is
// the messages of one Account sharing a thread key (threadMessages).

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

// The Email Section's views (#135): Inbox (the default), Starred, Snoozed, Archive (downloaded mail
// not in the inbox), Trash, and each label (`label:<id>`). See threadInView (email-actions.ts).
export const EMAIL_VIEWS = ['inbox', 'starred', 'snoozed', 'archive', 'trash'] as const;
export type EmailFixedView = (typeof EMAIL_VIEWS)[number];
export type EmailListView = EmailFixedView | `label:${string}`;
export const emailListView = z.union([
  z.enum(EMAIL_VIEWS),
  z.templateLiteral(['label:', z.string().min(1)]),
]) as z.ZodType<EmailListView>;

// A view's threads, newest first (a snoozed thread that came back counts from when it came back).
// `account`: one Account's only. `view`: the Inbox unless given.
export const emailThreadQuery = z.object({
  account: id.optional(),
  view: emailListView.optional(),
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
  // Starred: any of its messages out of Trash (#135).
  starred: z.boolean().optional(),
  // Its own labels (not Inbox, Unread, Starred or Trash), on messages out of Trash.
  labels: z.array(emailLabel).optional(),
  // Any of its messages in Trash.
  inTrash: z.boolean().optional(),
  // Snoozed until then (every message snoozed and waiting), or null.
  snoozedUntil: timestamp.nullable().optional(),
  // It came back from a snooze set for then ("Snoozed until 09:00"), until it is archived.
  returnedFrom: timestamp.nullable().optional(),
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

// Each view's threads and how many have unread mail, for the view list (#135): the fixed views, then
// each label (the Account's labels from its Source's catalog, and any its mail carries), by name.
export const emailViewQuery = z.object({ account: id.optional() });
export type EmailViewQuery = z.input<typeof emailViewQuery>;
export const emailViewCount = z.object({
  view: emailListView,
  name: z.string(),
  threads: count,
  unread: count,
});
export type EmailViewCount = z.infer<typeof emailViewCount>;
export const emailViewCounts = z.object({ views: z.array(emailViewCount) });
export type EmailViewCounts = z.infer<typeof emailViewCounts>;

// The Email Section's search (`/`): what was typed (with its operators, see parseEmailSearch), in one
// Account or all. Threads newest first; trashed ones only with in:trash.
export const emailSearchQuery = z.object({
  text: z.string().max(500),
  account: id.optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type EmailSearchQuery = z.input<typeof emailSearchQuery>;
export const emailSearchResult = z.object({ threads: z.array(emailThreadSummary) });
export type EmailSearchResult = z.infer<typeof emailSearchResult>;

// The labels the User can put on mail in an Account (`l`), by name: from its Source's catalog, and any
// its mail already carries.
export const emailLabelList = z.array(emailLabel);

// One thread's messages, oldest first, each with its bodies (null if none were kept).
export const emailThread = z.object({
  account: id,
  threadKey: id,
  messages: z.array(z.object({ item, body: emailBody.nullable() })),
});
export type EmailThread = z.infer<typeof emailThread>;
