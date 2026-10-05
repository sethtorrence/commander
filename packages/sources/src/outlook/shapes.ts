import { z } from 'zod';

// Microsoft Graph v1.0 mail shapes, as far as Outlook mail sync reads them (#136). Fields Graph may
// leave out are optional here, so a sparse answer never breaks a sync.

const text = z.string().nullish();
const flag = z.boolean().nullish();

export const graphError = z
  .object({ error: z.object({ code: z.string().nullish(), message: z.string().nullish() }).nullish() })
  .nullish();

export const graphMailFolder = z.object({
  id: z.string().min(1),
  displayName: text,
  parentFolderId: text,
  childFolderCount: z.number().nullish(),
  totalItemCount: z.number().nullish(),
});
export type GraphMailFolder = z.infer<typeof graphMailFolder>;

export const mailFoldersPage = z.object({
  value: z
    .array(graphMailFolder)
    .nullish()
    .transform((value) => value ?? []),
  '@odata.nextLink': text,
});

const emailAddress = z.object({ name: text, address: text }).nullish();
const recipient = z.object({ emailAddress }).nullish();
const recipients = z
  .array(recipient)
  .nullish()
  .transform((value) => value ?? []);

export const graphMessage = z.object({
  id: z.string().min(1),
  // A delta's mark for a message gone from the folder (moved out, or deleted).
  '@removed': z.object({ reason: text }).nullish(),
  // `#microsoft.graph.eventMessage` for a meeting request, response or cancellation.
  '@odata.type': text,
  receivedDateTime: text,
  sentDateTime: text,
  subject: text,
  bodyPreview: text,
  body: z.object({ contentType: text, content: text }).nullish(),
  from: recipient,
  sender: recipient,
  toRecipients: recipients,
  ccRecipients: recipients,
  bccRecipients: recipients,
  replyTo: recipients,
  isRead: flag,
  isDraft: flag,
  flag: z.object({ flagStatus: text }).nullish(),
  parentFolderId: text,
  conversationId: text,
  internetMessageId: text,
  // The message's internet headers (Message-ID, In-Reply-To, References, List-Unsubscribe…): only
  // for mail that came over the internet; Outlook leaves them out of the User's own sent mail.
  internetMessageHeaders: z
    .array(z.object({ name: z.string(), value: z.string().nullish() }))
    .nullish()
    .transform((value) => value ?? []),
  categories: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  // Attachments other than inline ones.
  hasAttachments: flag,
  lastModifiedDateTime: text,
});
export type GraphMessage = z.infer<typeof graphMessage>;

export const deltaPage = z.object({
  value: z
    .array(graphMessage)
    .nullish()
    .transform((value) => value ?? []),
  '@odata.nextLink': text,
  '@odata.deltaLink': text,
});
export type DeltaPage = z.infer<typeof deltaPage>;

export const graphAttachment = z.object({
  id: z.string().min(1),
  '@odata.type': text,
  name: text,
  contentType: text,
  size: z.number().nullish(),
  isInline: flag,
  contentId: text,
});
export type GraphAttachment = z.infer<typeof graphAttachment>;

export const attachmentsPage = z.object({
  value: z
    .array(graphAttachment)
    .nullish()
    .transform((value) => value ?? []),
});

export const countAnswer = z.object({ '@odata.count': z.number().int().nonnegative() });

export const meAnswer = z.object({ mail: text, userPrincipalName: text });

// One of a JSON batch's answers.
export const batchAnswer = z.object({
  responses: z
    .array(
      z.object({
        id: z.string(),
        status: z.number(),
        headers: z.record(z.string(), z.string()).nullish(),
        body: z.unknown().optional(),
      }),
    )
    .default([]),
});

// What a write reads of a message before changing it, and gets back from a change.
export const messageState = z.object({
  id: z.string().min(1),
  isRead: flag,
  flag: z.object({ flagStatus: text }).nullish(),
  parentFolderId: text,
  categories: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  lastModifiedDateTime: text,
});
export type MessageState = z.infer<typeof messageState>;
