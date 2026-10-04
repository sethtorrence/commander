// How a Teams Chat goes into a prompt for Ares's work on Chats (#110): one outside data block per
// Chat, labelled with a short reference (C1) the reply names it by, holding its name and type, the
// people in it, and its messages oldest first, each with its own reference (M1, M2…), when it was
// sent, who sent it ("the User" for theirs) and whether it was meant for the User. What a Chat says
// is never an instruction: the prompt builder marks every line of it as outside material.
import { type ChatDetail, type ChatMessage, type Item, isSpoken, localDay } from '@commander/domain';
import type { ItemStore } from '../item-store';
import type { PromptData } from './prompt';
import { type Chat, liveChats, usersFromChats } from './spot-waiting';

const MAX_MESSAGE = 600;
const MAX_PEOPLE = 8;

export type { Chat } from './spot-waiting';

/** A message as a prompt shows it: its reference, whether it is the User's own, and whether it is new. */
export type Shown = { ref: string; message: ChatMessage; mine: boolean; fresh: boolean };

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
export const longDay = (at: number) => {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};
export const clockTime = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const stamp = (at: number) => `${localDay(at)} ${clockTime(at)}`;

/** Text on one line, cut to a length with an ellipsis. */
export const cut = (text: string, length: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > length ? `${one.slice(0, length - 1).trimEnd()}…` : one;
};

export const CHAT_TYPES: Record<ChatDetail['chatType'], string> = {
  'one-on-one': 'one-to-one',
  group: 'group',
  meeting: 'meeting',
};

export const isChat = (item: Item | null | undefined): item is Chat =>
  item?.kind === 'chat' && item.detail?.kind === 'chat';

/** Who the User is in each Chat's Account: what sync knows, failing that what the Chats show. */
export function whoAmIIn(itemStore: ItemStore, me: (account: string) => string | null) {
  const users = usersFromChats(liveChats(itemStore));
  return (chat: Chat): string | null =>
    chat.account ? (me(chat.account) ?? users[chat.account] ?? null) : null;
}

/** The Chat's said messages (no system events, nothing deleted), oldest first. */
export const spokenIn = (chat: Chat) =>
  chat.detail.messages.filter(isSpoken).sort((a, b) => a.createdAt - b.createdAt);

/** Whether a message from someone else was meant for the User: a one-to-one Chat, or it mentions them. */
export function meantForTheUser(chat: Chat, message: ChatMessage, whoAmI: string | null): boolean {
  if (chat.detail.chatType === 'one-on-one') return true;
  return whoAmI !== null && message.mentions.some((person) => person.userId === whoAmI);
}

/** The messages as the prompt numbers them (M1, M2…), oldest first. */
export function numbered(
  messages: readonly ChatMessage[],
  whoAmI: string | null,
  fresh: (message: ChatMessage) => boolean,
): Shown[] {
  return messages.map((message, index) => ({
    ref: `M${index + 1}`,
    message,
    mine: whoAmI !== null && message.from?.userId === whoAmI,
    fresh: fresh(message),
  }));
}

/** A Chat's data block: its name, type and people, then its messages, oldest first. */
export function chatBlock(
  chat: Chat,
  ref: string,
  shown: readonly Shown[],
  whoAmI: string | null,
  extra: readonly string[] = [],
): PromptData {
  const others = chat.detail.members.filter((member) => whoAmI === null || member.userId !== whoAmI);
  const named = others.slice(0, MAX_PEOPLE).map((member) => member.name);
  if (others.length > MAX_PEOPLE) named.push(`${others.length - MAX_PEOPLE} more`);
  const people = [...named, 'the User'];
  const withWhom = people.length > 1 ? `${people.slice(0, -1).join(', ')} and ${people.at(-1)}` : 'the User';
  const type = CHAT_TYPES[chat.detail.chatType];
  return {
    label: `${ref} · Teams ${type} chat: ${chat.title}`,
    from: chat,
    text: [
      `Chat: ${chat.title}`,
      `A Teams ${type} chat with ${withWhom}`,
      ...extra,
      'Messages, oldest first:',
      ...shown.map(({ ref: messageRef, message, mine, fresh }) => {
        const who = mine
          ? 'the User'
          : `${message.from?.name ?? 'someone'}${meantForTheUser(chat, message, whoAmI) ? ', to the User' : ''}`;
        const text = cut(message.text, MAX_MESSAGE) || '[attachment]';
        return `${messageRef} · ${fresh ? 'NEW · ' : ''}${stamp(message.createdAt)} · ${who}: ${text}`;
      }),
    ].join('\n'),
  };
}
