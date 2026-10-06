// Ares keeps an eye on Teams for the Update (#109): busy Chats, found whenever the producers look
// (after every sync, whenever the gate acts, and every minute).
//
// - A busy Chat is an unmuted one with at least `busyChatThreshold` messages from others (20 unless
//   Settings → Ares says otherwise) since the last Update, or since the User last dealt with its line
//   if that was later (the last day, before any Update). It queues one For your information line,
//   merged per Chat: the count goes up as more arrive, and it opens the Chat.
// - Ares summarises it when the Update is put together, never ahead of time (`summaries`, with
//   agent/summarise-chat.ts); the line then reads "“Titanlink eng” in Teams: 46 messages since your
//   last Update. They settled on shipping Friday, and Omar wants your sign-off." His summary is
//   checked against the Chat's messages like any Update line (grounding.ts): a name, number or date
//   they don't hold, and the line keeps its plain sentence (kinds/teams.ts), as it does when he
//   can't summarise it at all.
// - A Chat muted, excluded or deleted since leaves the queue (resolved). Muted Chats never queue.
import {
  busyChatThreshold,
  type ChatDetail,
  fromOthersSince,
  type Item,
  isSpoken,
  mutedChatIds,
  type QueuedLine,
} from '@commander/domain';
import type { ModelClient } from '@commander/models';
import { summariseForUpdate } from '../agent/summarise-chat';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { checkGrounded } from './grounding';
import type { UpdateQueue } from './queue';

export const chatSummaryKey = (itemId: string) => `chat-summary:${itemId}`;
const DAY = 24 * 3_600_000;
const IMPORTANCE = 0.3;
const TIMEOUT_MS = 45_000;

type Chat = Item & { detail: ChatDetail };
const isChat = (item: Item | undefined): item is Chat =>
  item?.kind === 'chat' && item.detail?.kind === 'chat' && item.deletedAt === null;
type SummaryLine = QueuedLine & { about: Extract<QueuedLine['about'], { kind: 'chat-summary' }> };
const isSummaryLine = (line: QueuedLine): line is SummaryLine => line.about.kind === 'chat-summary';

export function createTeamsWatch({
  itemStore,
  queue,
  now,
  me = () => null,
}: {
  itemStore: ItemStore;
  queue: UpdateQueue;
  now: () => number;
  me?: (account: string) => string | null;
}) {
  const store = itemStore.updates;
  const whoAmI = (chat: Chat) => (chat.account ? me(chat.account) : null);

  function sweep() {
    const chats = itemStore
      .query({ kinds: ['chat'], statuses: ['open'], limit: 1000 })
      .filter((item): item is Chat => isChat(item));
    const muted = mutedChatIds(chats, itemStore.chatSettings.list());
    const live = new Map(chats.filter((chat) => !muted.has(chat.id)).map((chat) => [chat.id, chat]));
    const threshold = busyChatThreshold(itemStore.models.settings());

    // Lines queued already: gone or muted Chats leave; the rest take the newer count.
    const queued = new Set<string>();
    for (const line of store.lines(['queued']).filter(isSummaryLine)) {
      const chat = live.get(line.about.itemId);
      if (!chat) {
        queue.resolve(line.id);
        continue;
      }
      queued.add(chat.id);
      const count = fromOthersSince(chat.detail, whoAmI(chat), line.about.since).length;
      if (count > line.about.count)
        queue.revise(line.id, { about: { ...line.about, count }, itemIds: line.itemIds });
    }

    const at = now();
    const lastGivenAt = store.state().lastGivenAt;
    for (const chat of live.values()) {
      if (queued.has(chat.id)) continue;
      const mergeKey = chatSummaryKey(chat.id);
      const dealt = store.lastWithKey(mergeKey)?.settledAt ?? 0;
      const since = Math.max(lastGivenAt ?? at - DAY, dealt);
      const count = fromOthersSince(chat.detail, whoAmI(chat), since).length;
      if (count < threshold) continue;
      queue.enqueue({
        group: 'fyi',
        mergeKey,
        about: { kind: 'chat-summary', itemId: chat.id, count, since },
        itemIds: [chat.id],
        section: 'teams',
        importance: IMPORTANCE,
      });
    }
  }

  return { sweep };
}

/**
 * Ares's sentences on the busy Chats among these lines, made now (the Update is being put together):
 * "Titanlink eng: 46 messages. They settled on…". One Deep call per Chat, side by side; a Chat he
 * can't summarise keeps its plain sentence (left out here).
 */
export async function summaries(
  lines: readonly QueuedLine[],
  {
    itemStore,
    client,
    now,
    me,
    secrets,
    onItemsChanged,
    log,
    timeoutMs = TIMEOUT_MS,
  }: {
    itemStore: ItemStore;
    client: ModelClient;
    now: () => number;
    me?: (account: string) => string | null;
    secrets?: KnownSecrets;
    onItemsChanged?: (itemIds: string[]) => void;
    log: (message: string) => void;
    timeoutMs?: number;
  },
): Promise<Map<number, string>> {
  const written = new Map<number, string>();
  const busy = lines.filter(isSummaryLine);
  if (!busy.length) return written;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await Promise.all(
      busy.map(async (line) => {
        const chat = itemStore.get(line.about.itemId)?.item;
        if (!isChat(chat)) return;
        const messages = chat.detail.messages
          .filter((message) => isSpoken(message) && message.createdAt > line.about.since)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (!messages.length) return;
        try {
          const summary = await summariseForUpdate(chat, messages, {
            client,
            now,
            me,
            secrets,
            injectionWarnings: itemStore.injectionWarnings,
            onItemsChanged,
            signal: controller.signal,
          });
          // What the summary may rest on: the Chat's name, the count, and its messages and who sent them.
          const handed = [
            chat.title,
            `${line.about.count} messages`,
            ...messages.map((message) => `${message.from?.name ?? ''}: ${message.text}`),
          ].join('\n');
          const grounded = checkGrounded(summary, handed);
          if (!grounded.ok) {
            log(`Summarise Chat kept the plain sentence: Ares’s summary had ${grounded.why}`);
            return;
          }
          const count = `${line.about.count} message${line.about.count === 1 ? '' : 's'}`;
          written.set(
            line.id,
            `“${oneLine(chat.title)}” in Teams: ${count} since your last Update. ${summary}`,
          );
        } catch (error) {
          log(`Summarise Chat kept the plain sentence: ${error instanceof Error ? error.message : error}`);
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
  return written;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
