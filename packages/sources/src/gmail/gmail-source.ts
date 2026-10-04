import { type EmailDetail, emailStatus, type SourceItem } from '@commander/domain';
import { z } from 'zod';
import {
  type Cadence,
  CursorExpired,
  type PartRequest,
  type SourceAdapter,
  type StoredItem,
  type SyncRequest,
} from '../source';
import { connectGmail, createPacer, type GmailClient, MessageGone, type Pacer } from './client';
import { labelName, readGmailMessage } from './message';
import { fetchGmailPart } from './parts';
import {
  type GmailHistory,
  gmailHistory,
  gmailLabels,
  gmailMessage,
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
// Never downloaded; a message that gains Spam or Trash is gone as far as Commander is concerned.
const SKIPPED = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);
const GONE = new Set(['SPAM', 'TRASH']);
const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];

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

/** The detail with these Gmail labels: read, starred, inbox and sent follow them. */
function relabelled(
  detail: EmailDetail,
  labelIds: readonly string[],
  names: ReadonlyMap<string, string>,
): EmailDetail {
  // Labels it had keep their place, so an unchanged set compares equal.
  const had = detail.labels.map((label) => label.id).filter((id) => labelIds.includes(id));
  const ordered = [...had, ...labelIds.filter((id) => !had.includes(id))];
  return {
    ...detail,
    labels: ordered.map(
      (id) => detail.labels.find((label) => label.id === id) ?? { id, name: labelName(id, names) },
    ),
    read: !ordered.includes('UNREAD'),
    starred: ordered.includes('STARRED'),
    inInbox: ordered.includes('INBOX'),
    sentByMe: ordered.includes('SENT'),
  };
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
  // Each Account's quota is paced across its syncs (and the reader's part fetches).
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
    }
    return labels;
  }

  const heldIds = () => request.heldIds?.() ?? [];
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
        if ((message.labelIds ?? []).some((label) => SKIPPED.has(label))) continue;
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
        const next = relabelled(detail, [...(withLabel.get(item.externalId) ?? [])], names);
        if (!sameJson(next, detail)) changed.push(relabelledItem(item, next));
      }
      // Held messages from the window that Gmail no longer lists were deleted, or moved to Trash or Spam.
      const listedIds = new Set(listed);
      const gone = [...storedById(heldIds().filter((id) => !listedIds.has(id))).values()]
        .filter((item) => (emailOf(item)?.sentAt ?? 0) >= windowStart)
        .map((item) => item.externalId);
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
    for (const record of records) {
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
        if (change.remove.some((label) => GONE.has(label))) untrashed = true;
      }
      if (labelIds.some((label) => GONE.has(label))) {
        if (item) gone.push(id);
        continue;
      }
      if (item && detail) {
        const names = await labelNames();
        const next = relabelled(detail, labelIds, names);
        if (!sameJson(next, detail)) relabel.push(relabelledItem(item, next));
      } else if (!item && added.has(id) && !labelIds.some((label) => SKIPPED.has(label))) {
        fetch.push(id);
      } else if (!item && untrashed && !labelIds.some((label) => SKIPPED.has(label))) {
        fetch.push(id);
        restored.add(id);
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

  return { download, history, heldIds };
}
