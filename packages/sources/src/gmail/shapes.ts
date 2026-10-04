import { z } from 'zod';

// The Gmail API v1 answers Commander reads, as zod shapes: only the fields it uses, with everything
// else let through. https://developers.google.com/workspace/gmail/api/reference/rest

const header = z.object({ name: z.string(), value: z.string() });

export type GmailPart = {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    | { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined }
    | undefined;
  parts?: GmailPart[] | undefined;
};

export const gmailPart: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(header).optional(),
    body: z
      .object({
        size: z.number().optional(),
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(gmailPart).optional(),
  }),
);

export const gmailMessage = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  // Epoch milliseconds, as a string.
  internalDate: z.string().optional(),
  sizeEstimate: z.number().optional(),
  payload: gmailPart.optional(),
});
export type GmailMessage = z.infer<typeof gmailMessage>;

// users.messages.get?format=minimal, and what messages.modify, trash and untrash answer: the message's
// labels (and, from get, the history it was last changed at).
export const gmailMessageLabels = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  historyId: z.string().optional(),
});
export type GmailMessageLabels = z.infer<typeof gmailMessageLabels>;

// users.getProfile
export const gmailProfile = z.object({ emailAddress: z.string(), historyId: z.string().min(1) });

// users.messages.list: ids only.
export const gmailMessageList = z.object({
  messages: z.array(z.object({ id: z.string().min(1), threadId: z.string().optional() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

// users.labels.list
export const gmailLabels = z.object({
  labels: z
    .array(z.object({ id: z.string().min(1), name: z.string(), type: z.string().optional() }))
    .optional(),
});

// The message in a history record: its id, thread and (usually) its labels at that point.
const historyMessage = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});
const labelChange = z.object({ message: historyMessage, labelIds: z.array(z.string()).optional() });

// users.history.list
export const gmailHistory = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z.array(z.object({ message: historyMessage })).optional(),
        messagesDeleted: z.array(z.object({ message: historyMessage })).optional(),
        labelsAdded: z.array(labelChange).optional(),
        labelsRemoved: z.array(labelChange).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string().min(1),
});
export type GmailHistory = z.infer<typeof gmailHistory>;

// Google's error body: `{ error: { code, message, errors: [{ reason }], status } }`.
export const googleError = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() }).loose()).optional(),
  }),
});
