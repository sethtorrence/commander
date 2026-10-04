import type { IncomingMessage, ServerResponse } from 'node:http';

// The Gmail API v1 part of the fake Google (fake-google-server.ts), for tests only: each user's
// mailbox, answering what Commander's Gmail sync asks (`users.getProfile`, `labels.list`,
// `messages.list` with `q=after:` and `labelIds`, `messages.get?format=full`, `history.list`) the way
// Gmail does: newest first, Spam and Trash left out of listings, a historyId that rises with every
// change, history records for messages added and deleted and labels added and removed, a 404 for a
// history that has expired, and 403 `rateLimitExceeded` when the per-minute quota is spent.
// Nothing here talks to the real Gmail.

export type FakeGmailMessageInput = {
  id?: string;
  threadId?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  // Epoch milliseconds.
  date: number;
  labels?: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  // Attachments, and inline images (with a Content-ID), served by `messages.attachments.get`.
  attachments?: {
    name: string;
    type: string;
    content: Buffer | string;
    contentId?: string;
    inline?: boolean;
  }[];
};

type StoredMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  date: number;
  json: unknown;
  // Attachment bytes by attachment id.
  parts: Map<string, Buffer>;
};

type HistoryRecord = {
  id: number;
  messagesAdded?: { message: { id: string; threadId: string; labelIds: string[] } }[];
  messagesDeleted?: { message: { id: string; threadId: string } }[];
  labelsAdded?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[];
};

type Mailbox = {
  email: string;
  messages: Map<string, StoredMessage>;
  history: HistoryRecord[];
  historyId: number;
  // History before this historyId has expired (history.list from earlier answers 404).
  expiredBefore: number;
};

export type FakeGmail = {
  // Every Gmail API request, as its path and query (`/gmail/v1/users/me/messages?…`).
  requests: string[];
  // Puts a message in a user's mailbox (INBOX and UNREAD unless `labels` says otherwise). Returns its id.
  deliver(email: string, message: FakeGmailMessageInput): string;
  // Changes a message's labels, as the User would in Gmail.
  relabel(email: string, id: string, change: { add?: string[]; remove?: string[] }): void;
  // Deletes a message for good.
  remove(email: string, id: string): void;
  // Gmail's history before now expires: the next history.list from an earlier historyId answers 404.
  expireHistory(email: string): void;
  // Every Gmail request answers 403 rateLimitExceeded until switched back.
  throttle(throttled: boolean): void;
  // Answers a Gmail request, for the user its access token belongs to (null: not signed in).
  handle(request: IncomingMessage, response: ServerResponse, url: URL, email: string | null): void;
};

const SYSTEM_LABELS = [
  'INBOX',
  'SENT',
  'IMPORTANT',
  'TRASH',
  'DRAFT',
  'SPAM',
  'STARRED',
  'UNREAD',
  'CATEGORY_PERSONAL',
  'CATEGORY_UPDATES',
];
const HIDDEN = new Set(['SPAM', 'TRASH']);

const b64 = (text: string) => Buffer.from(text).toString('base64url');

function json(response: ServerResponse, status: number, value: unknown) {
  response
    .writeHead(status, { 'content-type': 'application/json; charset=UTF-8' })
    .end(JSON.stringify(value));
}

const googleError = (code: number, status: string, reason: string, message: string) => ({
  error: { code, message, errors: [{ message, domain: 'global', reason }], status },
});

function messageJson(id: string, threadId: string, labelIds: string[], input: FakeGmailMessageInput) {
  const headers = [
    { name: 'Date', value: new Date(input.date).toUTCString().replace('GMT', '+0000') },
    { name: 'Message-ID', value: input.messageId ?? `<${id}@mail.fake.test>` },
    ...(input.inReplyTo ? [{ name: 'In-Reply-To', value: input.inReplyTo }] : []),
    ...(input.references ? [{ name: 'References', value: input.references }] : []),
    { name: 'Subject', value: input.subject },
    { name: 'From', value: input.from },
    { name: 'To', value: input.to },
  ];
  const textPart = (partId: string) => ({
    partId,
    mimeType: 'text/plain',
    filename: '',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
    body: { size: Buffer.byteLength(input.text), data: b64(input.text) },
  });
  // The message's text (and HTML) as a part numbered `partId`, its children `<partId>.0`, `.1`.
  const child = (partId: string, index: number) => (partId ? `${partId}.${index}` : String(index));
  const bodyPart = (partId: string) =>
    input.html
      ? {
          partId,
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'multipart/alternative; boundary="alt"' }],
          body: { size: 0 },
          parts: [
            textPart(child(partId, 0)),
            {
              partId: child(partId, 1),
              mimeType: 'text/html',
              filename: '',
              headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
              body: { size: Buffer.byteLength(input.html), data: b64(input.html) },
            },
          ],
        }
      : textPart(partId);
  const attachments = (input.attachments ?? []).map((attachment, index) => ({
    partId: String(index + 1),
    mimeType: attachment.type,
    filename: attachment.name,
    headers: [
      { name: 'Content-Type', value: `${attachment.type}; name="${attachment.name}"` },
      {
        name: 'Content-Disposition',
        value: `${attachment.inline ? 'inline' : 'attachment'}; filename="${attachment.name}"`,
      },
      ...(attachment.contentId ? [{ name: 'Content-ID', value: `<${attachment.contentId}>` }] : []),
    ],
    body: { size: Buffer.byteLength(attachment.content), attachmentId: `att-${id}-${index + 1}` },
  }));
  const top = attachments.length
    ? {
        partId: '',
        mimeType: 'multipart/mixed',
        filename: '',
        headers: [{ name: 'Content-Type', value: 'multipart/mixed; boundary="mixed"' }],
        body: { size: 0 },
        parts: [bodyPart('0'), ...attachments],
      }
    : bodyPart('');
  const payload = { ...top, headers: [...headers, ...top.headers] };
  return {
    id,
    threadId,
    labelIds,
    snippet: input.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    internalDate: String(input.date),
    sizeEstimate: 1000 + input.text.length,
    payload,
  };
}

export function createFakeGmail(): FakeGmail {
  const mailboxes = new Map<string, Mailbox>();
  let throttled = false;
  let nextId = 0x19a000000000;

  const mailbox = (email: string): Mailbox => {
    let found = mailboxes.get(email);
    if (!found) {
      found = { email, messages: new Map(), history: [], historyId: 1000, expiredBefore: 0 };
      mailboxes.set(email, found);
    }
    return found;
  };
  const record = (box: Mailbox, entry: Omit<HistoryRecord, 'id'>) => {
    box.historyId += 1;
    box.history.push({ id: box.historyId, ...entry });
  };
  const refOf = (message: StoredMessage) => ({
    id: message.id,
    threadId: message.threadId,
    labelIds: [...message.labelIds],
  });

  function list(box: Mailbox, url: URL): unknown {
    const after = /after:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1];
    const labels = url.searchParams.getAll('labelIds');
    const max = Number(url.searchParams.get('maxResults') ?? 100);
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    const found = [...box.messages.values()]
      .filter((message) => !message.labelIds.some((label) => HIDDEN.has(label)))
      .filter((message) => after === undefined || message.date >= Number(after) * 1000)
      .filter((message) => labels.every((label) => message.labelIds.includes(label)))
      .sort((a, b) => b.date - a.date);
    const page = found.slice(offset, offset + max);
    return {
      ...(page.length
        ? { messages: page.map((message) => ({ id: message.id, threadId: message.threadId })) }
        : {}),
      ...(offset + max < found.length ? { nextPageToken: String(offset + max) } : {}),
      resultSizeEstimate: found.length,
    };
  }

  function history(box: Mailbox, url: URL, response: ServerResponse) {
    const start = Number(url.searchParams.get('startHistoryId'));
    if (!Number.isFinite(start) || start < box.expiredBefore) {
      return json(
        response,
        404,
        googleError(404, 'NOT_FOUND', 'notFound', 'Requested entity was not found.'),
      );
    }
    const records = box.history.filter((entry) => entry.id > start);
    return json(response, 200, {
      ...(records.length ? { history: records.map((entry) => ({ ...entry, id: String(entry.id) })) } : {}),
      historyId: String(box.historyId),
    });
  }

  const fake: FakeGmail = {
    requests: [],

    deliver(email, input) {
      const box = mailbox(email);
      const id = input.id ?? (nextId++).toString(16);
      const threadId = input.threadId ?? id;
      const labelIds = input.labels ?? ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'];
      const message: StoredMessage = {
        id,
        threadId,
        labelIds,
        date: input.date,
        json: messageJson(id, threadId, labelIds, input),
        parts: new Map(
          (input.attachments ?? []).map((attachment, index) => [
            `att-${id}-${index + 1}`,
            Buffer.from(attachment.content),
          ]),
        ),
      };
      box.messages.set(id, message);
      record(box, { messagesAdded: [{ message: refOf(message) }] });
      return id;
    },

    relabel(email, id, { add = [], remove = [] }) {
      const box = mailbox(email);
      const message = box.messages.get(id);
      if (!message) throw new Error(`No message ${id}`);
      message.labelIds = [...message.labelIds.filter((label) => !remove.includes(label)), ...add];
      message.json = { ...(message.json as object), labelIds: message.labelIds };
      if (add.length) record(box, { labelsAdded: [{ message: refOf(message), labelIds: add }] });
      if (remove.length) record(box, { labelsRemoved: [{ message: refOf(message), labelIds: remove }] });
    },

    remove(email, id) {
      const box = mailbox(email);
      const message = box.messages.get(id);
      if (!message) return;
      box.messages.delete(id);
      record(box, { messagesDeleted: [{ message: { id, threadId: message.threadId } }] });
    },

    expireHistory(email) {
      const box = mailbox(email);
      box.expiredBefore = box.historyId;
    },

    throttle(on) {
      throttled = on;
    },

    handle(request, response, url, email) {
      fake.requests.push(`${url.pathname}${url.search}`);
      if (!email) {
        return json(response, 401, googleError(401, 'UNAUTHENTICATED', 'authError', 'Invalid Credentials'));
      }
      if (throttled) {
        const message =
          "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com'.";
        return json(response, 403, googleError(403, 'PERMISSION_DENIED', 'rateLimitExceeded', message));
      }
      if (request.method !== 'GET') return json(response, 405, {});
      const box = mailbox(email);
      const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, '');
      if (path === '/profile') {
        return json(response, 200, {
          emailAddress: email,
          messagesTotal: box.messages.size,
          threadsTotal: new Set([...box.messages.values()].map((message) => message.threadId)).size,
          historyId: String(box.historyId),
        });
      }
      if (path === '/labels') {
        return json(response, 200, {
          labels: [
            ...SYSTEM_LABELS.map((id) => ({ id, name: id, type: 'system' })),
            { id: 'Label_1', name: 'Receipts', type: 'user' },
          ],
        });
      }
      if (path === '/messages') return json(response, 200, list(box, url));
      if (path === '/history') return history(box, url, response);
      const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
      if (attachment) {
        const bytes = box.messages
          .get(decodeURIComponent(attachment[1] ?? ''))
          ?.parts.get(decodeURIComponent(attachment[2] ?? ''));
        if (!bytes)
          return json(
            response,
            404,
            googleError(404, 'NOT_FOUND', 'notFound', 'Requested entity was not found.'),
          );
        return json(response, 200, { size: bytes.length, data: bytes.toString('base64url') });
      }
      const one = /^\/messages\/([^/]+)$/.exec(path)?.[1];
      if (one) {
        const message = box.messages.get(decodeURIComponent(one));
        if (!message)
          return json(
            response,
            404,
            googleError(404, 'NOT_FOUND', 'notFound', 'Requested entity was not found.'),
          );
        return json(response, 200, message.json);
      }
      return json(response, 404, googleError(404, 'NOT_FOUND', 'notFound', 'Not found.'));
    },
  };
  return fake;
}
