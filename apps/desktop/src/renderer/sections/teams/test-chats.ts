import type { ChatDetail, ChatMessage, ChatPerson, SourceItem } from '@commander/domain';

// For tests only: Teams Chats as Teams sync hands them to the Item store (saveFromSource), with
// everything not under test filled in.

export const TEAMS = 'teams:tenant-1:u-sam';
export const SAM: ChatPerson = { userId: 'u-sam', name: 'Sam Rivera' };
export const PRIYA: ChatPerson = { userId: 'u-priya', name: 'Priya Patel' };
export const LEE: ChatPerson = { userId: 'u-lee', name: 'Lee Chen' };
export const ANA: ChatPerson = { userId: 'u-ana', name: 'Ana Gomez' };

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
// Saturday 3 October 2026, 12:00 local time.
export const NOW = new Date(2026, 9, 3, 12).getTime();

let next = 0;

/** A message, sent `ago` before NOW. */
export function message(from: ChatPerson | null, text: string, ago: number, rest: Partial<ChatMessage> = {}) {
  next += 1;
  const at = NOW - ago;
  const sent: ChatMessage = {
    id: `m-${next}`,
    from,
    event: null,
    createdAt: at,
    modifiedAt: at,
    deleted: false,
    text,
    mentions: [],
    reactions: [],
    attachments: [],
    replyTo: null,
    ...rest,
  };
  return sent;
}

export type ChatInput = Partial<ChatDetail> & { id: string; title: string };

/** A `chat` Item as Teams sync hands it over. Unread counts follow the messages unless given. */
export function chat({ id, title, ...detail }: ChatInput): SourceItem {
  const messages = detail.messages ?? [];
  const spoken = messages.filter((each) => each.from && !each.deleted);
  const unread = spoken.filter(
    (each) =>
      each.from?.userId !== SAM.userId && (detail.lastReadAt == null || each.createdAt > detail.lastReadAt),
  );
  const members = detail.members ?? [
    { userId: SAM.userId, name: SAM.name, email: 'sam@contoso.test' },
    { userId: PRIYA.userId, name: PRIYA.name, email: 'priya@contoso.test' },
  ];
  const full: ChatDetail = {
    kind: 'chat',
    chatType: 'one-on-one',
    topic: null,
    webUrl: `https://teams.microsoft.com/l/chat/${encodeURIComponent(id)}/0`,
    members,
    lastReadAt: null,
    hidden: false,
    joinUrl: null,
    messages,
    unreadCount: unread.length,
    mentionsMe: unread.some((each) => each.mentions.some((who) => who.userId === SAM.userId)),
    latestFromMe: spoken.at(-1)?.from?.userId === SAM.userId,
    lastMessageAt: spoken.at(-1)?.createdAt ?? null,
    ...detail,
  };
  return { externalId: id, kind: 'chat', title, detail: full };
}
