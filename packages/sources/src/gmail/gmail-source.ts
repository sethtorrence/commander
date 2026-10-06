import {
  type EmailDetail,
  type EmailLabel,
  emailStatus,
  isPendingEventExternalId,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import { isComposeWrite } from '../email-send/compose-write';
import {
  type Cadence,
  CursorExpired,
  type FieldChange,
  type PartRequest,
  type SourceAdapter,
  type StoredItem,
  type Superseded,
  type SyncRequest,
  WriteRejected,
  type WriteRequest,
} from '../source';
import { connectGmail, createPacer, type GmailClient, MessageGone, type Pacer } from './client';
import { DRAFT_PREFIX, syncGmailDrafts, writeCompose } from './compose';
import { labelName, readGmailMessage } from './message';
import { fetchGmailPart } from './parts';
import {
  type GmailHistory,
  type GmailMessageLabels,
  gmailHistory,
  gmailLabels,
  gmailMessage,
  gmailMessageLabels,
  gmailMessageList,
  gmailProfile,
} from './shapes';

// Gmail as a Source: the User's mail through the Gmail API v1 over fetch, one `email` Item per
// message (decisions #2, #8, #15, #30). There is no push for a desktop app, so Commander polls.
//
// - First sync: note the mailbox's current historyId, then list the messages from the 30 days before
//   the Account was connected (`after:`; Gmail leaves out Spam and Trash), newest first, and fetch
//   each with `messages.get?format=full`, paced by Gmail's quota (client.ts), saving every few so the
//   newest mail can be read within seconds while older mail backfills. Drafts are skipped. Before
//   fetching it checkpoints the window and historyId, so a first sync stopped by a restart or Gmail's
//   quota resumes where it stopped: the window is listed again (cheap) and only messages Commander
//   doesn't hold are fetched. Then history since the noted historyId catches what changed meanwhile.
// - After that: `history.list` from the last historyId: messages added and deleted, labels added and
//   removed. Deleted messages, and messages moved to Trash or Spam, become tombstones; label changes
//   update read, starred, inbox and labels from what Commander holds, without fetching the message.
// - Expired history (a 404, after about a week): the same window is read again, fetching only the
//   messages Commander doesn't hold, refreshing the labels of the rest from cheap label listings
//   (`messages.list?labelIds=…`, one per label, instead of a fetch per message), and tombstoning
//   what Gmail no longer has.
// - Trash (#135): a message moved to Trash stays, marked as in Trash (the Email Section's Trash view),
//   until Gmail deletes it; Spam and deleted messages become tombstones.
// - Writes (#135, ADR 0003): an email's synced fields (`inbox`, `read`, `starred`, `trash`, one
//   `label:<id>` per label) become Gmail labels: `messages.trash` / `untrash` for Trash, then one
//   `messages.modify` adding and removing the rest. A thread's change is each of its messages' (the
//   outgoing queue writes Item by Item, so `batchModify` isn't used: it answers with nothing to save).
//   Before writing, the adapter reads the message's labels: what Gmail already has isn't sent, and a
//   field Gmail changed since Commander last saw the message (its history since the historyId the
//   Item carries) is left as Gmail has it, reported as superseded. Gmail's history carries no times,
//   so "newer" means "made in Gmail after Commander last saw the message": the User changed what they
//   saw, and Gmail's change came on top of it or unseen.
// - Drafts (#138) are Items of their own, `draft:<draft id>` (compose.ts), listed with `drafts.list`
//   whenever a sync sees a draft change (a first download that met one, or history touching a message
//   labelled DRAFT or a held draft's message), and fetched only where their message changed. Messages
//   written in Commander are saved as drafts and sent through the outgoing queue (compose.ts).

export const GMAIL_CADENCE: Cadence = { defaultMinutes: 15, choices: [5, 10, 15, 30, 60] };

export type GmailSourceOptions = {
  // Gmail's base; read per sync, so the end-to-end tests can point it at a fake.
  gmailUrl: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const DAY_MS = 24 * 60 * 60_000;
const WINDOW_DAYS = 30;
// Messages saved together while downloading.
const SAVE_EVERY = 10;
const PAGE_SIZE = 500;
// Never downloaded. A message that gains Spam is gone as far as Commander is concerned; one that
// gains Trash stays, in Trash (#135).
const SKIPPED = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);
const HIDDEN = new Set(['SPAM', 'TRASH']);
const GONE = new Set(['SPAM']);
const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];
const LABEL_HISTORY = ['labelAdded', 'labelRemoved'];

// Where the next sync starts: the 30-day window's start (kept for re-syncs), the historyId to read
// history from, and, while a download is under way, `backfill` (with whether the labels of messages
// already held need refreshing: a re-sync's do, a first sync's don't).
const gmailCursor = z.object({
  v: z.literal(1),
  windowStart: z.number(),
  historyId: z.string().min(1),
  backfill: z.object({ refresh: z.boolean() }).optional(),
});
export type GmailCursor = z.infer<typeof gmailCursor>;

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

const query = (params: Record<string, string | string[] | undefined>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value])
      search.append(name, each);
  }
  return `?${search.toString()}`;
};

const emailOf = (item: StoredItem): EmailDetail | null =>
  item.detail?.kind === 'email' ? item.detail : null;

/** The detail with these Gmail labels: read, starred, inbox, Trash and sent follow them. */
function relabelled(
  detail: EmailDetail,
  labelIds: readonly string[],
  names: ReadonlyMap<string, string>,
  version?: string | null,
): EmailDetail {
  // Labels it had keep their place, so an unchanged set compares equal.
  const had = detail.labels.map((label) => label.id).filter((id) => labelIds.includes(id));
  const ordered = [...had, ...labelIds.filter((id) => !had.includes(id))];
  const next: EmailDetail = {
    ...detail,
    labels: ordered.map(
      (id) => detail.labels.find((label) => label.id === id) ?? { id, name: labelName(id, names) },
    ),
    read: !ordered.includes('UNREAD'),
    starred: ordered.includes('STARRED'),
    inInbox: ordered.includes('INBOX'),
    sentByMe: ordered.includes('SENT'),
  };
  delete next.inTrash;
  if (ordered.includes('TRASH')) next.inTrash = true;
  if (version) next.sourceVersion = version;
  return next;
}

function relabelledItem(item: StoredItem, detail: EmailDetail): SourceItem {
  return {
    externalId: item.externalId,
    kind: 'email',
    title: item.title,
    people: item.people,
    status: emailStatus(detail),
    detail,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createGmailSource({
  gmailUrl,
  fetch = globalThis.fetch,
  now = Date.now,
  sleep = sleepFor,
}: GmailSourceOptions): SourceAdapter {
  // Each Account's quota is paced across its syncs, writes and the reader's part fetches.
  const pacers = new Map<string, Pacer>();
  const pacerOf = (account: string) => {
    let pacer = pacers.get(account);
    if (!pacer) {
      pacer = createPacer(now, sleep);
      pacers.set(account, pacer);
    }
    return pacer;
  };

  return {
    source: 'gmail',
    cadence: GMAIL_CADENCE,

    async write(request: WriteRequest) {
      const gmail = connectGmail({
        gmailUrl: gmailUrl(),
        fetch,
        now,
        pacer: pacerOf(request.account),
        accessToken: request.accessToken,
        signal: request.signal,
      });
      if (isComposeWrite(request.changes))
        return { ...(await writeCompose(gmail, request, now)), cost: gmail.cost };
      return { ...(await writeMessage(gmail, request, now)), cost: gmail.cost };
    },

    async sync(request: SyncRequest) {
      const gmail = connectGmail({
        gmailUrl: gmailUrl(),
        fetch,
        now,
        pacer: pacerOf(request.account),
        accessToken: request.accessToken,
        signal: request.signal,
      });
      const run = gmailRun(gmail, request);
      const previous = gmailCursor.safeParse(request.cursor);
      let cursor: GmailCursor;
      if (!previous.success) {
        // First sync (or Commander lost its cursor): a held message's labels may be stale.
        const windowStart = (request.connectedAt ?? now()) - WINDOW_DAYS * DAY_MS;
        cursor = await run.download({ windowStart, historyId: null, refresh: run.heldIds().length > 0 });
      } else if (previous.data.backfill) {
        cursor = await run.download({ ...previous.data, refresh: previous.data.backfill.refresh });
      } else {
        try {
          cursor = await run.history(previous.data);
        } catch (error) {
          if (!(error instanceof CursorExpired)) throw error;
          // Gmail's history has expired: read the same window again.
          cursor = await run.download({
            windowStart: previous.data.windowStart,
            historyId: null,
            refresh: true,
          });
        }
      }
      // Drafts, when this sync met a change to one (#138).
      if (run.draftsChanged()) await run.drafts();
      request.progress?.(null);
      return { cursor, cost: gmail.cost };
    },

    // The email reader's parts (parts.ts).
    fetchPart(request: PartRequest) {
      const gmail = connectGmail({
        gmailUrl: gmailUrl(),
        fetch,
        now,
        pacer: pacerOf(request.account),
        accessToken: request.accessToken,
        signal: request.signal,
      });
      return fetchGmailPart(gmail, request);
    },
  };
}

// One sync of one Account.
function gmailRun(gmail: GmailClient, request: SyncRequest) {
  let labels: Map<string, string> | null = null;
  async function labelNames(): Promise<Map<string, string>> {
    if (!labels) {
      const found = await gmail.get('labels', '/labels', gmailLabels);
      labels = new Map((found.labels ?? []).map((label) => [label.id, label.name]));
      // Kept for the label picker and the view list (#135).
      const names = labels;
      request.saveCatalog?.({
        kind: 'gmail',
        labels: (found.labels ?? []).map((label) => ({
          id: label.id,
          name: labelName(label.id, names),
          system: label.type === 'system',
        })),
      });
    }
    return labels;
  }

  const heldIds = () => request.heldIds?.() ?? [];
  // Whether this sync met a change to a draft (#138), so the drafts are listed once it is done.
  let draftsChanged = false;
  async function drafts() {
    const ids = heldIds().filter((id) => id.startsWith(DRAFT_PREFIX));
    const held = new Map(
      [...storedById(ids).values()].map((item) => [item.externalId, emailOf(item)?.sourceVersion ?? null]),
    );
    const found = await syncGmailDrafts(gmail, held);
    if (found.items.length || found.deleted.length) request.save(found);
  }
  const storedById = (ids: string[]) =>
    new Map((ids.length ? (request.stored?.(ids) ?? []) : []).map((item) => [item.externalId, item]));

  // Every id a listing gives, newest first, page by page.
  async function listIds(params: Record<string, string>): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await gmail.get(
        'list',
        `/messages${query({ maxResults: String(PAGE_SIZE), ...params, pageToken })}`,
        gmailMessageList,
      );
      ids.push(...(page.messages ?? []).map((message) => message.id));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return ids;
  }

  // Fetches each message and saves it, a few at a time; `onSaved` hears how many were done. What was
  // fetched before a failure is saved before the failure goes on.
  async function fetchAndSave(
    ids: readonly string[],
    keep: (item: SourceItem) => boolean,
    onSaved: (done: number) => void = () => {},
  ) {
    const names = await labelNames();
    let batch: SourceItem[] = [];
    let done = 0;
    let pending = 0;
    const flush = () => {
      if (batch.length) request.save({ items: batch, deleted: [] });
      batch = [];
      done += pending;
      pending = 0;
      onSaved(done);
    };
    try {
      for (const id of ids) {
        pending += 1;
        let message: z.infer<typeof gmailMessage>;
        try {
          message = await gmail.get('get', `/messages/${encodeURIComponent(id)}?format=full`, gmailMessage);
        } catch (error) {
          if (error instanceof MessageGone) continue;
          throw error;
        }
        if ((message.labelIds ?? []).some((label) => SKIPPED.has(label))) {
          if (message.labelIds?.includes('DRAFT')) draftsChanged = true;
          continue;
        }
        const item = readGmailMessage(message, names);
        if (keep(item)) batch.push(item);
        if (pending >= SAVE_EVERY) flush();
      }
    } finally {
      if (!request.signal.aborted) flush();
    }
  }

  // The first sync, a resumed one, or a re-sync after history expired: the window's messages.
  async function download({
    windowStart,
    historyId: noted,
    refresh,
  }: {
    windowStart: number;
    historyId: string | null;
    refresh: boolean;
  }): Promise<GmailCursor> {
    const names = await labelNames();
    const historyId = noted ?? (await gmail.get('profile', '/profile', gmailProfile)).historyId;
    request.checkpoint?.({ v: 1, windowStart, historyId, backfill: { refresh } } satisfies GmailCursor);
    const after = `after:${Math.floor(windowStart / 1000)}`;
    const listed = await listIds({ q: after });
    const held = storedById(listed);
    const missing = listed.filter((id) => !held.has(id));
    const already = listed.length - missing.length;
    request.progress?.({ done: already, total: listed.length });
    await fetchAndSave(
      missing,
      () => true,
      (done) => request.progress?.({ done: already + done, total: listed.length }),
    );

    if (refresh) {
      // Labels of the messages already held, from one listing per label rather than a fetch each.
      const withLabel = new Map<string, Set<string>>();
      for (const label of names.keys()) {
        if (SKIPPED.has(label)) continue;
        for (const id of await listIds({ labelIds: label, q: after })) {
          withLabel.set(id, (withLabel.get(id) ?? new Set()).add(label));
        }
      }
      const changed: SourceItem[] = [];
      for (const item of held.values()) {
        const detail = emailOf(item);
        if (!detail) continue;
        const next = relabelled(detail, [...(withLabel.get(item.externalId) ?? [])], names, historyId);
        if (!sameJson({ ...next, sourceVersion: null }, { ...detail, sourceVersion: null }))
          changed.push(relabelledItem(item, next));
      }
      // Held messages from the window that Gmail no longer lists were deleted, or moved to Spam, or
      // to Trash, where they stay (with the labels they had).
      const listedIds = new Set(listed);
      const trashed = new Set(await listIds({ labelIds: 'TRASH', q: after, includeSpamTrash: 'true' }));
      // Drafts, and messages written in Commander not yet sent, are never among the listed messages.
      const messageIds = heldIds().filter(
        (id) => !id.startsWith(DRAFT_PREFIX) && !isPendingEventExternalId(id),
      );
      const unlisted = [...storedById(messageIds.filter((id) => !listedIds.has(id))).values()].filter(
        (item) => (emailOf(item)?.sentAt ?? 0) >= windowStart,
      );
      for (const item of unlisted) {
        const detail = emailOf(item);
        if (!detail || !trashed.has(item.externalId) || detail.inTrash) continue;
        const kept = detail.labels.map((label) => label.id);
        changed.push(relabelledItem(item, relabelled(detail, [...kept, 'TRASH'], names, historyId)));
      }
      const gone = unlisted.filter((item) => !trashed.has(item.externalId)).map((item) => item.externalId);
      if (changed.length || gone.length) request.save({ items: changed, deleted: gone });
    }

    // What changed in Gmail while downloading.
    return await history({ v: 1, windowStart, historyId });
  }

  // Gmail's history since the cursor's historyId.
  async function history(cursor: GmailCursor): Promise<GmailCursor> {
    const records: NonNullable<GmailHistory['history']> = [];
    let latest = cursor.historyId;
    let pageToken: string | undefined;
    do {
      const page = await gmail.get(
        'history',
        `/history${query({ startHistoryId: cursor.historyId, maxResults: String(PAGE_SIZE), historyTypes: HISTORY_TYPES, pageToken })}`,
        gmailHistory,
      );
      records.push(...(page.history ?? []));
      latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
    const next: GmailCursor = { v: 1, windowStart: cursor.windowStart, historyId: latest };
    if (!records.length) return next;

    // Each message's story, in order: added (with its labels then), deleted, labels changed.
    const added = new Map<string, string[]>();
    const deleted = new Set<string>();
    const changes: { id: string; add: string[]; remove: string[] }[] = [];
    // The history each message was last changed at, for the next write's check (#135).
    const versions = new Map<string, string>();
    for (const record of records) {
      for (const each of [
        ...(record.messagesAdded ?? []),
        ...(record.labelsAdded ?? []),
        ...(record.labelsRemoved ?? []),
      ])
        versions.set(each.message.id, record.id);
      for (const { message } of record.messagesAdded ?? []) {
        added.set(message.id, message.labelIds ?? []);
        deleted.delete(message.id);
      }
      for (const { message } of record.messagesDeleted ?? []) {
        deleted.add(message.id);
        added.delete(message.id);
      }
      for (const change of record.labelsAdded ?? [])
        changes.push({ id: change.message.id, add: change.labelIds ?? [], remove: [] });
      for (const change of record.labelsRemoved ?? [])
        changes.push({ id: change.message.id, add: [], remove: change.labelIds ?? [] });
    }
    const ids = [...new Set([...added.keys(), ...deleted, ...changes.map((change) => change.id)])];
    const held = storedById(ids);
    // A draft saved, sent or deleted (#138): the drafts are listed once this sync is done.
    const draftMessages = new Set(
      [...storedById(heldIds().filter((id) => id.startsWith(DRAFT_PREFIX))).values()].flatMap((item) => {
        const version = emailOf(item)?.sourceVersion;
        return version ? [version] : [];
      }),
    );
    if (
      [...added.values()].some((labels) => labels.includes('DRAFT')) ||
      changes.some((change) => [...change.add, ...change.remove].includes('DRAFT')) ||
      ids.some((id) => draftMessages.has(id))
    )
      draftsChanged = true;
    const gone: string[] = [];
    const relabel: SourceItem[] = [];
    const fetch: string[] = [];
    // Fetched only to be kept if it is from the window (a message taken out of Trash).
    const restored = new Set<string>();
    for (const id of ids) {
      const item = held.get(id);
      if (deleted.has(id)) {
        if (item) gone.push(id);
        continue;
      }
      const detail = item ? emailOf(item) : null;
      let labelIds = detail ? detail.labels.map((label) => label.id) : [...(added.get(id) ?? [])];
      let untrashed = false;
      for (const change of changes) {
        if (change.id !== id) continue;
        labelIds = [
          ...labelIds.filter((label) => !change.remove.includes(label)),
          ...change.add.filter((label) => !labelIds.includes(label)),
        ];
        if (change.remove.some((label) => HIDDEN.has(label))) untrashed = true;
      }
      if (labelIds.some((label) => GONE.has(label))) {
        if (item) gone.push(id);
        continue;
      }
      if (item && detail) {
        const names = await labelNames();
        const next = relabelled(detail, labelIds, names, versions.get(id));
        if (!sameJson(next, detail)) relabel.push(relabelledItem(item, next));
      } else if (!item && added.has(id) && !labelIds.some((label) => SKIPPED.has(label))) {
        fetch.push(id);
      } else if (!item && untrashed && !labelIds.some((label) => SKIPPED.has(label))) {
        fetch.push(id);
        restored.add(id);
      } else if (
        !item &&
        changes.some((change) => change.id === id && change.remove.includes('DRAFT')) &&
        !labelIds.some((label) => SKIPPED.has(label))
      ) {
        // A draft sent in Gmail: the message it became.
        fetch.push(id);
      }
    }
    if (relabel.length || gone.length) request.save({ items: relabel, deleted: gone });
    if (fetch.length) {
      await fetchAndSave(fetch, (item) => {
        if (!restored.has(item.externalId)) return true;
        return item.detail?.kind === 'email' && item.detail.sentAt >= cursor.windowStart;
      });
    }
    return next;
  }

  return { download, history, heldIds, drafts, draftsChanged: () => draftsChanged };
}

// ---------------------------------------------------------------------------------------------
// Writes (#135)

// The Gmail label behind each flag field, and whether the field is true when the label is on.
const FLAG_FIELDS: Record<string, { label: string; on: boolean }> = {
  inbox: { label: 'INBOX', on: true },
  read: { label: 'UNREAD', on: false },
  starred: { label: 'STARRED', on: true },
  trash: { label: 'TRASH', on: true },
};
const LABEL_PREFIX = 'label:';

// What a change asks of Gmail: the label it is about, and whether that label should be on.
function wantOf(change: FieldChange): { label: string; on: boolean } {
  const flag = FLAG_FIELDS[change.field];
  if (flag) {
    if (typeof change.value !== 'boolean') throw new WriteRejected('That isn’t a change Gmail takes.');
    return { label: flag.label, on: change.value === flag.on };
  }
  if (change.field.startsWith(LABEL_PREFIX) && change.field.length > LABEL_PREFIX.length) {
    const label = change.field.slice(LABEL_PREFIX.length);
    const value = change.value as EmailLabel | null;
    if (value !== null && value?.id !== label) throw new WriteRejected('That isn’t a label Gmail knows.');
    return { label, on: value !== null };
  }
  throw new WriteRejected('Commander can’t change that in Gmail.');
}

// The labels Gmail changed on the message since `since` (a historyId), read from its history up to
// the message's own latest change. Empty when Gmail's history no longer reaches back that far.
async function labelsChangedSince(
  gmail: GmailClient,
  messageId: string,
  since: string,
  upTo: string,
): Promise<Set<string>> {
  const changed = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const page = await gmail.get(
        'history',
        `/history${query({ startHistoryId: since, maxResults: String(PAGE_SIZE), historyTypes: LABEL_HISTORY, pageToken })}`,
        gmailHistory,
      );
      for (const record of page.history ?? []) {
        for (const each of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])])
          if (each.message.id === messageId) for (const label of each.labelIds ?? []) changed.add(label);
      }
      const last = page.history?.at(-1)?.id;
      // Past the message's own latest change, nothing more about it can come.
      if (last && BigInt(last) >= BigInt(upTo)) break;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof CursorExpired) return new Set();
    throw error;
  }
  return changed;
}

async function writeMessage(gmail: GmailClient, request: WriteRequest, now: () => number) {
  const id = request.externalId;
  const path = `/messages/${encodeURIComponent(id)}`;
  const wants = request.changes.map((change) => ({ change, ...wantOf(change) }));
  const [stored] = request.stored?.([id]) ?? [];
  const held = stored ? emailOf(stored) : null;

  const peek = () => gmail.get('peek', `${path}?format=minimal`, gmailMessageLabels);
  const current = await peek();
  const labels = new Set(current.labelIds ?? []);
  // What Gmail changed since Commander last saw the message, when it has changed since.
  const since = held?.sourceVersion;
  const changedInGmail =
    since && current.historyId && current.historyId !== since
      ? await labelsChangedSince(gmail, id, since, current.historyId)
      : new Set<string>();

  const superseded: Superseded[] = [];
  let trash: boolean | null = null;
  const add: string[] = [];
  const remove: string[] = [];
  for (const { change, label, on } of wants) {
    if (labels.has(label) === on) continue;
    if (changedInGmail.has(label)) {
      superseded.push({ field: change.field, by: null, at: now() });
      continue;
    }
    if (label === 'TRASH') trash = on;
    else (on ? add : remove).push(label);
  }

  let answer: GmailMessageLabels = current;
  if (trash !== null) {
    const call = trash ? 'trash' : 'untrash';
    answer = await gmail.get(call, `${path}/${call}`, gmailMessageLabels, {});
  }
  if (add.length || remove.length) {
    answer = await gmail.get('modify', `${path}/modify`, gmailMessageLabels, {
      body: { addLabelIds: add, removeLabelIds: remove },
    });
  }
  // The history the write left the message at, so the next write measures Gmail's changes from there.
  if (answer !== current && !answer.historyId) answer = await peek();

  if (!stored || !held) return { item: null, superseded };
  const names = new Map<string, string>(held.labels.map((label) => [label.id, label.name]));
  for (const { change, label } of wants) {
    const value = change.value as EmailLabel | null;
    if (change.field.startsWith(LABEL_PREFIX) && value?.name) names.set(label, value.name);
  }
  const detail = relabelled(held, answer.labelIds ?? [], names, answer.historyId ?? null);
  return { item: relabelledItem(stored, detail), superseded };
}
