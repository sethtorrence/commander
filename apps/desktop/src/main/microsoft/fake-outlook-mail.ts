import type { IncomingMessage, ServerResponse } from 'node:http';

// The Outlook mail part of the fake Microsoft Graph (fake-microsoft-server.ts), for tests only (#136):
// each user's mailbox, answering what Commander's Outlook mail sync asks the way Graph does: the
// mailbox's folders (`/me/mailFolders`, child folders, and Outlook's own by their well-known names),
// a folder's messages counted (`$count`), and its delta (`/me/mailFolders/{id}/messages/delta`): a
// first round filtered on `receivedDateTime ge`, newest first, paged by `Prefer: odata.maxpagesize`,
// ending in a delta link that later returns only what changed (messages moved out or deleted as
// `@removed`), and 410 SyncStateNotFound once delta links expire; messages under immutable ids that
// keep their id when moved, with their internet headers (none on the User's own sent mail), HTML or
// text bodies and attachments (metadata, and bytes through `$value`); JSON batches (`/$batch`) of
// those reads; and what organising mail writes: `PATCH /me/messages/{id}` (isRead, flag) and
// `POST /me/messages/{id}/move` (to a folder id or a well-known name). Writing email (#138): drafts
// made with `POST /me/messages` or `createReply` / `createReplyAll` / `createForward` (in Drafts, with
// the reply's thread and headers), PATCHed with their fields and Commander's extended property,
// attachments added in the request or through an upload session (PUT in chunks), sent with `send`
// (filed in Sent Items under an id of its own, as Exchange does), deleted, and found again by the
// extended property in one of Outlook's own folders. Mirror Buckets (#142): a message's `categories`
// in the same PATCH, and the mailbox's master list of categories (`/me/outlook/masterCategories`:
// list, make, delete), refused with 403 while the sign-in lacks MailboxSettings.ReadWrite. Nothing here talks to the real Microsoft.

export type FakeMailUser = { id: string; displayName: string; userPrincipalName: string };

export type FakeOutlookAddress = { name: string; address: string };

export type FakeOutlookMessageInput = {
  id?: string;
  // A folder id, or one of Outlook's own by its well-known name ('inbox' unless given).
  folder?: string;
  from: FakeOutlookAddress;
  to: FakeOutlookAddress[];
  cc?: FakeOutlookAddress[];
  bcc?: FakeOutlookAddress[];
  subject: string;
  text?: string;
  html?: string;
  // Epoch milliseconds.
  date: number;
  isRead?: boolean;
  flagged?: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  conversationId?: string;
  categories?: string[];
  // Outlook leaves internet headers off the User's own sent mail.
  withoutHeaders?: boolean;
  attachments?: {
    name: string;
    type: string;
    content: Buffer | string;
    contentId?: string;
    inline?: boolean;
  }[];
};

type Attachment = {
  id: string;
  name: string;
  type: string;
  bytes: Buffer;
  contentId: string | null;
  inline: boolean;
};

type StoredMessage = {
  id: string;
  folderId: string;
  input: FakeOutlookMessageInput;
  isRead: boolean;
  flagged: boolean;
  modifiedAt: number;
  // The change that last touched it.
  version: number;
  attachments: Attachment[];
  // A draft (#138), and its extended properties (Commander's mark).
  isDraft: boolean;
  properties: Map<string, string>;
  categories: string[];
};

type MasterCategory = { id: string; displayName: string; color: string };

type Folder = { id: string; displayName: string; parentFolderId: string; wellKnown: string | null };

type Mailbox = {
  folders: Folder[];
  // The master list of categories (#142).
  categories: MasterCategory[];
  messages: Map<string, StoredMessage>;
  // Per folder, the messages that left it (moved out or deleted), with the change that took them.
  left: Map<string, Map<string, number>>;
};

export type FakeOutlookMail = {
  // Every mail request, as its method, path and query (decoded).
  requests: string[];
  // Every write Commander sent (PATCH and move), its path and JSON body.
  writes: { method: string; path: string; body: unknown }[];
  // A user's folders, Outlook's own and theirs.
  folders(userId: string): Folder[];
  // Makes a folder of the User's own (under `parent`, a folder id, or at the top). Returns its id.
  addFolder(userId: string, displayName: string, parent?: string): string;
  // Puts a message in a folder (the Inbox unless given). Returns its id.
  deliver(userId: string, message: FakeOutlookMessageInput): string;
  // As the User would in Outlook: moves a message, marks it read or flags it, or deletes it for good.
  move(userId: string, id: string, folder: string): void;
  update(userId: string, id: string, change: { isRead?: boolean; flagged?: boolean }): void;
  remove(userId: string, id: string): void;
  // Where a message is now and how it stands (null: no such message).
  messageOf(userId: string, id: string): { folder: string; isRead: boolean; flagged: boolean } | null;
  // Writes are refused (403 ErrorAccessDenied) until switched back.
  refuseWrites(refusing: boolean): void;
  // A message's categories as Outlook has them (null: no such message).
  categoriesOf(userId: string, id: string): string[] | null;
  // As the User would in Outlook: sets a message's categories.
  setCategories(userId: string, id: string, categories: string[]): void;
  // The mailbox's master list of categories.
  masterCategories(userId: string): MasterCategory[];
  // The master list answers 403 (as without MailboxSettings.ReadWrite) until switched back.
  refuseCategories(refusing: boolean): void;
  // Every delta link handed out so far stops working (410 SyncStateNotFound).
  expireDeltaLinks(): void;
  // Every message sent (#138), oldest first: the copy filed in Sent Items.
  sent: {
    id: string;
    subject: string;
    to: string[];
    attachments: { name: string; size: number }[];
    inReplyTo: string | null;
    conversationId: string;
  }[];
  // Sends are refused (400 ErrorInvalidRecipients, with this reason) until null again.
  refuseSends(reason: string | null): void;
  // A user's drafts in Drafts.
  drafts(userId: string): { id: string; subject: string }[];
  // An upload session's PUT (no token: the URL carries its own authorisation, as Graph's do).
  handlesUpload(request: IncomingMessage, url: URL): boolean;
  upload(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void>;
  // Whether a request is the mail part's to answer.
  handles(request: IncomingMessage, url: URL): boolean;
  handle(request: IncomingMessage, url: URL, response: ServerResponse, user: FakeMailUser): Promise<void>;
};

const WELL_KNOWN: [string, string][] = [
  ['inbox', 'Inbox'],
  ['archive', 'Archive'],
  ['sentitems', 'Sent Items'],
  ['deleteditems', 'Deleted Items'],
  ['junkemail', 'Junk Email'],
  ['drafts', 'Drafts'],
  ['outbox', 'Outbox'],
];
const ROOT = 'AAMkFake-fld-msgfolderroot=';
const folderId = (name: string) => `AAMkFake-fld-${name}=`;
const DEFAULT_PAGE = 10;

type Answer = { status: number; body?: unknown; bytes?: Buffer; type?: string };
const notFound = (code = 'ErrorItemNotFound'): Answer => ({
  status: 404,
  body: { error: { code, message: 'The specified object was not found in the store.' } },
});

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
const recipient = (address: FakeOutlookAddress) => ({ emailAddress: address });
const preview = (message: FakeOutlookMessageInput) =>
  (message.text ?? (message.html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 255);

export function createFakeOutlookMail(graphUrl: () => string): FakeOutlookMail {
  const mailboxes = new Map<string, Mailbox>();
  let version = 0;
  let generation = 0;
  let made = 0;
  let refusing = false;
  let refusingCategories = false;
  // Pages of a first round still to hand out, and delta links handed out.
  const pages = new Map<string, { folderId: string; rest: StoredMessage[]; upTo: number; from: number }>();
  const deltas = new Map<string, { folderId: string; since: number; from: number; generation: number }>();

  const mailboxOf = (userId: string): Mailbox => {
    let found = mailboxes.get(userId);
    if (!found) {
      found = {
        folders: WELL_KNOWN.map(([name, displayName]) => ({
          id: folderId(name),
          displayName,
          parentFolderId: ROOT,
          wellKnown: name,
        })),
        categories: [],
        messages: new Map(),
        left: new Map(),
      };
      mailboxes.set(userId, found);
    }
    return found;
  };
  const resolve = (mailbox: Mailbox, folder: string) =>
    mailbox.folders.find((each) => each.id === folder || each.wellKnown === folder.toLowerCase()) ?? null;

  function moveTo(mailbox: Mailbox, message: StoredMessage, folder: Folder) {
    if (message.folderId === folder.id) return;
    version += 1;
    const left = mailbox.left.get(message.folderId) ?? new Map<string, number>();
    left.set(message.id, version);
    mailbox.left.set(message.folderId, left);
    mailbox.left.get(folder.id)?.delete(message.id);
    message.folderId = folder.id;
    message.version = version;
    message.modifiedAt = Date.now();
  }

  function messageJson(message: StoredMessage) {
    const { input } = message;
    const headers = [
      ['From', `${input.from.name} <${input.from.address}>`],
      ['To', input.to.map((each) => `${each.name} <${each.address}>`).join(', ')],
      ['Subject', input.subject],
      ...(input.messageId ? [['Message-ID', input.messageId]] : []),
      ...(input.inReplyTo ? [['In-Reply-To', input.inReplyTo]] : []),
      ...(input.references ? [['References', input.references]] : []),
    ].map(([name, value]) => ({ name, value }));
    return {
      id: message.id,
      receivedDateTime: iso(input.date),
      sentDateTime: iso(input.date),
      subject: input.subject,
      bodyPreview: preview(input),
      body:
        input.html !== undefined
          ? { contentType: 'html', content: input.html }
          : { contentType: 'text', content: input.text ?? '' },
      from: recipient(input.from),
      sender: recipient(input.from),
      toRecipients: input.to.map(recipient),
      ccRecipients: (input.cc ?? []).map(recipient),
      bccRecipients: (input.bcc ?? []).map(recipient),
      replyTo: [],
      isRead: message.isRead,
      isDraft: message.isDraft,
      flag: { flagStatus: message.flagged ? 'flagged' : 'notFlagged' },
      parentFolderId: message.folderId,
      conversationId: input.conversationId ?? `AAQkFake-conv-${message.id}`,
      internetMessageId: input.messageId ?? `<${message.id}@fake.outlook.test>`,
      ...(input.withoutHeaders ? {} : { internetMessageHeaders: headers }),
      categories: [...message.categories],
      hasAttachments: message.attachments.some((each) => !each.inline),
      lastModifiedDateTime: iso(message.modifiedAt),
    };
  }

  const attachmentJson = (attachment: Attachment) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    id: attachment.id,
    name: attachment.name,
    contentType: attachment.type,
    size: attachment.bytes.length,
    isInline: attachment.inline,
    contentId: attachment.contentId,
  });

  const folderJson = (mailbox: Mailbox, folder: Folder) => ({
    id: folder.id,
    displayName: folder.displayName,
    parentFolderId: folder.parentFolderId,
    childFolderCount: mailbox.folders.filter((each) => each.parentFolderId === folder.id).length,
    totalItemCount: [...mailbox.messages.values()].filter((each) => each.folderId === folder.id).length,
  });

  const fromFilter = (query: URLSearchParams) => {
    const match = /receivedDateTime\s+ge\s+(\S+)/i.exec(query.get('$filter') ?? '');
    return match ? Date.parse(match[1] as string) : 0;
  };
  const pageSize = (prefer: string) => {
    const match = /odata\.maxpagesize=(\d+)/.exec(prefer);
    return match ? Math.max(1, Number(match[1])) : DEFAULT_PAGE;
  };

  // One page of a first round, or the changes since a delta link.
  function delta(mailbox: Mailbox, folder: Folder, query: URLSearchParams, prefer: string): Answer {
    const link = `${graphUrl()}/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta`;
    const size = pageSize(prefer);
    const finish = (upTo: number, from: number) => {
      const token = `delta-${++made}`;
      deltas.set(token, { folderId: folder.id, since: upTo, from, generation });
      return `${link}?$deltatoken=${token}`;
    };
    const skip = query.get('$skiptoken');
    const deltaToken = query.get('$deltatoken');
    let rest: StoredMessage[];
    let upTo: number;
    let from: number;
    if (skip) {
      const page = pages.get(skip);
      if (!page || page.folderId !== folder.id)
        return {
          status: 410,
          body: { error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' } },
        };
      pages.delete(skip);
      ({ rest, upTo, from } = page);
    } else if (deltaToken) {
      const mark = deltas.get(deltaToken);
      if (!mark || mark.folderId !== folder.id || mark.generation < generation)
        return {
          status: 410,
          body: { error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' } },
        };
      const changed = [...mailbox.messages.values()].filter(
        (each) => each.folderId === folder.id && each.version > mark.since && each.input.date >= mark.from,
      );
      const removed = [...(mailbox.left.get(folder.id) ?? new Map<string, number>()).entries()]
        .filter(([id, at]) => at > mark.since && mailbox.messages.get(id)?.folderId !== folder.id)
        .map(([id]) => ({
          '@odata.type': '#microsoft.graph.message',
          id,
          '@removed': { reason: 'deleted' },
        }));
      return {
        status: 200,
        body: {
          value: [...changed.map(messageJson), ...removed],
          '@odata.deltaLink': finish(version, mark.from),
        },
      };
    } else {
      from = fromFilter(query);
      upTo = version;
      rest = [...mailbox.messages.values()]
        .filter((each) => each.folderId === folder.id && each.input.date >= from)
        .sort((a, b) => b.input.date - a.input.date);
    }
    const page = rest.slice(0, size);
    const after = rest.slice(size);
    if (after.length) {
      const token = `page-${++made}`;
      pages.set(token, { folderId: folder.id, rest: after, upTo, from });
      return {
        status: 200,
        body: { value: page.map(messageJson), '@odata.nextLink': `${link}?$skiptoken=${token}` },
      };
    }
    return { status: 200, body: { value: page.map(messageJson), '@odata.deltaLink': finish(upTo, from) } };
  }

  // ---------------------------------------------------------------------------------------------
  // Writing email (#138)

  let sendsRefused: string | null = null;
  const sessions = new Map<
    string,
    {
      userId: string;
      messageId: string;
      name: string;
      type: string;
      size: number;
      chunks: Buffer[];
      received: number;
    }
  >();

  // The extended property a `$filter` asks for: `singleValueExtendedProperties/Any(ep: ep/id eq '…' and ep/value eq '…')`.
  function marker(query: URLSearchParams): { id: string; value: string } | null {
    const match = /ep\/id eq '([^']+)' and ep\/value eq '([^']+)'/.exec(query.get('$filter') ?? '');
    return match ? { id: match[1] as string, value: match[2] as string } : null;
  }

  const addressesOf = (list: unknown): FakeOutlookAddress[] =>
    Array.isArray(list)
      ? list.flatMap((each) => {
          const address = (each as { emailAddress?: { address?: string; name?: string } }).emailAddress;
          return address?.address
            ? [{ name: address.name ?? address.address, address: address.address }]
            : [];
        })
      : [];

  function newDraft(
    mailbox: Mailbox,
    user: FakeMailUser,
    input: Partial<FakeOutlookMessageInput>,
  ): StoredMessage {
    const drafts = resolve(mailbox, 'drafts') as Folder;
    const id = `AAMkFake-msg-draft-${++made}=`;
    const draft: StoredMessage = {
      id,
      folderId: drafts.id,
      input: {
        from: { name: user.displayName, address: user.userPrincipalName },
        to: [],
        subject: '',
        date: Date.now(),
        messageId: `<draft-${made}@fake.outlook.test>`,
        withoutHeaders: true,
        ...input,
      },
      isRead: true,
      flagged: false,
      modifiedAt: Date.now(),
      version: ++version,
      attachments: [],
      categories: [],
      isDraft: true,
      properties: new Map(),
    };
    mailbox.messages.set(id, draft);
    return draft;
  }

  // A PATCH (or a create's body) on a draft: its subject, body, recipients and extended properties.
  function applyDraft(draft: StoredMessage, payload: unknown) {
    const change = (payload ?? {}) as {
      subject?: unknown;
      body?: { contentType?: string; content?: string };
      toRecipients?: unknown;
      ccRecipients?: unknown;
      bccRecipients?: unknown;
      singleValueExtendedProperties?: { id: string; value: string }[];
    };
    const input = { ...draft.input };
    if (typeof change.subject === 'string') input.subject = change.subject;
    if (change.body) {
      if (change.body.contentType === 'html') {
        input.html = change.body.content ?? '';
        input.text = undefined;
      } else input.text = change.body.content ?? '';
    }
    if (change.toRecipients) input.to = addressesOf(change.toRecipients);
    if (change.ccRecipients) input.cc = addressesOf(change.ccRecipients);
    if (change.bccRecipients) input.bcc = addressesOf(change.bccRecipients);
    for (const property of change.singleValueExtendedProperties ?? [])
      draft.properties.set(property.id, property.value);
    draft.input = input;
    draft.version = ++version;
    draft.modifiedAt = Date.now();
  }

  function addAttachment(message: StoredMessage, name: string, type: string, bytes: Buffer) {
    message.attachments.push({
      id: `${message.id.replace(/=$/, '')}-att-${message.attachments.length + 1}-${++made}=`,
      name,
      type,
      bytes,
      contentId: null,
      inline: false,
    });
    message.version = ++version;
  }

  function composeAnswer(
    mailbox: Mailbox,
    message: StoredMessage,
    method: string,
    parts: string[],
    payload: unknown,
    user: FakeMailUser,
  ): Answer | null {
    const action = parts[3];
    if (
      method === 'POST' &&
      (action === 'createReply' || action === 'createReplyAll' || action === 'createForward')
    ) {
      const original = message.input;
      const prefix = action === 'createForward' ? 'FW: ' : 'RE: ';
      const to =
        action === 'createForward'
          ? []
          : action === 'createReplyAll'
            ? [original.from, ...original.to.filter((each) => each.address !== user.userPrincipalName)]
            : [original.from];
      const draft = newDraft(mailbox, user, {
        subject: `${prefix}${original.subject.replace(/^(re|fw|fwd):\s*/i, '')}`,
        to,
        html: `<div><br></div><hr><div>${original.html ?? original.text ?? ''}</div>`,
        conversationId: original.conversationId ?? `AAQkFake-conv-${message.id}`,
        ...(action === 'createForward'
          ? {}
          : {
              inReplyTo: original.messageId ?? `<${message.id}@fake.outlook.test>`,
              references: [original.references, original.messageId ?? `<${message.id}@fake.outlook.test>`]
                .filter(Boolean)
                .join(' '),
            }),
      });
      // Outlook copies a forwarded message's attachments into the forward.
      if (action === 'createForward')
        for (const each of message.attachments.filter((one) => !one.inline))
          addAttachment(draft, each.name, each.type, each.bytes);
      return { status: 201, body: messageJson(draft) };
    }
    if (!message.isDraft) return null;
    if (parts.length === 3 && method === 'PATCH') {
      applyDraft(message, payload);
      return { status: 200, body: messageJson(message) };
    }
    if (parts.length === 3 && method === 'DELETE') {
      mailbox.messages.delete(message.id);
      const left = mailbox.left.get(message.folderId) ?? new Map<string, number>();
      left.set(message.id, ++version);
      mailbox.left.set(message.folderId, left);
      return { status: 204 };
    }
    if (action === 'attachments' && method === 'POST' && parts.length === 4) {
      const file = (payload ?? {}) as { name?: string; contentType?: string; contentBytes?: string };
      addAttachment(
        message,
        file.name ?? 'attachment',
        file.contentType ?? 'application/octet-stream',
        Buffer.from(file.contentBytes ?? '', 'base64'),
      );
      return { status: 201, body: { id: message.attachments.at(-1)?.id } };
    }
    if (action === 'attachments' && method === 'DELETE' && parts[4]) {
      message.attachments = message.attachments.filter((each) => each.id !== parts[4]);
      return { status: 204 };
    }
    if (action === 'attachments' && parts[4] === 'createUploadSession' && method === 'POST') {
      const item =
        ((payload ?? {}) as { AttachmentItem?: { name?: string; size?: number; contentType?: string } })
          .AttachmentItem ?? {};
      const token = `session-${++made}`;
      sessions.set(token, {
        userId: user.id,
        messageId: message.id,
        name: item.name ?? 'attachment',
        type: item.contentType ?? 'application/octet-stream',
        size: item.size ?? 0,
        chunks: [],
        received: 0,
      });
      const origin = graphUrl().replace(/\/v1\.0$/, '');
      return {
        status: 201,
        body: { uploadUrl: `${origin}/fake-upload/${token}?authtoken=fake`, nextExpectedRanges: ['0-'] },
      };
    }
    if (action === 'send' && method === 'POST') {
      if (sendsRefused)
        return { status: 400, body: { error: { code: 'ErrorInvalidRecipients', message: sendsRefused } } };
      const sentItems = resolve(mailbox, 'sentitems') as Folder;
      // Exchange files the sent message in Sent Items under an id of its own.
      const id = `AAMkFake-msg-sent-${++made}=`;
      const copy: StoredMessage = {
        ...message,
        id,
        folderId: sentItems.id,
        isDraft: false,
        input: { ...message.input, date: Date.now() },
        version: ++version,
        modifiedAt: Date.now(),
        properties: new Map(message.properties),
      };
      mailbox.messages.delete(message.id);
      const left = mailbox.left.get(message.folderId) ?? new Map<string, number>();
      left.set(message.id, version);
      mailbox.left.set(message.folderId, left);
      mailbox.messages.set(id, copy);
      fake.sent.push({
        id,
        subject: copy.input.subject,
        to: copy.input.to.map((each) => each.address),
        attachments: copy.attachments.map((each) => ({ name: each.name, size: each.bytes.length })),
        inReplyTo: copy.input.inReplyTo ?? null,
        conversationId: copy.input.conversationId ?? `AAQkFake-conv-${message.id}`,
      });
      return { status: 202 };
    }
    return null;
  }

  // The master list of categories (#142): list, make (409 for a name taken), delete.
  function masterCategories(mailbox: Mailbox, method: string, parts: string[], payload: unknown): Answer {
    if (refusingCategories)
      return {
        status: 403,
        body: {
          error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' },
        },
      };
    if (parts.length === 3 && method === 'GET') return { status: 200, body: { value: mailbox.categories } };
    if (parts.length === 3 && method === 'POST') {
      const { displayName, color } = (payload ?? {}) as { displayName?: unknown; color?: unknown };
      if (typeof displayName !== 'string' || !displayName.trim())
        return { status: 400, body: { error: { code: 'ErrorInvalidRequest', message: 'No name' } } };
      if (mailbox.categories.some((each) => each.displayName === displayName))
        return { status: 409, body: { error: { code: 'ErrorAlreadyExists', message: 'Exists' } } };
      made += 1;
      const category = {
        id: `fake-cat-${made}`,
        displayName,
        color: typeof color === 'string' ? color : 'none',
      };
      mailbox.categories.push(category);
      return { status: 201, body: category };
    }
    if (parts.length === 4 && method === 'DELETE') {
      const found = mailbox.categories.some((each) => each.id === parts[3]);
      if (!found) return notFound();
      mailbox.categories = mailbox.categories.filter((each) => each.id !== parts[3]);
      return { status: 204 };
    }
    return notFound('ResourceNotFound');
  }

  // Answers one read or write, for the user.
  function answer(method: string, url: URL, payload: unknown, prefer: string, user: FakeMailUser): Answer {
    const mailbox = mailboxOf(user.id);
    const path = url.pathname.replace(/^\/v1\.0/, '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (path === '/me' && method === 'GET')
      return { status: 200, body: { ...user, mail: user.userPrincipalName } };
    if (parts[0] !== 'me') return notFound('ResourceNotFound');
    if (parts[1] === 'outlook' && parts[2] === 'masterCategories')
      return masterCategories(mailbox, method, parts, payload);
    if (parts[1] === 'mailFolders' && method === 'GET') {
      if (parts.length === 2)
        return {
          status: 200,
          body: {
            value: mailbox.folders
              .filter((each) => each.parentFolderId === ROOT)
              .map((each) => folderJson(mailbox, each)),
          },
        };
      const folder = resolve(mailbox, parts[2] as string);
      if (!folder) return notFound('ErrorFolderNotFound');
      if (parts.length === 3) return { status: 200, body: folderJson(mailbox, folder) };
      if (parts[3] === 'childFolders')
        return {
          status: 200,
          body: {
            value: mailbox.folders
              .filter((each) => each.parentFolderId === folder.id)
              .map((each) => folderJson(mailbox, each)),
          },
        };
      if (parts[3] === 'messages' && parts[4] === 'delta')
        return delta(mailbox, folder, url.searchParams, prefer);
      if (parts[3] === 'messages' && parts.length === 4 && marker(url.searchParams)) {
        // Writing email (#138): the messages carrying Commander's mark, in one of Outlook's own folders.
        const { id: property, value } = marker(url.searchParams) as { id: string; value: string };
        const marked = [...mailbox.messages.values()].filter(
          (each) => each.folderId === folder.id && each.properties.get(property) === value,
        );
        return { status: 200, body: { value: marked.map(messageJson) } };
      }
      if (parts[3] === 'messages' && parts.length === 4) {
        const from = fromFilter(url.searchParams);
        const inFolder = [...mailbox.messages.values()].filter(
          (each) => each.folderId === folder.id && each.input.date >= from,
        );
        return {
          status: 200,
          body: {
            '@odata.count': inFolder.length,
            value: inFolder.slice(0, 1).map((each) => ({ id: each.id })),
          },
        };
      }
      return notFound('ResourceNotFound');
    }
    if (parts[1] === 'messages' && parts.length === 2 && method === 'POST') {
      // A new message's draft (#138).
      const draft = newDraft(mailbox, user, { subject: '', to: [] });
      applyDraft(draft, payload);
      return { status: 201, body: messageJson(draft) };
    }
    if (parts[1] !== 'messages' || !parts[2]) return notFound('ResourceNotFound');
    const message = mailbox.messages.get(parts[2]);
    if (!message) return notFound();
    const composing = composeAnswer(mailbox, message, method, parts, payload, user);
    if (composing) return composing;
    if (method !== 'GET' && refusing)
      return {
        status: 403,
        body: {
          error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' },
        },
      };
    if (parts.length === 3 && method === 'GET') return { status: 200, body: messageJson(message) };
    if (parts.length === 3 && method === 'PATCH') {
      const change = (payload ?? {}) as {
        isRead?: unknown;
        flag?: { flagStatus?: unknown };
        categories?: unknown;
      };
      if (typeof change.isRead === 'boolean') message.isRead = change.isRead;
      if (change.flag) message.flagged = change.flag.flagStatus === 'flagged';
      if (Array.isArray(change.categories)) message.categories = change.categories.map(String);
      message.version = ++version;
      message.modifiedAt = Date.now();
      return { status: 200, body: messageJson(message) };
    }
    if (parts[3] === 'move' && method === 'POST') {
      const destination = (payload as { destinationId?: unknown } | undefined)?.destinationId;
      const folder = typeof destination === 'string' ? resolve(mailbox, destination) : null;
      if (!folder) return notFound('ErrorFolderNotFound');
      moveTo(mailbox, message, folder);
      return { status: 201, body: messageJson(message) };
    }
    if (parts[3] === 'attachments' && method === 'GET') {
      if (parts.length === 4)
        return { status: 200, body: { value: message.attachments.map(attachmentJson) } };
      const attachment = message.attachments.find((each) => each.id === parts[4]);
      if (!attachment) return notFound();
      if (parts[5] === '$value') return { status: 200, bytes: attachment.bytes, type: attachment.type };
      return { status: 200, body: attachmentJson(attachment) };
    }
    return notFound('ResourceNotFound');
  }

  const fake: FakeOutlookMail = {
    requests: [],
    writes: [],
    sent: [],
    refuseSends(reason) {
      sendsRefused = reason;
    },
    drafts(userId) {
      const mailbox = mailboxOf(userId);
      const drafts = resolve(mailbox, 'drafts') as Folder;
      return [...mailbox.messages.values()]
        .filter((each) => each.folderId === drafts.id)
        .map((each) => ({ id: each.id, subject: each.input.subject }));
    },
    handlesUpload(request, url) {
      return request.method === 'PUT' && url.pathname.startsWith('/fake-upload/');
    },
    async upload(request, url, response) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      const session = sessions.get(url.pathname.slice('/fake-upload/'.length));
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(String(request.headers['content-range'] ?? ''));
      fake.requests.push(`PUT ${url.pathname} ${request.headers['content-range'] ?? ''}`);
      if (!session || !range || Number(range[1]) !== session.received) {
        response
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { code: 'InvalidRange' } }));
        return;
      }
      session.chunks.push(bytes);
      session.received += bytes.length;
      if (session.received < session.size) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ nextExpectedRanges: [`${session.received}-`] }));
        return;
      }
      const message = mailboxOf(session.userId).messages.get(session.messageId);
      if (message) addAttachment(message, session.name, session.type, Buffer.concat(session.chunks));
      sessions.delete(url.pathname.slice('/fake-upload/'.length));
      response.writeHead(201).end();
    },
    folders: (userId) => mailboxOf(userId).folders.map((each) => ({ ...each })),
    addFolder(userId, displayName, parent = ROOT) {
      const id = `AAMkFake-fld-own-${++made}=`;
      mailboxOf(userId).folders.push({ id, displayName, parentFolderId: parent, wellKnown: null });
      return id;
    },
    deliver(userId, input) {
      const mailbox = mailboxOf(userId);
      const folder = resolve(mailbox, input.folder ?? 'inbox');
      if (!folder) throw new Error(`No fake folder ${input.folder}`);
      const id = input.id ?? `AAMkFake-msg-${++made}=`;
      mailbox.messages.set(id, {
        id,
        folderId: folder.id,
        input,
        isRead: input.isRead ?? false,
        flagged: input.flagged ?? false,
        modifiedAt: input.date,
        version: ++version,
        isDraft: false,
        properties: new Map(),
        categories: [...(input.categories ?? [])],
        attachments: (input.attachments ?? []).map((each, index) => ({
          id: `${id.replace(/=$/, '')}-att-${index + 1}=`,
          name: each.name,
          type: each.type,
          bytes: Buffer.isBuffer(each.content) ? each.content : Buffer.from(each.content),
          contentId: each.contentId ?? null,
          inline: each.inline ?? !!each.contentId,
        })),
      });
      mailbox.left.get(folder.id)?.delete(id);
      return id;
    },
    move(userId, id, folder) {
      const mailbox = mailboxOf(userId);
      const message = mailbox.messages.get(id);
      const target = resolve(mailbox, folder);
      if (!message || !target) throw new Error(`No fake message ${id} or folder ${folder}`);
      moveTo(mailbox, message, target);
    },
    update(userId, id, change) {
      const message = mailboxOf(userId).messages.get(id);
      if (!message) throw new Error(`No fake message ${id}`);
      if (change.isRead !== undefined) message.isRead = change.isRead;
      if (change.flagged !== undefined) message.flagged = change.flagged;
      message.version = ++version;
      message.modifiedAt = Date.now();
    },
    remove(userId, id) {
      const mailbox = mailboxOf(userId);
      const message = mailbox.messages.get(id);
      if (!message) return;
      mailbox.messages.delete(id);
      const left = mailbox.left.get(message.folderId) ?? new Map<string, number>();
      left.set(id, ++version);
      mailbox.left.set(message.folderId, left);
    },
    messageOf(userId, id) {
      const mailbox = mailboxOf(userId);
      const message = mailbox.messages.get(id);
      if (!message) return null;
      const folder = mailbox.folders.find((each) => each.id === message.folderId);
      return {
        folder: folder?.wellKnown ?? folder?.displayName ?? message.folderId,
        isRead: message.isRead,
        flagged: message.flagged,
      };
    },
    refuseWrites(next) {
      refusing = next;
    },
    categoriesOf(userId, id) {
      const message = mailboxOf(userId).messages.get(id);
      return message ? [...message.categories] : null;
    },
    setCategories(userId, id, categories) {
      const message = mailboxOf(userId).messages.get(id);
      if (!message) throw new Error(`No fake message ${id}`);
      message.categories = [...categories];
      message.version = ++version;
      message.modifiedAt = Date.now();
    },
    masterCategories: (userId) => mailboxOf(userId).categories.map((each) => ({ ...each })),
    refuseCategories(next) {
      refusingCategories = next;
    },
    expireDeltaLinks() {
      generation += 1;
      pages.clear();
    },
    handles(request, url) {
      const path = url.pathname;
      if (path === '/v1.0/$batch') return request.method === 'POST';
      return (
        path.startsWith('/v1.0/me/mailFolders') ||
        path.startsWith('/v1.0/me/messages') ||
        path.startsWith('/v1.0/me/outlook/masterCategories')
      );
    },
    async handle(request, url, response, user) {
      const method = request.method ?? 'GET';
      const prefer = String(request.headers.prefer ?? '');
      const payload = method === 'GET' ? undefined : await bodyOf(request);
      fake.requests.push(`${method} ${decodeURIComponent(url.pathname + url.search)}`);
      let result: Answer;
      if (url.pathname === '/v1.0/$batch') {
        const requests = (
          (payload as { requests?: { id: string; method: string; url: string }[] })?.requests ?? []
        ).slice(0, 20);
        const responses = requests.map((each) => {
          const inner = new URL(`/v1.0${each.url}`, 'http://localhost');
          fake.requests.push(`${each.method} ${decodeURIComponent(inner.pathname + inner.search)}`);
          const answered = answer(each.method, inner, undefined, prefer, user);
          return {
            id: each.id,
            status: answered.status,
            headers: { 'content-type': 'application/json' },
            body: answered.body ?? null,
          };
        });
        result = { status: 200, body: { responses } };
      } else {
        if (method !== 'GET')
          fake.writes.push({
            method,
            path: decodeURIComponent(url.pathname.replace(/^\/v1\.0/, '')),
            body: payload,
          });
        result = answer(method, url, payload, prefer, user);
      }
      if (result.bytes) {
        response
          .writeHead(result.status, { 'content-type': result.type ?? 'application/octet-stream' })
          .end(result.bytes);
        return;
      }
      response
        .writeHead(result.status, { 'content-type': 'application/json' })
        .end(JSON.stringify(result.body ?? null));
    },
  };
  return fake;
}
