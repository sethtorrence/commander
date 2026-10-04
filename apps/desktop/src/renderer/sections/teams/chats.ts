import type { ChatDetail, ChatMessage, ChatSetting, ChatType, Item } from '@commander/domain';

/*
  The Teams Section's logic, apart from React: which Chats come first, the filters and their
  counts, and how a Chat reads (its latest message as one line, its messages by day, reactions
  summed, and the parts of a message's text). Message text is untrusted Source content, already
  plain text (Teams sync converts Teams' HTML); `messageParts` only finds what may become a link,
  an image placeholder or a highlighted mention, and leaves everything else as text.
*/

/** A Chat as the Section shows it: its Item, with whether the User muted it. */
export type Chat = Item & { detail: ChatDetail; muted: boolean };

/** The `chat` Items as Chats, with the User's settings (muted) applied. Excluded ones are gone already. */
export function toChats(items: readonly Item[], settings: readonly ChatSetting[]): Chat[] {
  const mutedIds = new Set(
    settings.filter((setting) => setting.muted).map((setting) => `${setting.account}\n${setting.chatId}`),
  );
  return items.flatMap((item) =>
    item.kind === 'chat' && item.detail?.kind === 'chat' && item.deletedAt === null
      ? [{ ...item, detail: item.detail, muted: mutedIds.has(`${item.account}\n${item.externalId}`) }]
      : [],
  );
}

/** Whether a Chat counts as unread: it has unread messages, and isn't muted. */
export const isUnread = (chat: Chat) => !chat.muted && chat.detail.unreadCount > 0;

/** Whether a Chat has an unread message mentioning the User (muted Chats never do, here). */
export const mentionsUser = (chat: Chat) => isUnread(chat) && chat.detail.mentionsMe;

const rank = (chat: Chat) => (mentionsUser(chat) ? 0 : isUnread(chat) ? 1 : 2);

/**
 * Chats in the Section's order: those with unread messages mentioning the User, then other unread
 * Chats, then the rest, each by latest message, newest first.
 */
export function orderChats(chats: readonly Chat[]): Chat[] {
  return [...chats].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.detail.lastMessageAt ?? 0) - (a.detail.lastMessageAt ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

/** How many Chats count as unread (the notebook tab's count). */
export function unreadChats(chats: readonly Chat[]): number {
  return chats.filter(isUnread).length;
}

/**
 * Whether Ares judges someone in the Chat is waiting on the User (#109): his flag, which goes once
 * the User replies. A muted Chat never counts here.
 */
export const isWaiting = (chat: Chat) => !chat.muted && chat.waiting !== undefined;

export type ChatFilters = { type: ChatType | null; unreadOnly: boolean; waitingOnly: boolean };
export const NO_FILTERS: ChatFilters = { type: null, unreadOnly: false, waitingOnly: false };

export function inFilters(chat: Chat, filters: ChatFilters): boolean {
  if (filters.type && chat.detail.chatType !== filters.type) return false;
  if (filters.waitingOnly && !isWaiting(chat)) return false;
  return !filters.unreadOnly || isUnread(chat);
}

export type ChatCounts = { types: Record<ChatType | 'all', number>; unread: number; waiting: number };

/** Each filter's counts under the other filters (and whatever narrowed `chats`, the Project filter). */
export function chatCounts(chats: readonly Chat[], filters: ChatFilters): ChatCounts {
  const underOthers = chats.filter((chat) => inFilters(chat, { ...filters, type: null }));
  const ofType = (type: ChatType) => underOthers.filter((chat) => chat.detail.chatType === type).length;
  return {
    types: {
      all: underOthers.length,
      'one-on-one': ofType('one-on-one'),
      group: ofType('group'),
      meeting: ofType('meeting'),
    },
    unread: chats.filter((chat) => inFilters(chat, { ...filters, unreadOnly: true })).length,
    waiting: chats.filter((chat) => inFilters(chat, { ...filters, waitingOnly: true })).length,
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The Chat's latest message as the list shows it: one line of text, its sender ("You" for the User), and when. */
export function latestLine(
  chat: Chat,
  me: string | null,
): { sender: string; text: string; at: number } | null {
  const latest = chat.detail.messages.findLast((message) => message.from !== null && !message.deleted);
  if (!latest?.from) return null;
  const sender = me !== null && latest.from.userId === me ? 'You' : latest.from.name;
  return { sender, text: oneLine(latest.text) || '[attachment]', at: latest.createdAt };
}

const andList = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Who is in the Chat: "Priya Patel, Lee Chen and you". */
export function peopleIn(chat: Chat, me: string | null): string {
  const members = chat.detail.members;
  const others = members.filter((member) => me === null || member.userId !== me).map((member) => member.name);
  const withMe = members.some((member) => me !== null && member.userId === me);
  return andList(withMe ? [...others, 'you'] : others);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const day = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

export type ChatDay = { key: string; label: string; messages: ChatMessage[] };

/** A Chat's messages by local day, oldest first, so the newest sit at the bottom. */
export function messagesByDay(messages: readonly ChatMessage[], now: number): ChatDay[] {
  const days: ChatDay[] = [];
  for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = new Date(message.createdAt).toDateString();
    const last = days.at(-1);
    if (last?.key === key) last.messages.push(message);
    else days.push({ key, label: dayLabel(message.createdAt, now), messages: [message] });
  }
  return days;
}

// Teams' reaction types, in its own words; anything else (an emoji) as it is.
const REACTIONS: Record<string, string> = {
  like: 'Like',
  heart: 'Heart',
  laugh: 'Laugh',
  surprised: 'Surprised',
  sad: 'Sad',
  angry: 'Angry',
};

/** A message's reactions summed by kind, most first: ["Like 3", "Heart 1"]. */
export function reactionSummary(reactions: ChatMessage['reactions']): string[] {
  const counts = new Map<string, number>();
  for (const reaction of reactions) {
    const name = REACTIONS[reaction.type.toLowerCase()] ?? reaction.type;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`);
}

/** The names a message mentions the User by. */
export function mentionsOf(message: ChatMessage, me: string | null): string[] {
  return me === null ? [] : message.mentions.filter((each) => each.userId === me).map((each) => each.name);
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'image' }
  | { kind: 'mention'; text: string };

// Web and mail addresses only: nothing else (javascript:, data:, file:) ever becomes a link.
const LINK = /\bhttps?:\/\/[^\s<>"'`()[\]{}]+|\bmailto:[^\s<>"'`()[\]{}]+/gi;
const TRAILING = /[.,;:!?'"]+$/;
const IMAGE = '[image]';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The parts of a message's (plain) text: web and mail links, "[image]" where Teams had an inline
 * image, and @mentions of the User (by the names given), with the rest as text.
 */
export function messageParts(text: string, mentionNames: readonly string[]): MessagePart[] {
  const names = [...new Set(mentionNames.filter((name) => name.trim()))].sort((a, b) => b.length - a.length);
  const mention = names.length ? `@(?:${names.map(escapeRegExp).join('|')})` : null;
  const pattern = new RegExp(
    [LINK.source, escapeRegExp(IMAGE), ...(mention ? [mention] : [])].map((part) => `(${part})`).join('|'),
    'gi',
  );
  const parts: MessagePart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === 'text') last.text += value;
    else parts.push({ kind: 'text', text: value });
  };
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    pushText(text.slice(at, index));
    at = index + match[0].length;
    const [, link, image] = match;
    if (link) {
      const href = link.replace(TRAILING, '');
      parts.push({ kind: 'link', text: href, href });
      pushText(link.slice(href.length));
    } else if (image) parts.push({ kind: 'image' });
    else parts.push({ kind: 'mention', text: match[0] });
  }
  pushText(text.slice(at));
  return parts;
}
