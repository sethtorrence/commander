import {
  BUCKET_MIRROR_FIELD,
  bucketOfCategory,
  type EmailAttachment,
  type EmailDetail,
  type EmailFolder,
  emailStatus,
  isSystemFolder,
  type MirroredBuckets,
  mirrorColourOf,
  mirroredValue,
  mirrorLabelName,
  namesOf,
  normaliseContentId,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import { isComposeWrite } from '../email-send/compose-write';
import {
  type Cadence,
  CursorExpired,
  type FetchedPart,
  type FieldChange,
  type MirrorRequest,
  type MirrorResult,
  PartNotFound,
  type PartRequest,
  PartTooLarge,
  type SourceAdapter,
  SourceUnavailable,
  type StoredItem,
  type Superseded,
  type SyncRequest,
  WriteRejected,
  type WriteRequest,
} from '../source';
import { writeOutlookCompose } from './compose';
import { connectGraphMail, GraphBadRequest, type GraphMail, GraphNotFound } from './graph';
import { mailboxGate } from './mailbox-gate';
import {
  attachmentOf,
  filedIn,
  folderOf,
  invitationOfEventMessage,
  isEventMessage,
  type MessageContext,
  readOutlookMessage,
  showsInlineParts,
} from './message';
import {
  attachmentsPage,
  countAnswer,
  type DeltaPage,
  deltaPage,
  type GraphMailFolder,
  type GraphMessage,
  graphAttachment,
  graphEventMessage,
  type MessageState,
  mailFoldersPage,
  meAnswer,
  messageState,
} from './shapes';

// Outlook mail as a Source (#136): the User's mail in an Outlook Account through Microsoft Graph v1.0,
// REST over fetch, one `email` Item per message in the detail Gmail's mail shares (decisions #3, #8,
// #15, #20). Change notifications need a public endpoint, so Commander polls, every 15 minutes by
// default (5 to 60), with delta queries per folder:
//
// - Every sync lists the mailbox's folders (`/me/mailFolders`, and each one's child folders) into the
//   Source's catalog, for Move to folder and the view list. Which folder is Outlook's own Inbox,
//   Archive, Sent Items, Deleted Items… is asked once (a JSON batch of `/me/mailFolders/{name}`, with
//   who the mailbox is) and kept in the cursor.
// - Every folder is synced except Junk Email, Drafts, Outbox, Conversation History, Sync Issues and
//   Deleted Items (and their child folders), each with its own delta link in the cursor
//   (`/me/mailFolders/{id}/messages/delta`), asking for immutable ids so a message moved between
//   folders keeps its Item, and selecting `internetMessageHeaders` for threading.
// - First sync: the 30 days before the Account was connected (`receivedDateTime ge` on each folder's
//   first round, newest first), the Inbox first, saved page by page and checkpointed, so a first sync
//   stopped by a restart or a rate limit resumes from the page it reached. How many messages there are
//   to download is counted first (a batch of `$count`s), for "Downloading 30 days: 120 of ~800".
// - Moves: a message leaving a folder comes as `@removed` there and as a message in the folder it went
//   to. Removals are judged once every folder has been read: a message seen in another folder moved;
//   one gone from every synced folder (deleted, or moved to Junk) becomes a tombstone.
// - Trash: Deleted Items isn't downloaded, but its delta is read for the messages Commander holds: one
//   moved there is marked as in Trash (keeping the folder it came from, so restoring it puts it back)
//   until Outlook deletes it for good.
// - An expired or invalid delta link (410, SyncStateNotFound, resyncRequired) re-syncs that folder's
//   window: its messages are read again, and held ones filed there that it no longer lists are
//   tombstoned. 429s, and 503s with Retry-After, raise RateLimited. Requests stay under 4 at a time per
//   mailbox, shared with the Account's calendar (mailbox-gate.ts).
// - Invitations (#144): an event message (a meeting request, answer or cancellation) is read once more,
//   in a JSON batch, with the event it is about (`$expand=microsoft.graph.eventMessage/event`), so its
//   card finds the event in the calendar: its meeting type, times, and the event's id and UID.
//
// Writes (#136, ADR 0003): the synced fields `read` (`isRead`), `starred` (the flag) as one PATCH, and
// where the message is filed, as one move (`POST /messages/{id}/move`): `trash` to Deleted Items and
// back to its folder; `folder` (Move to folder) to that folder; `inbox` to the Inbox, or to Archive
// when archived. The message is read first: what Outlook already has isn't sent, and a field Outlook
// changed since Commander last synced it, later than the User's change (its `lastModifiedDateTime`),
// is left as Outlook has it and reported as superseded: the newer change wins, per field.
//
// Mirror Buckets (#142): `bucket-mirror` keeps exactly one "Commander: <Bucket>" category on a message
// beside the User's own, in the same PATCH (its `categories`). An Account's category plan works on the
// mailbox's master list (`/me/outlook/masterCategories`, which needs MailboxSettings.ReadWrite): makes
// each Bucket's category with Outlook's preset colours (wrapping after 25), makes a renamed Bucket's anew
// and deletes the old one (categories can't be renamed), and deletes a removed Bucket's. Without the
// permission the categories still go on messages, without colours. Only "Commander: …" categories are
// ever made or deleted, and none of it runs unless the Item store queued it for a mirroring Account.
//
// Reading (#134): attachments and inline images through `/messages/{id}/attachments/{id}/$value`.
//
// Writing email (#138): messages written in Commander are saved as drafts and sent through the outgoing
// queue (compose.ts); the Drafts folder is read too, its messages kept as drafts.

export const OUTLOOK_CADENCE: Cadence = { defaultMinutes: 15, choices: [5, 10, 15, 30, 60] };

export type OutlookSourceOptions = {
  // Graph's base (https://graph.microsoft.com/v1.0); read per sync, so the end-to-end tests can point
  // it at a fake.
  graphUrl: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const DAY_MS = 24 * 60 * 60_000;
const WINDOW_DAYS = 30;

// Outlook's own folders Commander looks up by name.
export const WELL_KNOWN_FOLDERS = [
  'inbox',
  'archive',
  'sentitems',
  'deleteditems',
  'junkemail',
  'drafts',
  'outbox',
  'conversationhistory',
  'syncissues',
] as const;
// Their mail isn't downloaded, nor their child folders'. Deleted Items' delta is still read for the
// messages Commander holds.
const NOT_DOWNLOADED = new Set([
  'deleteditems',
  'junkemail',
  'drafts',
  'outbox',
  'conversationhistory',
  'syncissues',
]);
// The names a folder goes by when Commander can't list it.
const DEFAULT_NAMES: Record<string, string> = {
  inbox: 'Inbox',
  archive: 'Archive',
  deleteditems: 'Deleted Items',
};

const FOLDER_FIELDS = 'id,displayName,parentFolderId,childFolderCount';
const MESSAGE_FIELDS = [
  'id',
  'receivedDateTime',
  'sentDateTime',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'isRead',
  'isDraft',
  'flag',
  'parentFolderId',
  'conversationId',
  'internetMessageId',
  'internetMessageHeaders',
  'categories',
  'hasAttachments',
  'lastModifiedDateTime',
].join(',');
// Deleted Items: only what marks a held message as in Trash.
const TRASH_FIELDS = 'id,isRead,flag,parentFolderId,categories,lastModifiedDateTime,receivedDateTime';
const STATE_FIELDS = 'id,isRead,flag,parentFolderId,categories,lastModifiedDateTime';
const ATTACHMENT_FIELDS = 'id,name,contentType,size,isInline,contentId';
const BASE_ATTACHMENT_FIELDS = 'id,name,contentType,size,isInline';
const EVENT_MESSAGE_FIELDS = 'id,subject,meetingMessageType,startDateTime,endDateTime,isAllDay';

// Per folder: the link to read next (a page's nextLink while its first round is under way, then its
// delta link; null: start its first round), and whether its first round has finished.
const folderMark = z.object({ link: z.string().nullable(), ready: z.boolean() });
const outlookCursor = z.object({
  v: z.literal(1),
  // The 30-day window's start, kept for re-syncs.
  windowStart: z.number(),
  // The mailbox's own address.
  me: z.string().nullable(),
  // Outlook's own folders' ids, by well-known name.
  wellKnown: z.record(z.string(), z.string()),
  folders: z.record(z.string(), folderMark),
  // Messages that left a folder and haven't been seen elsewhere yet: id → the folder they left.
  removed: z.record(z.string(), z.string()),
  // While the first download is under way: how far it has got.
  backfill: z.object({ done: z.number(), total: z.number() }).optional(),
});
export type OutlookCursor = z.infer<typeof outlookCursor>;
type FolderMark = z.infer<typeof folderMark>;

// A folder Commander reads: its mail downloaded, (Deleted Items) only checked for held mail, or (Drafts,
// #138) its drafts downloaded as drafts.
type Planned = { id: string; role: 'mail' | 'trash' | 'drafts' };

// What Commander last learnt of an Account's mailbox, for writes between syncs.
type Mailbox = { wellKnown: Record<string, string>; folders: Map<string, EmailFolder>; me: string | null };

const iso = (time: number) => new Date(time).toISOString();
const emailOf = (item: StoredItem | undefined): EmailDetail | null =>
  item?.detail?.kind === 'email' ? item.detail : null;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function updatedItem(item: StoredItem, detail: EmailDetail): SourceItem {
  return {
    externalId: item.externalId,
    kind: 'email',
    title: item.title,
    people: item.people,
    status: emailStatus(detail),
    detail,
  };
}

const wellKnownName = (id: string, wellKnown: Record<string, string>) =>
  Object.entries(wellKnown).find(([, each]) => each === id)?.[0] ?? null;

// Who the mailbox is, and its own folders' ids, in one batch.
async function lookUpMailbox(
  api: GraphMail,
): Promise<{ wellKnown: Record<string, string>; me: string | null }> {
  const folderPath = (name: string) => `/me/mailFolders/${name}?$select=id`;
  const mePath = '/me?$select=mail,userPrincipalName';
  const answers = await api.batch([...WELL_KNOWN_FOLDERS.map(folderPath), mePath]);
  const wellKnown: Record<string, string> = {};
  for (const name of WELL_KNOWN_FOLDERS) {
    const found = z.object({ id: z.string().min(1) }).safeParse(answers.get(folderPath(name)));
    if (found.success) wellKnown[name] = found.data.id;
  }
  const me = meAnswer.safeParse(answers.get(mePath));
  const address = me.success ? (me.data.mail ?? me.data.userPrincipalName ?? null) : null;
  return { wellKnown, me: address?.trim() || null };
}

// Every folder of the mailbox, parents before their children.
async function listFolders(api: GraphMail): Promise<GraphMailFolder[]> {
  const all: GraphMailFolder[] = [];
  const readAll = async (first: string) => {
    const found: GraphMailFolder[] = [];
    for (let link: string | null = first; link; ) {
      const page: z.infer<typeof mailFoldersPage> = await api.get(link, mailFoldersPage);
      found.push(...page.value);
      link = page['@odata.nextLink'] ?? null;
    }
    return found;
  };
  const visit = async (folders: GraphMailFolder[]) => {
    for (const folder of folders) {
      all.push(folder);
      if ((folder.childFolderCount ?? 0) > 0) {
        try {
          await visit(
            await readAll(
              `/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$select=${FOLDER_FIELDS}&$top=100`,
            ),
          );
        } catch (error) {
          // Gone since it was listed.
          if (!(error instanceof GraphNotFound)) throw error;
        }
      }
    }
  };
  await visit(await readAll(`/me/mailFolders?$select=${FOLDER_FIELDS}&$top=100`));
  return all;
}

type ListedFolder = EmailFolder & { parentId: string | null; role: Planned['role'] | null };

// The folders by id, each named by its path ("Inbox / Receipts"), with what Commander reads of it.
function folderPlan(listed: GraphMailFolder[], wellKnown: Record<string, string>): Map<string, ListedFolder> {
  const byId = new Map(listed.map((folder) => [folder.id, folder]));
  const folders = new Map<string, ListedFolder>();
  const resolve = (folder: GraphMailFolder): ListedFolder => {
    const done = folders.get(folder.id);
    if (done) return done;
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
    const above = parent && parent.id !== folder.id ? resolve(parent) : null;
    const known = wellKnownName(folder.id, wellKnown);
    const own = folder.displayName?.trim() || (known ? DEFAULT_NAMES[known] : null) || 'Folder';
    let role: ListedFolder['role'];
    if (known === 'deleteditems') role = 'trash';
    else if (known === 'drafts') role = 'drafts';
    else if ((known && NOT_DOWNLOADED.has(known)) || (above && above.role !== 'mail')) role = null;
    else role = 'mail';
    const made: ListedFolder = {
      id: folder.id,
      name: above ? `${above.name} / ${own}` : own,
      wellKnown: known,
      parentId: above ? above.id : null,
      role,
    };
    folders.set(folder.id, made);
    return made;
  };
  for (const folder of listed) resolve(folder);
  return folders;
}

// The order folders are read in: the Inbox first, then Sent Items and Archive, the rest as listed, and
// Deleted Items last (so a message moved there from a folder read earlier is seen as trashed).
function readingOrder(folders: Map<string, ListedFolder>): Planned[] {
  const rank = (folder: ListedFolder) =>
    folder.role === 'drafts'
      ? 10
      : folder.role === 'trash'
        ? 9
        : folder.wellKnown === 'inbox'
          ? 0
          : folder.wellKnown === 'sentitems'
            ? 1
            : folder.wellKnown === 'archive'
              ? 2
              : 3;
  return [...folders.values()]
    .filter((folder) => folder.role !== null)
    .map((folder, index) => ({ folder, index }))
    .sort((a, b) => rank(a.folder) - rank(b.folder) || a.index - b.index)
    .map(({ folder }) => ({ id: folder.id, role: folder.role as Planned['role'] }));
}

const windowFilter = (windowStart: number) => encodeURIComponent(`receivedDateTime ge ${iso(windowStart)}`);

// A folder's first delta round. `plain`: without internet headers, should Graph refuse them in a delta
// (threading then falls back to conversationId for that folder).
const firstRound = (folder: Planned, windowStart: number, plain = false) => {
  // Every draft, however old: drafts are few, and finished whenever.
  if (folder.role === 'drafts') windowStart = 0;
  const fields =
    folder.role === 'trash'
      ? TRASH_FIELDS
      : plain
        ? MESSAGE_FIELDS.replace(',internetMessageHeaders', '')
        : MESSAGE_FIELDS;
  return `/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?$select=${fields}&$filter=${windowFilter(windowStart)}&$orderby=${encodeURIComponent('receivedDateTime desc')}`;
};

// A message's attachments: with their Content-IDs (a file attachment's own property), or, should Graph
// refuse that on the attachment collection, only what every attachment has.
const attachmentsPath = (id: string, fields = ATTACHMENT_FIELDS) =>
  `/me/messages/${encodeURIComponent(id)}/attachments?$select=${fields}`;

// An event message with the event it is about (#144): its meeting type and times, the event's id and UID.
const eventMessagePath = (id: string) =>
  `/me/messages/${encodeURIComponent(id)}?$select=${EVENT_MESSAGE_FIELDS}&$expand=microsoft.graph.eventMessage/event($select=id,iCalUId,subject)`;

export function createOutlookSource({
  graphUrl,
  fetch = globalThis.fetch,
  now = Date.now,
}: OutlookSourceOptions): SourceAdapter {
  // Per Account, what the last sync (or write) learnt of its mailbox.
  const mailboxes = new Map<string, Mailbox>();
  const connect = (request: Pick<SyncRequest, 'account' | 'accessToken' | 'signal'>) =>
    connectGraphMail({
      graphUrl: graphUrl(),
      fetch,
      now,
      gate: mailboxGate(request.account),
      accessToken: request.accessToken,
      signal: request.signal,
    });

  return {
    source: 'outlook',
    cadence: OUTLOOK_CADENCE,

    async sync(request: SyncRequest) {
      const api = connect(request);
      const cursor = await syncMailbox(api, request, now, (mailbox) =>
        mailboxes.set(request.account, mailbox),
      );
      request.progress?.(null);
      return { cursor, cost: api.cost };
    },

    async write(request: WriteRequest) {
      const api = connect(request);
      let mailbox = mailboxes.get(request.account);
      if (!mailbox?.wellKnown.inbox) {
        const found = await lookUpMailbox(api);
        mailbox = { ...found, folders: mailbox?.folders ?? new Map() };
        mailboxes.set(request.account, mailbox);
      }
      if (isComposeWrite(request.changes)) {
        // Outlook's own folders by their names, should no sync have listed them since Commander started.
        const folders = new Map(mailbox.folders);
        for (const [name, folderId] of Object.entries(mailbox.wellKnown))
          if (!folders.has(folderId))
            folders.set(folderId, { id: folderId, name: DEFAULT_NAMES[name] ?? name, wellKnown: name });
        const context = {
          folders,
          inbox: mailbox.wellKnown.inbox ?? null,
          sent: mailbox.wellKnown.sentitems ?? null,
          me: mailbox.me,
        };
        const written = await writeOutlookCompose(api, request, { context, wellKnown: mailbox.wellKnown });
        return { ...written, cost: api.cost };
      }
      return { ...(await writeMessage(api, request, mailbox)), cost: api.cost };
    },

    async mirrorBuckets(request: MirrorRequest): Promise<MirrorResult> {
      const api = connect(request);
      return { problems: await carryOutPlan(api, request), cost: api.cost };
    },

    fetchPart(request: PartRequest) {
      return fetchOutlookPart(connect(request), request);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Mirror Buckets (#142): the master list of categories

const MASTER_CATEGORIES = '/me/outlook/masterCategories';
const masterCategory = z.object({ id: z.string().min(1), displayName: z.string() });
const masterCategories = z.object({ value: z.array(masterCategory) });
const NO_PERMISSION =
  'Outlook wouldn’t let Commander change its categories (Grant access in Settings → Accounts gives it MailboxSettings.ReadWrite), so they show without colours.';

async function carryOutPlan(api: GraphMail, { plan }: MirrorRequest): Promise<string[]> {
  const category = (bucket: string) => mirrorLabelName('outlook', bucket);
  try {
    const listed = await api.send('GET', MASTER_CATEGORIES, undefined, masterCategories);
    const byName = new Map(listed.value.map((each) => [each.displayName, each.id]));
    const make = async (name: string, colour: number) => {
      if (byName.has(category(name))) return;
      const made = await api.send(
        'POST',
        MASTER_CATEGORIES,
        { displayName: category(name), color: mirrorColourOf(colour) },
        masterCategory,
      );
      byName.set(made.displayName, made.id);
    };
    const remove = async (name: string) => {
      const id = byName.get(category(name));
      if (!id) return;
      try {
        await api.send('DELETE', `${MASTER_CATEGORIES}/${encodeURIComponent(id)}`, undefined, z.unknown());
      } catch (error) {
        if (!(error instanceof GraphNotFound)) throw error;
      }
      byName.delete(category(name));
    };
    const wanted = new Set([...plan.ensure.map((each) => each.name), ...plan.rename.map((each) => each.to)]);
    // Categories can't be renamed: the new one is made, and the old one goes (its emails move with
    // their own writes).
    for (const { from, to, colour } of plan.rename) {
      await make(to, colour);
      if (!wanted.has(from)) await remove(from);
    }
    for (const { name, colour } of plan.ensure) await make(name, colour);
    for (const { name } of plan.remove) if (!wanted.has(name)) await remove(name);
    return [];
  } catch (error) {
    if (error instanceof WriteRejected) return [NO_PERMISSION];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Sync

async function syncMailbox(
  api: GraphMail,
  request: SyncRequest,
  now: () => number,
  remember: (mailbox: Mailbox) => void,
): Promise<OutlookCursor> {
  const previous = outlookCursor.safeParse(request.cursor);
  let cursor: OutlookCursor = previous.success
    ? structuredClone(previous.data)
    : {
        v: 1,
        windowStart: (request.connectedAt ?? now()) - WINDOW_DAYS * DAY_MS,
        me: null,
        wellKnown: {},
        folders: {},
        removed: {},
      };
  if (!cursor.wellKnown.inbox) cursor = { ...cursor, ...(await lookUpMailbox(api)) };

  const listed = folderPlan(await listFolders(api), cursor.wellKnown);
  request.saveCatalog?.({
    kind: 'outlook',
    folders: [...listed.values()].map(({ id, name, wellKnown, parentId, role }) => ({
      id,
      name,
      wellKnown: wellKnown ?? null,
      parentId,
      system: isSystemFolder({ wellKnown }),
      synced: role === 'mail',
    })),
  });
  const folders = new Map(
    [...listed].map(([id, { name, wellKnown }]) => [id, { id, name, wellKnown: wellKnown ?? null }]),
  );
  remember({ wellKnown: cursor.wellKnown, folders, me: cursor.me });
  const context: MessageContext = {
    folders,
    inbox: cursor.wellKnown.inbox ?? null,
    sent: cursor.wellKnown.sentitems ?? null,
    me: cursor.me,
  };
  const plan = readingOrder(listed);
  const trashId = plan.find((folder) => folder.role === 'trash')?.id ?? null;

  const storedById = (ids: string[]) =>
    new Map((ids.length ? (request.stored?.(ids) ?? []) : []).map((item) => [item.externalId, item]));
  const heldEmails = () =>
    [...storedById(request.heldIds?.() ?? []).values()].flatMap((item) => {
      const detail = emailOf(item);
      return detail ? [{ item, detail }] : [];
    });
  const checkpoint = () => request.checkpoint?.(structuredClone(cursor));

  // Folders gone since the last sync (deleted, with their mail): what Commander held there goes too.
  const planned = new Set(plan.map((folder) => folder.id));
  const gone = new Set(Object.keys(cursor.folders).filter((id) => !planned.has(id)));
  if (gone.size) {
    const deleted = heldEmails()
      .filter(({ detail }) => !detail.inTrash && !!detail.folder && gone.has(detail.folder.id))
      .map(({ item }) => item.externalId);
    if (deleted.length) request.save({ items: [], deleted });
    for (const id of gone) delete cursor.folders[id];
  }

  // The first download: how many messages there are to fetch, for the User.
  const fresh = plan.filter((folder) => folder.role === 'mail' && !cursor.folders[folder.id]?.ready);
  if (fresh.length && !cursor.backfill) {
    const countPath = (id: string) =>
      `/me/mailFolders/${encodeURIComponent(id)}/messages?$filter=${windowFilter(cursor.windowStart)}&$count=true&$top=1&$select=id`;
    // Only for the progress line: a count Graph won't give leaves the total short, never the sync.
    const counts = await api.batch(
      fresh.map((folder) => countPath(folder.id)),
      { lenient: true },
    );
    let total = 0;
    for (const folder of fresh) {
      const counted = countAnswer.safeParse(counts.get(countPath(folder.id)));
      if (counted.success) total += counted.data['@odata.count'];
    }
    cursor.backfill = { done: 0, total };
    checkpoint();
  }
  const report = () => {
    if (cursor.backfill)
      request.progress?.({
        done: cursor.backfill.done,
        total: Math.max(cursor.backfill.total, cursor.backfill.done),
      });
  };
  report();

  // Messages seen in a synced folder this sync: a removal elsewhere was a move.
  const seen = new Set<string>();

  // Saves a mail folder's page: its messages, and the removals to judge once every folder is read.
  async function takeMail(page: DeltaPage, folder: Planned, returned: Set<string>, counting: boolean) {
    const messages: GraphMessage[] = [];
    const drafts = folder.role === 'drafts';
    for (const message of page.value) {
      if (message['@removed']) {
        if (!seen.has(message.id)) cursor.removed[message.id] = folder.id;
      } else if ((message.isDraft === true) === drafts) messages.push(message);
    }
    if (!messages.length) return;
    const held = storedById(messages.map((message) => message.id));
    const heldAttachments = (id: string) => emailOf(held.get(id))?.attachments ?? [];
    // Attachments' metadata, for messages that have some (inline ones too) and whose aren't known yet.
    const wanted = messages.filter(
      (message) =>
        (message.hasAttachments === true || showsInlineParts(message)) && !heldAttachments(message.id).length,
    );
    const listedAttachments = new Map<string, EmailAttachment[]>();
    // Leniently: attachments Graph won't list are asked for more plainly, and failing that left out
    // (the reader asks again by Content-ID), rather than stopping the sync.
    let unlisted = wanted;
    for (const fields of [ATTACHMENT_FIELDS, BASE_ATTACHMENT_FIELDS]) {
      if (!unlisted.length) break;
      const answers = await api.batch(
        unlisted.map((message) => attachmentsPath(message.id, fields)),
        { lenient: true },
      );
      unlisted = unlisted.filter((message) => {
        const parsed = attachmentsPage.safeParse(answers.get(attachmentsPath(message.id, fields)));
        if (!parsed.success) return true;
        listedAttachments.set(
          message.id,
          parsed.data.value.flatMap((each) => attachmentOf(each) ?? []),
        );
        return false;
      });
    }
    // Invitations (#144): each event message read again with the event it is about, once (what was
    // read is kept with the message). Leniently: one Graph won't read is left without, as before.
    const heldInvitation = (id: string) => emailOf(held.get(id))?.invitation ?? null;
    const unread = messages.filter((message) => isEventMessage(message) && !heldInvitation(message.id));
    const invitations = new Map<string, EmailDetail['invitation']>();
    if (unread.length) {
      const answers = await api.batch(
        unread.map((message) => eventMessagePath(message.id)),
        { lenient: true },
      );
      for (const message of unread) {
        const parsed = graphEventMessage.safeParse(answers.get(eventMessagePath(message.id)));
        if (parsed.success) invitations.set(message.id, invitationOfEventMessage(parsed.data));
      }
    }
    const items = messages.map((message) => {
      const item = readOutlookMessage(
        message,
        context,
        listedAttachments.get(message.id) ?? heldAttachments(message.id),
        invitations.get(message.id) ?? heldInvitation(message.id),
      );
      if (!drafts || item.detail?.kind !== 'email') return item;
      return {
        ...item,
        status: 'archived' as const,
        detail: { ...item.detail, draft: true, inInbox: false },
      };
    });
    for (const message of messages) {
      seen.add(message.id);
      returned.add(message.id);
      delete cursor.removed[message.id];
    }
    request.save({ items, deleted: [] });
    if (counting && cursor.backfill) {
      cursor.backfill.done += items.filter((item) => !held.has(item.externalId)).length;
      report();
    }
  }

  // Deleted Items' page: held messages moved there are in Trash; ones gone from it may be deleted.
  function takeTrash(page: DeltaPage, folder: Planned, returned: Set<string>) {
    const held = storedById(page.value.map((message) => message.id));
    const items: SourceItem[] = [];
    for (const message of page.value) {
      const item = held.get(message.id);
      const detail = emailOf(item);
      if (message['@removed']) {
        if (!seen.has(message.id) && detail?.inTrash) cursor.removed[message.id] = folder.id;
        continue;
      }
      returned.add(message.id);
      if (!item || !detail) continue;
      delete cursor.removed[message.id];
      const next: EmailDetail = {
        ...detail,
        inTrash: true,
        read: message.isRead !== false,
        starred: message.flag?.flagStatus === 'flagged',
        categories: [...message.categories],
      };
      if (!sameJson(next, detail)) items.push(updatedItem(item, next));
    }
    if (items.length) request.save({ items, deleted: [] });
  }

  // One folder's changes since its link, or its first round; a link Outlook no longer accepts re-reads
  // the folder's window once.
  async function syncFolder(folder: Planned) {
    let mark: FolderMark = cursor.folders[folder.id] ?? { link: null, ready: false };
    let link = mark.link ?? firstRound(folder, cursor.windowStart);
    let resync = false;
    let restarted = false;
    let plain = false;
    const returned = new Set<string>();
    for (;;) {
      let page: DeltaPage;
      try {
        page = await api.get(link, deltaPage);
      } catch (error) {
        // Deleted since it was listed: the next sync finds it gone.
        if (error instanceof GraphNotFound) return;
        // Graph won't send internet headers in this folder's delta: ask without them, once.
        if (error instanceof GraphBadRequest && !plain && link === firstRound(folder, cursor.windowStart)) {
          plain = true;
          link = firstRound(folder, cursor.windowStart, true);
          continue;
        }
        if (!(error instanceof CursorExpired) || restarted) throw error;
        // A first round's page link that expired starts the round again; an expired delta link re-syncs.
        restarted = true;
        resync = mark.ready;
        link = firstRound(folder, cursor.windowStart, plain);
        returned.clear();
        continue;
      }
      const counting = folder.role === 'mail' && !mark.ready;
      if (folder.role === 'trash') takeTrash(page, folder, returned);
      else await takeMail(page, folder, returned, counting);
      const next = page['@odata.nextLink'];
      if (next) {
        link = next;
        if (!resync) {
          mark = { link: next, ready: false };
          cursor.folders[folder.id] = mark;
          checkpoint();
        }
        continue;
      }
      const delta = page['@odata.deltaLink'];
      if (!delta)
        throw new SourceUnavailable('Outlook ended a folder’s changes without a delta link.', api.cost);
      mark = { link: delta, ready: true };
      break;
    }
    if (resync) {
      // Held mail filed here that the folder no longer lists left it while its link was stale.
      for (const { item, detail } of heldEmails()) {
        const here =
          folder.role === 'trash' ? !!detail.inTrash : !detail.inTrash && detail.folder?.id === folder.id;
        if (here && !returned.has(item.externalId) && !seen.has(item.externalId))
          cursor.removed[item.externalId] = folder.id;
      }
    }
    cursor.folders[folder.id] = mark;
    checkpoint();
  }

  for (const folder of plan) await syncFolder(folder);

  // Messages that left a folder and turned up in no other synced folder: deleted, or moved to Junk.
  const pending = Object.entries(cursor.removed).filter(([id]) => !seen.has(id));
  const held = storedById(pending.map(([id]) => id));
  const deleted = pending
    .filter(([id, left]) => {
      const detail = emailOf(held.get(id));
      if (!detail) return false;
      return left === trashId ? !!detail.inTrash : !detail.inTrash && detail.folder?.id === left;
    })
    .map(([id]) => id);
  if (deleted.length) request.save({ items: [], deleted });
  const { backfill: _done, ...finished } = cursor;
  return { ...finished, removed: {} };
}

// ---------------------------------------------------------------------------------------------
// Writes

type Wants = {
  read?: { change: FieldChange; value: boolean };
  starred?: { change: FieldChange; value: boolean };
  inbox?: { change: FieldChange; value: boolean };
  trash?: { change: FieldChange; value: boolean };
  folder?: { change: FieldChange; value: EmailFolder };
  mirror?: { change: FieldChange; value: string | null };
};

function wantsOf(changes: readonly FieldChange[]): Wants {
  const wants: Wants = {};
  for (const change of changes) {
    if (
      change.field === 'read' ||
      change.field === 'starred' ||
      change.field === 'inbox' ||
      change.field === 'trash'
    ) {
      if (typeof change.value !== 'boolean') throw new WriteRejected('That isn’t a change Outlook takes.');
      wants[change.field] = { change, value: change.value };
    } else if (change.field === BUCKET_MIRROR_FIELD) {
      const value = change.value as MirroredBuckets;
      if (Array.isArray(value)) throw new WriteRejected('Commander shows one Bucket per email in Outlook.');
      wants.mirror = { change, value };
    } else if (change.field === 'folder') {
      const folder = change.value as EmailFolder | null;
      if (!folder?.id) throw new WriteRejected('Outlook needs a folder to move this message to.');
      wants.folder = { change, value: folder };
    } else throw new WriteRejected('Commander can’t change that in Outlook.');
  }
  return wants;
}

const messagePath = (id: string) => `/me/messages/${encodeURIComponent(id)}`;
const flagged = (state: MessageState) => state.flag?.flagStatus === 'flagged';

async function writeMessage(api: GraphMail, request: WriteRequest, mailbox: Mailbox) {
  const id = request.externalId;
  const wants = wantsOf(request.changes);
  const [stored] = request.stored?.([id]) ?? [];
  const held = emailOf(stored);
  const { wellKnown } = mailbox;

  let current: MessageState;
  try {
    current = await api.send('GET', `${messagePath(id)}?$select=${STATE_FIELDS}`, undefined, messageState);
  } catch (error) {
    if (error instanceof GraphNotFound) throw new WriteRejected('This message is no longer in Outlook.');
    throw error;
  }
  const inTrash = !!wellKnown.deleteditems && current.parentFolderId === wellKnown.deleteditems;
  // In Deleted Items, the folder it came from (and so whether that is the Inbox) is Commander's to keep.
  const now_ = {
    read: current.isRead !== false,
    starred: flagged(current),
    trash: inTrash,
    inbox: inTrash ? (held?.inInbox ?? false) : current.parentFolderId === wellKnown.inbox,
    folder: inTrash ? (held?.folder?.id ?? null) : (current.parentFolderId ?? null),
  };
  const modifiedAt = Date.parse(current.lastModifiedDateTime ?? '');
  const superseded: Superseded[] = [];
  // Whether a change still needs making: not if Outlook has it already, nor if Outlook changed the field
  // since Commander last synced it, later than the User did (the newer change wins).
  const needed = (change: FieldChange, value: unknown, outlook: unknown, synced: unknown) => {
    if (sameJson(outlook, value)) return false;
    if (!sameJson(outlook, synced) && Number.isFinite(modifiedAt) && modifiedAt > change.madeAt) {
      superseded.push({ field: change.field, by: null, at: modifiedAt });
      return false;
    }
    return true;
  };
  const syncedFolder = (change: FieldChange) => (change.synced as EmailFolder | null)?.id ?? null;

  const patch: Record<string, unknown> = {};
  if (wants.read && needed(wants.read.change, wants.read.value, now_.read, wants.read.change.synced))
    patch.isRead = wants.read.value;
  if (
    wants.starred &&
    needed(wants.starred.change, wants.starred.value, now_.starred, wants.starred.change.synced)
  )
    patch.flag = { flagStatus: wants.starred.value ? 'flagged' : 'notFlagged' };
  // The Bucket category (#142): exactly the one it names, beside the User's own categories.
  if (wants.mirror) {
    const shown = mirroredValue(current.categories.flatMap((each) => bucketOfCategory(each) ?? []));
    if (needed(wants.mirror.change, wants.mirror.value, shown, wants.mirror.change.synced)) {
      const own = current.categories.filter((each) => bucketOfCategory(each) === null);
      patch.categories = [
        ...own,
        ...namesOf(wants.mirror.value).map((name) => mirrorLabelName('outlook', name)),
      ];
    }
  }
  const trash =
    wants.trash && needed(wants.trash.change, wants.trash.value, now_.trash, wants.trash.change.synced)
      ? wants.trash.value
      : null;
  const folder =
    wants.folder &&
    needed(wants.folder.change, wants.folder.value.id, now_.folder, syncedFolder(wants.folder.change))
      ? wants.folder.value
      : null;
  const inbox =
    wants.inbox && needed(wants.inbox.change, wants.inbox.value, now_.inbox, wants.inbox.change.synced)
      ? wants.inbox.value
      : null;

  // Where it goes, by well-known name or folder id: Trash first, then a folder, then in or out of the inbox.
  let destination: string | null = null;
  if (trash === true) destination = 'deleteditems';
  else if (trash === false)
    destination =
      folder?.id ??
      (inbox !== null
        ? inbox
          ? 'inbox'
          : 'archive'
        : (held?.folder?.id ?? (held?.inInbox ? 'inbox' : 'archive')));
  else if (folder) destination = folder.id;
  else if (inbox !== null && !inTrash) destination = inbox ? 'inbox' : 'archive';
  const destinationId = destination ? (wellKnown[destination] ?? destination) : null;
  if (destinationId && destinationId === current.parentFolderId) destination = null;

  let answer: MessageState = current;
  try {
    if (Object.keys(patch).length) answer = await api.send('PATCH', messagePath(id), patch, messageState);
    if (destination)
      answer = await api.send(
        'POST',
        `${messagePath(id)}/move`,
        { destinationId: destination },
        messageState,
      );
  } catch (error) {
    if (error instanceof GraphNotFound)
      throw new WriteRejected(
        destination
          ? 'Outlook has no such folder, or no longer has this message.'
          : 'This message is no longer in Outlook.',
      );
    throw error;
  }

  if (!stored || !held) return { item: null, superseded };
  const nowInTrash = !!wellKnown.deleteditems && answer.parentFolderId === wellKnown.deleteditems;
  const named = new Map(mailbox.folders);
  if (wants.folder)
    named.set(wants.folder.value.id, {
      ...wants.folder.value,
      wellKnown: wants.folder.value.wellKnown ?? null,
    });
  for (const [name, folderId] of Object.entries(wellKnown))
    if (!named.has(folderId))
      named.set(folderId, { id: folderId, name: DEFAULT_NAMES[name] ?? name, wellKnown: name });
  const filed = nowInTrash
    ? {}
    : filedIn(folderOf(answer.parentFolderId, { folders: named, inbox: null, sent: null, me: null }));
  const detail: EmailDetail = {
    ...held,
    ...filed,
    read: answer.isRead !== false,
    starred: flagged(answer),
    categories: [...answer.categories],
  };
  delete detail.inTrash;
  if (nowInTrash) detail.inTrash = true;
  return { item: updatedItem(stored, detail), superseded };
}

// ---------------------------------------------------------------------------------------------
// The reader's parts

async function fetchOutlookPart(api: GraphMail, request: PartRequest): Promise<FetchedPart> {
  const path = messagePath(request.externalId);
  let attachment: z.infer<typeof graphAttachment> | undefined;
  // Asks with Content-IDs, or, should Graph refuse that, with only what every attachment has.
  const plainly = async <T>(ask: (fields: string) => Promise<T>): Promise<T> => {
    try {
      return await ask(ATTACHMENT_FIELDS);
    } catch (error) {
      if (error instanceof GraphBadRequest) return await ask(BASE_ATTACHMENT_FIELDS);
      throw error;
    }
  };
  try {
    if ('partId' in request.part) {
      const partPath = `${path}/attachments/${encodeURIComponent(request.part.partId)}`;
      attachment = await plainly((fields) => api.get(`${partPath}?$select=${fields}`, graphAttachment));
    } else {
      const wanted = normaliseContentId(request.part.contentId);
      const matches = (each: z.infer<typeof graphAttachment>) =>
        !!each.contentId && normaliseContentId(each.contentId) === wanted;
      const listed = await plainly((fields) =>
        api.get(`${path}/attachments?$select=${fields}`, attachmentsPage),
      );
      attachment = listed.value.find(matches);
      // Listed without Content-IDs: each inline attachment is read whole (up to 20) to find it.
      if (!attachment && !listed.value.some((each) => each.contentId)) {
        for (const each of listed.value.filter((one) => one.isInline).slice(0, 20)) {
          const whole = await api.get(`${path}/attachments/${encodeURIComponent(each.id)}`, graphAttachment);
          if (matches(whole)) {
            attachment = whole;
            break;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof GraphNotFound)
      throw new PartNotFound('Outlook no longer has this message or attachment.');
    throw error;
  }
  const part = attachment ? attachmentOf(attachment) : null;
  if (!attachment || !part) throw new PartNotFound('This message has no such part.');
  if (part.size > request.maxBytes) throw new PartTooLarge('This attachment is too large.');
  let bytes: Uint8Array;
  try {
    bytes = await api.bytes(`${path}/attachments/${encodeURIComponent(attachment.id)}/$value`);
  } catch (error) {
    if (error instanceof GraphNotFound) throw new PartNotFound('Outlook no longer has this attachment.');
    throw error;
  }
  if (bytes.length > request.maxBytes) throw new PartTooLarge('This attachment is too large.');
  return { partId: attachment.id, name: part.name, type: part.type, bytes };
}
