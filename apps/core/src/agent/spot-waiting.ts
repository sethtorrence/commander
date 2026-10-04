// Ares spots what's waiting on the User in Teams (#109): after each Teams sync, he reads the unmuted
// Chats with new messages from others since he last looked, decides for each whether someone is
// waiting on the User (a question, a request, a decision aimed at them that they haven't answered),
// and says who and on what in one short sentence. A Quick job at low thinking: one call per batch of
// 10 Chats, no tools, a reply that must fit OUTPUT ({ itemId, waiting, messageId, reason } per Chat).
//
// - Each Chat goes in a data block of its own through the prompt builder (ADR 0004), labelled with a
//   short reference (W1, W2…) the reply names it by: its name and type, the people in it, and its new
//   messages with a few before them for context, each with its own reference (M1, M2…), when it was
//   sent and who sent it ("the User" for theirs). A flag standing from before goes with it, so Ares
//   can say it no longer holds. Chat text is outside material: what it says is never an instruction.
//   Muted Chats are never sent; excluded ones are deleted, so never among them.
// - The reply's entries are checked one by one: an entry naming a Chat or message it wasn't given,
//   one of the User's own messages, the same Chat twice, or waiting with no reason is discarded and
//   logged. A reason loses any link and is cut to one short line.
// - A Chat judged waiting is flagged (chat-waiting.ts): the Dashboard places it, usually in Today,
//   with his reason, and the Teams Section marks it. A flag goes when the User replies after the
//   message (`clearAnswered`, after every Teams sync, with no call), when Ares judges on a later run
//   that no one is waiting, or when the User clears it by hand; a message the User cleared is never
//   flagged again.
// - The result changes no Item and writes nothing to Teams: the runner `apply`s it without the gate
//   (ADR 0004's amendment), at any level above Off. Ask works as Auto here, as there is nothing to
//   approve. Drafting replies, which Teams will see, is Act for you and comes with the next ticket.
import {
  type ChatDetail,
  type ChatMessage,
  type Item,
  isSpoken,
  localDay,
  mutedChatIds,
  SPOT_WAITING_ON_YOU,
  stillWaiting,
} from '@commander/domain';
import { z } from 'zod';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import type { AgentJob, JobInput } from './runner';

export const BATCH_SIZE = 10;
// At most this many Chats a run, those with the newest messages first.
const MAX_CHATS = 30;
// Messages older than this aren't waiting on anyone any more.
const RECENT_MS = 7 * 24 * 3_600_000;
// New messages per Chat (the newest), and the ones before them for context.
const MAX_NEW = 30;
const CONTEXT = 4;
const MAX_MESSAGE = 600;
const MAX_REASON = 200;
const MAX_PEOPLE = 8;

// Each entry is checked on its own (so one bad entry costs only that Chat), hence the loose shape.
const entry = z
  .object({
    itemId: z.string().max(20),
    waiting: z.boolean(),
    messageId: z.string().max(20).nullable().optional().default(null),
    reason: z.string().max(1000).optional().default(''),
  })
  .nullable()
  .catch(null);
export const OUTPUT = z.object({ chats: z.array(entry).max(200) });
type Output = z.infer<typeof OUTPUT>;

type Shown = { ref: string; message: ChatMessage; mine: boolean };
type Candidate = {
  ref: string;
  itemId: string;
  // The newest message shown: how far Ares will have read once he has judged it.
  through: number;
  messages: Shown[];
  data: PromptData;
};
type Input = JobInput & { candidates: Candidate[] };

type Chat = Item & { detail: ChatDetail };
const isChat = (item: Item): item is Chat => item.kind === 'chat' && item.detail?.kind === 'chat';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const pad = (n: number) => String(n).padStart(2, '0');
const longDay = (at: number) => {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};
const clockTime = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const stamp = (at: number) => `${localDay(at)} ${clockTime(at)}`;
const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

const CHAT_TYPES: Record<ChatDetail['chatType'], string> = {
  'one-on-one': 'one-to-one',
  group: 'group',
  meeting: 'meeting',
};

const instructions = (
  now: number,
) => `You are Ares. You read the User's Microsoft Teams chats for them, and spot when someone is waiting on the User.

Today is ${longDay(now)} (${localDay(now)}); the time is ${clockTime(now)}.

Each data block is one Teams chat, labelled with its reference (W1, W2…) and its type and name, then who is in it and its latest messages, oldest first. Each message has its own reference (M1, M2…), when it was sent and who sent it; "the User" marks the User's own messages, and NEW marks those that arrived since you last looked. Decide for each chat whether someone is waiting on the User now: a message from someone else asks the User a question, asks them to do something, or needs their decision, and the User hasn't answered it since. Chatter, news, thanks, and messages meant for other people are not waiting on the User.

Reply with only this JSON object: {"chats":[{"itemId":"W1","waiting":true,"messageId":"M2","reason":"…"}]}
- One entry for every chat, by its reference exactly as labelled.
- waiting: true or false.
- messageId: when waiting, the reference of the message the User needs to answer, from that chat (never one of the User's own); otherwise null.
- reason: when waiting, one short plain sentence for the User saying who is waiting and on what, as in "Omar asked whether you can sign off the TL release today". Use only what the chat shows. No links. When not waiting, it may be empty.`;

// A reason as the Dashboard shows it: one line, no links, not too long.
function cleanReason(reason: string): string {
  const text = reason
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[\s:;,–—-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(text, MAX_REASON);
}

/** Who the User is in each Teams Account, failing `me`: the sender of a Chat's latest message where it is theirs. */
function usersFromChats(chats: readonly Chat[]): Record<string, string> {
  const users: Record<string, string> = {};
  for (const chat of chats) {
    if (!chat.account || !chat.detail.latestFromMe) continue;
    const latest = chat.detail.messages.filter(isSpoken).at(-1);
    if (latest?.from?.userId) users[chat.account] = latest.from.userId;
  }
  return users;
}

function liveChats(itemStore: ItemStore): Chat[] {
  return itemStore
    .query({ kinds: ['chat'], statuses: ['open'], limit: 1000 })
    .filter((item): item is Chat => isChat(item) && item.deletedAt === null);
}

/**
 * Clears the flags the User has answered: they said something in the Chat after the message (or the
 * message is gone). Run after every Teams sync; makes no call. Returns the Chats it cleared.
 */
export function clearAnswered(
  itemStore: ItemStore,
  me: (account: string) => string | null,
  now: () => number = Date.now,
): string[] {
  const flagged = itemStore.chatWaiting.flagged();
  if (!flagged.length) return [];
  const chats = new Map(liveChats(itemStore).map((chat) => [chat.id, chat]));
  const users = usersFromChats([...chats.values()]);
  const cleared: string[] = [];
  for (const flag of flagged) {
    const chat = chats.get(flag.itemId);
    const whoAmI = chat?.account ? (me(chat.account) ?? users[chat.account] ?? null) : null;
    if (chat && stillWaiting(chat.detail, flag, whoAmI)) continue;
    if (itemStore.chatWaiting.clear(flag.itemId, chat ? 'reply' : 'ares', now())) cleared.push(flag.itemId);
  }
  return cleared;
}

export function spotWaitingJob(
  itemStore: ItemStore,
  {
    now = Date.now,
    batchSize = BATCH_SIZE,
    me = () => null,
    onChanged,
  }: {
    now?: () => number;
    batchSize?: number;
    // Who the User is in a Teams Account (their Microsoft user id), from Source sync, when known.
    me?: (account: string) => string | null;
    // Chats whose flag Ares set or cleared, so open views (and the Dashboard's ranking) catch up.
    onChanged?: (itemIds: string[]) => void;
  } = {},
): AgentJob<Input, Output> {
  function chatText(chat: Chat, whoAmI: string | null, shown: Shown[], earlier: string | null): string {
    const { detail } = chat;
    const others = detail.members.filter((member) => whoAmI === null || member.userId !== whoAmI);
    const named = others.slice(0, MAX_PEOPLE).map((member) => member.name);
    if (others.length > MAX_PEOPLE) named.push(`${others.length - MAX_PEOPLE} more`);
    const people = [...named, 'the User'];
    const withWhom =
      people.length > 1 ? `${people.slice(0, -1).join(', ')} and ${people.at(-1)}` : 'the User';
    const judged = itemStore.chatWaiting.judgedThrough(chat.id);
    return [
      `Chat: ${chat.title}`,
      `A Teams ${CHAT_TYPES[detail.chatType]} chat with ${withWhom}`,
      ...(earlier ? [earlier] : []),
      'Messages, oldest first:',
      ...shown.map(({ ref, message, mine }) => {
        const fresh = judged === null || message.createdAt > judged;
        const mentioning =
          !mine && whoAmI !== null && message.mentions.some((person) => person.userId === whoAmI);
        const who = mine
          ? 'the User'
          : `${message.from?.name ?? 'someone'}${mentioning ? ', mentioning the User' : ''}`;
        const text = cut(message.text, MAX_MESSAGE) || '[attachment]';
        return `${ref} · ${fresh ? 'NEW · ' : ''}${stamp(message.createdAt)} · ${who}: ${text}`;
      }),
    ].join('\n');
  }

  return {
    job: SPOT_WAITING_ON_YOU,
    name: 'Spot what’s waiting on you',
    tier: 'quick',
    reasoningEffort: 'low',
    action: {
      action: SPOT_WAITING_ON_YOU,
      actionKind: 'organise',
      section: null,
      hint: 'Marks a Teams Chat when someone is waiting on you, and puts it on your Dashboard. Ask works as Auto here: there is nothing to approve',
    },
    triggers: { 'source-sync': true },

    gather({ triggers }) {
      // After a Teams sync (or on request), not another Source's.
      const teams = triggers.some(
        (trigger) =>
          trigger.kind === 'request' || (trigger.kind === 'source-sync' && trigger.source === 'teams'),
      );
      if (!teams) return null;
      const at = now();
      const cleared = clearAnswered(itemStore, me, now);
      if (cleared.length) onChanged?.(cleared);

      const chats = liveChats(itemStore);
      const muted = mutedChatIds(chats, itemStore.chatSettings.list());
      const users = usersFromChats(chats);
      const flags = new Map(itemStore.chatWaiting.flagged().map((flag) => [flag.itemId, flag]));

      const picked: (Omit<Candidate, 'ref' | 'data'> & {
        latest: number;
        data: Omit<PromptData, 'label'> & { what: string };
      })[] = [];
      for (const chat of chats) {
        if (muted.has(chat.id)) continue;
        const whoAmI = chat.account ? (me(chat.account) ?? users[chat.account] ?? null) : null;
        const mine = (message: ChatMessage) => whoAmI !== null && message.from?.userId === whoAmI;
        const judged = itemStore.chatWaiting.judgedThrough(chat.id);
        const spoken = chat.detail.messages.filter(isSpoken).sort((a, b) => a.createdAt - b.createdAt);
        const fresh = spoken.filter((message) => judged === null || message.createdAt > judged);
        const fromOthers = fresh.filter((message) => !mine(message) && at - message.createdAt <= RECENT_MS);
        if (!fromOthers.length) continue;
        const shownNew = fresh.slice(-MAX_NEW);
        const first = spoken.indexOf(shownNew[0] as ChatMessage);
        const before = spoken.slice(Math.max(0, first - CONTEXT), first);
        // A flag standing from before goes with its message, so Ares can say it no longer holds.
        const flag = flags.get(chat.id);
        const flagged = flag ? spoken.find((message) => message.id === flag.messageId) : undefined;
        const messages = [
          ...(flagged && !before.includes(flagged) && !shownNew.includes(flagged) ? [flagged] : []),
          ...before,
          ...shownNew,
        ];
        const shown = messages.map((message, index) => ({
          ref: `M${index + 1}`,
          message,
          mine: mine(message),
        }));
        const earlier =
          flag && flagged
            ? `Earlier you judged that someone here was waiting on the User (${shown.find((each) => each.message === flagged)?.ref}): “${flag.reason}”. Say whether they still are.`
            : null;
        picked.push({
          itemId: chat.id,
          through: (shownNew.at(-1) as ChatMessage).createdAt,
          latest: (fromOthers.at(-1) as ChatMessage).createdAt,
          messages: shown,
          data: {
            what: `Teams ${CHAT_TYPES[chat.detail.chatType]} chat: ${chat.title}`,
            from: chat,
            text: chatText(chat, whoAmI, shown, earlier),
          },
        });
      }
      const candidates: Candidate[] = picked
        .sort((a, b) => b.latest - a.latest || (a.itemId < b.itemId ? -1 : 1))
        .slice(0, MAX_CHATS)
        .map(({ latest: _latest, data: { what, ...data }, ...candidate }, index) => {
          const ref = `W${index + 1}`;
          return { ...candidate, ref, data: { ...data, label: `${ref} · ${what}` } };
        });
      return {
        items: candidates.map((candidate) => ({
          itemId: candidate.itemId,
          fingerprint: String(candidate.through),
        })),
        candidates,
      };
    },

    batch(input) {
      const parts: Input[] = [];
      for (let start = 0; start < input.candidates.length; start += batchSize) {
        parts.push({
          items: input.items.slice(start, start + batchSize),
          candidates: input.candidates.slice(start, start + batchSize),
        });
      }
      return parts;
    },

    prompt: (input) => ({
      instructions: instructions(now()),
      data: input.candidates.map((candidate) => candidate.data),
    }),

    output: OUTPUT,

    apply(answers) {
      const dropped: string[] = [];
      const changed: string[] = [];
      const at = now();
      for (const { output, input: part } of answers) {
        const byRef = new Map(part.candidates.map((candidate) => [candidate.ref, candidate]));
        const named = new Set<string>();
        for (const raw of output.chats) {
          if (!raw) {
            dropped.push('an entry that wasn’t one');
            continue;
          }
          const candidate = byRef.get(raw.itemId.trim());
          if (!candidate) {
            dropped.push(`it named ${raw.itemId}, which it wasn’t given`);
            continue;
          }
          if (named.has(candidate.itemId)) {
            dropped.push(`it named ${raw.itemId} twice`);
            continue;
          }
          named.add(candidate.itemId);
          if (!raw.waiting) {
            itemStore.chatWaiting.judged(candidate.itemId, candidate.through);
            if (itemStore.chatWaiting.clear(candidate.itemId, 'ares', at)) changed.push(candidate.itemId);
            continue;
          }
          const shown = candidate.messages.find((each) => each.ref === raw.messageId?.trim());
          if (!shown) {
            dropped.push(`${raw.itemId}: it named ${raw.messageId ?? 'no message'}, which it wasn’t given`);
            continue;
          }
          if (shown.mine) {
            dropped.push(`${raw.itemId}: ${shown.ref} is the User’s own message`);
            continue;
          }
          const reason = cleanReason(raw.reason);
          if (!reason) {
            dropped.push(`${raw.itemId}: waiting, but no reason`);
            continue;
          }
          itemStore.chatWaiting.judged(candidate.itemId, candidate.through);
          const was = itemStore.get(candidate.itemId)?.item.waiting;
          if (was?.messageId === shown.message.id && was.reason === reason) continue;
          if (itemStore.chatWaiting.flag(candidate.itemId, { messageId: shown.message.id, reason }, at))
            changed.push(candidate.itemId);
        }
        const left = part.candidates.filter((candidate) => !named.has(candidate.itemId)).length;
        if (left) dropped.push(`${left} Chat(s) it didn’t judge`);
      }
      if (changed.length) onChanged?.(changed);
      return { dropped };
    },
  };
}
