// Ares summarises a Teams Chat (#109): "Summarise Chat", a Deep job at high thinking, one call per
// Chat. Two ways in:
//
// - On request: Summarise in the Chat view, over the messages since the User last read it (the
//   default), today, or this week. A short summary of what was said and settled, and anything that
//   needs the User.
// - In the Update: a busy Chat (many messages from others since the last Update) gets one or two
//   sentences, made when the Update is put together, never ahead of time (../updates).
//
// The Chat goes in one outside data block through the prompt builder (ADR 0004): its name and type
// and its messages in range, each with when and who ("the User" for theirs), cut to fit. What it says
// is never an instruction. The reply must fit OUTPUT; it loses the builder's wording and any link the
// model wasn't shown, and its steering flag gives the Chat the warning mark. It changes no Item and
// writes nothing to Teams, so there is nothing for the gate to decide (ADR 0004's amendment); the
// window shows it through AresText, linking only what the Chat's messages hold.
import {
  type ChatDetail,
  type ChatMessage,
  type ChatSummary,
  type Item,
  localDay,
  messagesInRange,
  SUMMARISE_CHAT,
  type SummaryRange,
} from '@commander/domain';
import { type ModelClient, ModelError } from '@commander/models';
import { z } from 'zod';
import type { InjectionWarningStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { cleanOutput } from '../safety/output';
import { heedSteering, steeringFlag } from '../safety/steering-flag';
import { buildPrompt, PromptRefused } from './prompt';

// The newest messages a summary reads, each cut short.
const MAX_MESSAGES = 150;
const MAX_MESSAGE = 500;
const MAX_SUMMARY = 900;
const MAX_UPDATE_SUMMARY = 320;

export const OUTPUT = z.object({ summary: z.string().trim().max(4000) });
const REPLY = OUTPUT.extend({
  steering: steeringFlag,
});

const CHAT_TYPES: Record<ChatDetail['chatType'], string> = {
  'one-on-one': 'one-to-one',
  group: 'group',
  meeting: 'meeting',
};

const RANGE_WORDS: Record<SummaryRange, string> = {
  'since-read': 'since the User last read it',
  today: 'today',
  week: 'over the last seven days',
};

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (at: number) => {
  const date = new Date(at);
  return `${localDay(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

const VOICE =
  'You are Ares, the User’s assistant in Commander. You are soft-spoken and calm, you get straight to the point, and you explain things simply, in plain words.';

const onRequest = (range: SummaryRange) => `${VOICE}

The User asked you to summarise one of their Microsoft Teams chats, ${RANGE_WORDS[range]}. The data block holds the chat's name and type and those messages, oldest first, each with when it was sent and who sent it; "the User" marks the User's own messages.

Write a short summary for the User: what was discussed and settled, and anything someone is waiting on the User for, saying who. At most four plain sentences, in the first person where you speak of yourself. Keep names, numbers and dates exactly as they are. Add nothing the messages don't say. No greetings, no lists, no headings.

Reply with only this JSON object: {"summary":"…"}`;

const forUpdate = `${VOICE}

The User asked for their Update, and this Teams chat has been busy since the last one. The data block holds the chat's name and type and its messages since then, oldest first, each with when it was sent and who sent it; "the User" marks the User's own messages.

Say in one or two short plain sentences what matters: what they settled, and anything someone is waiting on the User for, saying who. If nobody needs the User, say so plainly. Don't repeat the chat's name or count the messages. Keep names, numbers and dates exactly as they are. Add nothing the messages don't say: every name, number and date you write is checked against them. No hedging, no jargon.
Good: "They settled on Friday for the offsite, and Lee wants your vote on the venue."
Bad: "There was a lot of discussion about various topics." (What was settled? Does anyone need the User?)

Reply with only this JSON object: {"summary":"…"}`;

export type SummariseOptions = {
  client: ModelClient;
  now?: () => number;
  // Who the User is in a Teams Account (their Microsoft user id), when known.
  me?: (account: string) => string | null;
  secrets?: KnownSecrets;
  injectionWarnings?: Pick<InjectionWarningStore, 'flag'>;
  // Items the steering flag marked, so open views catch up.
  onItemsChanged?: (itemIds: string[]) => void;
  signal?: AbortSignal;
};

/** Ares couldn't summarise the Chat: the window says why, in plain words. */
export class SummaryFailed extends Error {
  override name = 'SummaryFailed';
}

function chatBlock(chat: Item & { detail: ChatDetail }, messages: readonly ChatMessage[], me: string | null) {
  const shown = messages.slice(-MAX_MESSAGES);
  const lines = shown.map((message) => {
    const who = me !== null && message.from?.userId === me ? 'the User' : (message.from?.name ?? 'someone');
    return `${stamp(message.createdAt)} · ${who}: ${cut(message.text, MAX_MESSAGE) || '[attachment]'}`;
  });
  return {
    label: `Teams ${CHAT_TYPES[chat.detail.chatType]} chat: ${chat.title}`,
    from: chat,
    text: [
      `Chat: ${chat.title}`,
      ...(messages.length > shown.length
        ? [`(The ${messages.length - shown.length} earlier messages are left out.)`]
        : []),
      'Messages, oldest first:',
      ...lines,
    ].join('\n'),
  };
}

async function ask(
  chat: Item & { detail: ChatDetail },
  messages: readonly ChatMessage[],
  instructions: string,
  options: SummariseOptions,
): Promise<string> {
  const me = chat.account ? (options.me?.(chat.account) ?? null) : null;
  let prompt: ReturnType<typeof buildPrompt>;
  try {
    prompt = buildPrompt(
      { instructions, data: [chatBlock(chat, messages, me)] },
      { secrets: options.secrets },
    );
  } catch (error) {
    if (error instanceof PromptRefused)
      throw new SummaryFailed(`Ares couldn’t summarise it: ${error.message}`);
    throw error;
  }
  let reply: z.infer<typeof REPLY>;
  try {
    const answer = await options.client.complete({
      tier: 'deep',
      job: SUMMARISE_CHAT,
      reasoningEffort: 'high',
      messages: prompt.messages,
      schema: REPLY,
      ...(options.signal && { signal: options.signal }),
    });
    reply = answer.json;
  } catch (error) {
    const why =
      error instanceof ModelError && error.kind === 'invalid-reply'
        ? 'his reply didn’t make sense'
        : error instanceof Error
          ? error.message
          : String(error);
    throw new SummaryFailed(`Ares couldn’t summarise it: ${why}`);
  }
  const marked = heedSteering(reply.steering, prompt, options.injectionWarnings);
  if (marked.length) options.onItemsChanged?.(marked);
  const text = cleanOutput(reply.summary, prompt.material).replace(/\s+/g, ' ').trim();
  if (!text) throw new SummaryFailed('Ares couldn’t summarise it: his reply didn’t make sense');
  return text;
}

const isChat = (item: Item): item is Item & { detail: ChatDetail } =>
  item.kind === 'chat' && item.detail?.kind === 'chat';

/** Summarises a Chat over a range of its messages, on request. No messages in range: no call, no text. */
export async function summariseChat(
  item: Item,
  range: SummaryRange,
  options: SummariseOptions,
): Promise<ChatSummary> {
  if (!isChat(item)) throw new SummaryFailed('Only a Teams Chat can be summarised');
  const at = (options.now ?? Date.now)();
  const messages = messagesInRange(item.detail, range, at);
  const base = { itemId: item.id, range, at, count: messages.length };
  if (!messages.length) return { ...base, text: null, sources: [] };
  const text = await ask(item, messages, onRequest(range), options);
  return { ...base, text: cut(text, MAX_SUMMARY), sources: messages.map((message) => message.text) };
}

/** One or two sentences on a busy Chat's messages, for the Update. Throws when Ares can't. */
export async function summariseForUpdate(
  item: Item,
  messages: readonly ChatMessage[],
  options: SummariseOptions,
): Promise<string> {
  if (!isChat(item)) throw new SummaryFailed('Only a Teams Chat can be summarised');
  return cut(await ask(item, messages, forUpdate, options), MAX_UPDATE_SUMMARY);
}
