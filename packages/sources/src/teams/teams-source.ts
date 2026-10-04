import type { ChatMember, ChatMessage, SourceItem } from '@commander/domain';
import { z } from 'zod';
import type { Cadence, SourceAdapter, StoredItem, SyncRequest, WriteRequest } from '../source';
import { ChatUnreadable, connectGraph, type Graph } from './graph';
import {
  chatsPage,
  type GraphChat,
  membersPage,
  mergeMessages,
  messagesPage,
  toChatItem,
  toMember,
  toMessage,
} from './shapes';
import { writeChat } from './write';

// Microsoft Teams as a Source: the User's Chats (one-to-one, group and meeting) through Microsoft
// Graph v1.0 over fetch, each Chat a `chat` Item with its recent messages. Graph has no delegated
// delta and no push for a desktop app, so Commander polls, as cheaply as it can (decisions #33, #34):
//
// - The check (every sync): page through `GET /me/chats?$expand=lastMessagePreview`. A Chat whose
//   last message, or `lastUpdatedDateTime` (renamed, members changed), is newer than the cursor has
//   changed; one whose read state or hidden flag changed is saved again without another request.
//   Chats no longer listed (left or deleted) become tombstones. Chats the User excluded from
//   Commander are skipped entirely.
// - Messages only for changed Chats: `GET /chats/{id}/messages` newest-modified first, filtered on
//   `lastModifiedDateTime` after the newest change already seen there, paged until done. Members
//   (`GET /chats/{id}/members`) only for new Chats and those whose members or name changed.
// - First sync: every Chat, plus messages from the last 30 days for Chats active in that time (the
//   newest 200 per Chat). Older history is not fetched.
// - A full sync (the daily cadence) also re-reads messages from Chats active in the last 7 days, as
//   the last-message preview misses edits, deletions and reactions in quiet Chats. A light sync
//   (refresh, and the check after every other Source's sync) never does.
// - At most one request a second per Chat; 429s, and 503s with Retry-After, stop the sync at once.
//
// Two-way sync (#106, write.ts): replies to a Chat and its read state go back to Teams, one Chat's
// queued changes at a time, each request given up after 30 seconds so a stuck answer can't hold up
// the Account's queue (a reply's retry then checks whether it got through before posting again).

// Microsoft asks apps to poll Teams about once a day: a full sync daily, plus light checks.
export const TEAMS_CADENCE: Cadence = { defaultMinutes: 1440, choices: [1440], alsoAfterOtherSources: true };

export type TeamsSourceOptions = {
  // Graph's base; read per sync, so the end-to-end tests can point it at a fake.
  graphUrl: () => string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  // The most messages kept per Chat, newest first.
  messagesPerChat?: number;
};

const DAY_MS = 24 * 60 * 60_000;
const FIRST_SYNC_DAYS = 30;
const REREAD_DAYS = 7;
const PAGE_SIZE = 50;
// A write's request that takes longer than this is given up on (its outcome unknown).
export const WRITE_TIMEOUT_MS = 30_000;
// Chats saved together.
const SAVE_BATCH = 25;

// What the cursor remembers of each Chat, to tell what changed: its `lastUpdatedDateTime`, its last
// message (time and id), the User's read time and hidden flag, and the newest message change seen.
const chatMark = z.object({
  updated: z.number(),
  last: z.number().nullable(),
  lastId: z.string().nullable(),
  read: z.number().nullable(),
  hidden: z.boolean(),
  seen: z.number(),
});
export type ChatMark = z.infer<typeof chatMark>;
const teamsCursor = z.object({ chats: z.record(z.string(), chatMark) });
export type TeamsCursor = z.infer<typeof teamsCursor>;

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

const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

function markOf(chat: GraphChat, seen: number): ChatMark {
  return {
    updated: Date.parse(chat.lastUpdatedDateTime),
    last: at(chat.lastMessagePreview?.createdDateTime),
    lastId: chat.lastMessagePreview?.id ?? null,
    read: at(chat.viewpoint?.lastMessageReadDateTime),
    hidden: chat.viewpoint?.isHidden ?? false,
    seen,
  };
}

// When the Chat was last active: its last message, or else its last rename or member change.
const activeAt = (chat: GraphChat) =>
  at(chat.lastMessagePreview?.createdDateTime) ?? Date.parse(chat.lastUpdatedDateTime);

const encode = (chatId: string) => encodeURIComponent(chatId);
const iso = (time: number) => new Date(time).toISOString();

// What one sync does for one Chat.
type Plan = {
  chat: GraphChat;
  stored: StoredItem | null;
  members: boolean;
  // Messages modified after this time, or null for none.
  since: number | null;
  seen: number;
};

export function createTeamsSource({
  graphUrl,
  fetch = globalThis.fetch,
  now = Date.now,
  sleep = sleepFor,
  messagesPerChat = 200,
}: TeamsSourceOptions): SourceAdapter {
  async function chatMessages(graph: Graph, chatId: string, since: number): Promise<ChatMessage[]> {
    const orderby = encodeURIComponent('lastModifiedDateTime desc');
    const filter = encodeURIComponent(`lastModifiedDateTime gt ${iso(since)}`);
    const path = `/chats/${encode(chatId)}/messages?$top=${PAGE_SIZE}&$orderby=${orderby}&$filter=${filter}`;
    const found = await graph.all(path, messagesPage, {
      chatId,
      enough: (sofar) => sofar.length >= messagesPerChat,
    });
    return found.slice(0, messagesPerChat).map(toMessage);
  }

  return {
    source: 'teams',
    cadence: TEAMS_CADENCE,

    async sync(request: SyncRequest) {
      const graph = connectGraph({
        graphUrl: graphUrl(),
        fetch,
        now,
        sleep,
        accessToken: request.accessToken,
        signal: request.signal,
      });
      const me = request.me ?? null;
      const started = now();
      const previous = teamsCursor.safeParse(request.cursor);
      const marks: Record<string, ChatMark> = previous.success ? previous.data.chats : {};
      const excluded = new Set(request.excluded ?? []);

      // The check: every Chat the User is in.
      const chats = await graph.all(`/me/chats?$expand=lastMessagePreview&$top=${PAGE_SIZE}`, chatsPage);
      const listed = new Set(chats.map((chat) => chat.id));
      const stored = new Map(
        (request.stored?.(chats.filter((chat) => marks[chat.id]).map((chat) => chat.id)) ?? []).map(
          (item) => [item.externalId, item],
        ),
      );

      const firstWindow = started - FIRST_SYNC_DAYS * DAY_MS;
      const rereadWindow = started - REREAD_DAYS * DAY_MS;
      const plans: Plan[] = [];
      const next: Record<string, ChatMark> = {};
      for (const chat of chats) {
        // Excluded by the User: nothing fetched, nothing handed over, and its mark forgotten, so
        // including it again brings it back as a new Chat.
        if (excluded.has(chat.id)) continue;
        const mark = marks[chat.id];
        const kept = stored.get(chat.id) ?? null;
        const known = mark && kept?.detail?.kind === 'chat' ? kept : null;
        if (!mark || !known) {
          // New to Commander: its members, and its last 30 days if it was active in them.
          const active = activeAt(chat) > firstWindow;
          plans.push({
            chat,
            stored: null,
            members: true,
            since: active ? firstWindow : null,
            seen: firstWindow,
          });
          continue;
        }
        const current = markOf(chat, mark.seen);
        const renamed = current.updated > mark.updated;
        const newMessage = current.lastId !== mark.lastId || (current.last ?? 0) > (mark.last ?? 0);
        const viewChanged = current.read !== mark.read || current.hidden !== mark.hidden;
        const reread = request.mode === 'full' && activeAt(chat) > rereadWindow;
        const since = [newMessage ? mark.seen : null, reread ? Math.min(mark.seen, rereadWindow) : null]
          .filter((time): time is number => time !== null)
          .reduce<number | null>((a, b) => (a === null ? b : Math.min(a, b)), null);
        if (!renamed && since === null && !viewChanged) {
          next[chat.id] = mark;
          continue;
        }
        plans.push({ chat, stored: known, members: renamed, since, seen: mark.seen });
      }

      // Members first, then messages, so one Chat's requests are spread out.
      const members = new Map<string, ChatMember[]>();
      for (const plan of plans) {
        if (!plan.members) continue;
        try {
          const found = await graph.all(`/chats/${encode(plan.chat.id)}/members`, membersPage, {
            chatId: plan.chat.id,
          });
          members.set(plan.chat.id, found.map(toMember));
        } catch (error) {
          if (!(error instanceof ChatUnreadable)) throw error;
        }
      }

      let batch: SourceItem[] = [];
      const flush = () => {
        if (batch.length) request.save({ items: batch, deleted: [] });
        batch = [];
      };
      for (const plan of plans) {
        const { chat } = plan;
        const before = plan.stored?.detail?.kind === 'chat' ? plan.stored.detail : null;
        let fetched: ChatMessage[] = [];
        if (plan.since !== null) {
          try {
            fetched = await chatMessages(graph, chat.id, plan.since);
          } catch (error) {
            if (!(error instanceof ChatUnreadable)) throw error;
          }
        }
        const seen = fetched.reduce((newest, message) => Math.max(newest, message.modifiedAt), plan.seen);
        const messages = mergeMessages(before?.messages ?? [], fetched, messagesPerChat);
        const people = members.get(chat.id) ?? before?.members ?? [];
        batch.push(toChatItem(chat, people, messages, me));
        next[chat.id] = markOf(chat, seen);
        if (batch.length >= SAVE_BATCH) flush();
      }
      flush();

      const left = Object.keys(marks).filter((id) => !listed.has(id));
      if (left.length) request.save({ items: [], deleted: left });

      const cursor: TeamsCursor = { chats: next };
      return { cursor, cost: graph.cost };
    },

    async write(request: WriteRequest) {
      const graph = connectGraph({
        graphUrl: graphUrl(),
        fetch,
        now,
        sleep,
        accessToken: request.accessToken,
        signal: request.signal,
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      const result = await writeChat(graph, request, messagesPerChat);
      return { ...result, cost: graph.cost };
    },
  };
}
