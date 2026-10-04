import {
  type ChatDetail,
  type ChatMember,
  type ChatMessage,
  type ChatType,
  chatFlags,
  type SourceItem,
} from '@commander/domain';
import { z } from 'zod';
import type { GraphPage } from './graph';
import { teamsText } from './html';

// Microsoft Graph's Chat shapes (v1.0), as far as Commander reads them, and their translation into
// `chat` Items. Fields Graph may leave out or null are optional here, so a sparse answer never
// breaks a sync.

const text = z.string().nullish();

const identity = z.object({ id: text, displayName: text }).nullish();
const identitySet = z.object({ user: identity, application: identity }).nullish();

export const graphChat = z.object({
  id: z.string().min(1),
  topic: text,
  chatType: z.string(),
  webUrl: text,
  // When the Chat was renamed or its members changed.
  lastUpdatedDateTime: z.iso.datetime({ offset: true }),
  onlineMeetingInfo: z.object({ joinWebUrl: text }).nullish(),
  viewpoint: z.object({ isHidden: z.boolean().nullish(), lastMessageReadDateTime: text }).nullish(),
  lastMessagePreview: z
    .object({
      id: z.string(),
      createdDateTime: z.iso.datetime({ offset: true }),
      isDeleted: z.boolean().nullish(),
    })
    .nullish(),
});
export type GraphChat = z.infer<typeof graphChat>;

export const graphMember = z.object({
  userId: text,
  displayName: text,
  email: text,
});
export type GraphMember = z.infer<typeof graphMember>;

export const graphMessage = z.object({
  id: z.string().min(1),
  replyToId: text,
  messageType: z.string().nullish(),
  createdDateTime: z.iso.datetime({ offset: true }),
  lastModifiedDateTime: z.iso.datetime({ offset: true }).nullish(),
  lastEditedDateTime: text,
  deletedDateTime: text,
  from: identitySet,
  body: z.object({ contentType: z.string().nullish(), content: text }).nullish(),
  attachments: z.array(z.object({ id: text, contentType: text, contentUrl: text, name: text })).nullish(),
  mentions: z
    .array(z.object({ mentionText: text, mentioned: z.object({ user: identity }).nullish() }))
    .nullish(),
  reactions: z.array(z.object({ reactionType: z.string(), user: identitySet })).nullish(),
  eventDetail: z.object({ '@odata.type': text }).loose().nullish(),
});
export type GraphMessage = z.infer<typeof graphMessage>;

const page = <T extends z.ZodType>(item: T) =>
  z.object({ value: z.array(item), '@odata.nextLink': z.string().optional() }) as unknown as z.ZodType<
    GraphPage<z.infer<T>>
  >;
export const chatsPage = page(graphChat);
export const membersPage = page(graphMember);
export const messagesPage = page(graphMessage);

const at = (iso: string) => Date.parse(iso);

const CHAT_TYPES: Record<string, ChatType> = { oneOnOne: 'one-on-one', group: 'group', meeting: 'meeting' };

const isWebLink = (url: string | null | undefined): url is string => !!url && /^https?:\/\//i.test(url);

export function toMember(member: GraphMember): ChatMember {
  return {
    userId: member.userId || null,
    name: member.displayName?.trim() || member.email || 'Someone',
    email: member.email?.trim() || null,
  };
}

// "membersAdded" from #microsoft.graph.membersAddedEventMessageDetail, as "members added".
function eventName(type: string | null | undefined): string {
  const name = (type ?? '').replace(/^#?microsoft\.graph\./, '').replace(/EventMessageDetail$/, '');
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words || 'event';
}

export function toMessage(message: GraphMessage): ChatMessage {
  const system = message.messageType === 'systemEventMessage';
  const sender = message.from?.user ?? message.from?.application ?? null;
  const deleted = !!message.deletedDateTime;
  const attachments = message.attachments ?? [];
  const quoted = attachments.find((each) => each.contentType === 'messageReference')?.id ?? null;
  return {
    id: message.id,
    from:
      system || !sender
        ? null
        : { userId: message.from?.user?.id || null, name: sender.displayName?.trim() || 'Someone' },
    event: system ? eventName(message.eventDetail?.['@odata.type']) : null,
    createdAt: at(message.createdDateTime),
    modifiedAt: at(message.lastModifiedDateTime ?? message.createdDateTime),
    ...(message.lastEditedDateTime && !deleted ? { editedAt: at(message.lastEditedDateTime) } : {}),
    deleted,
    text: deleted
      ? ''
      : teamsText(message.body?.content ?? '', message.body?.contentType === 'text' ? 'text' : 'html'),
    mentions: (message.mentions ?? []).map((mention) => ({
      userId: mention.mentioned?.user?.id || null,
      name: mention.mentioned?.user?.displayName?.trim() || mention.mentionText?.trim() || 'Someone',
    })),
    reactions: (message.reactions ?? []).map((reaction) => ({
      type: reaction.reactionType,
      by: { userId: reaction.user?.user?.id || null, name: reaction.user?.user?.displayName?.trim() || '' },
    })),
    attachments: attachments
      .filter((each) => each.contentType !== 'messageReference' && isWebLink(each.contentUrl))
      .map((each) => ({ name: each.name?.trim() || 'File', url: each.contentUrl as string })),
    replyTo: message.replyToId || quoted,
  };
}

// The messages Commander keeps of a Chat: what it had, with what Teams just sent on top (an edit or
// a deletion replaces the message), oldest first, the newest `cap` of them.
export function mergeMessages(kept: readonly ChatMessage[], fetched: readonly ChatMessage[], cap: number) {
  const byId = new Map(kept.map((message) => [message.id, message]));
  for (const message of fetched) byId.set(message.id, message);
  return [...byId.values()]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-cap);
}

// A Chat as an Item. Its title: the topic, or else the other people's names.
export function toChatItem(
  chat: GraphChat,
  members: ChatMember[],
  messages: ChatMessage[],
  me: string | null,
): SourceItem {
  const others = members.filter((member) => member.userId === null || member.userId !== me);
  const named = (others.length ? others : members).map((member) => member.name);
  const title = chat.topic?.trim() || named.join(', ') || 'Chat';
  const people: string[] = [];
  for (const member of members) {
    if (member.userId) people.push(`teams:${member.userId}`);
    if (member.email) people.push(member.email.toLowerCase());
  }
  const read = chat.viewpoint?.lastMessageReadDateTime;
  const lastReadAt = read ? at(read) : null;
  const detail: ChatDetail = {
    kind: 'chat',
    chatType: CHAT_TYPES[chat.chatType] ?? 'group',
    topic: chat.topic?.trim() || null,
    webUrl: isWebLink(chat.webUrl) ? chat.webUrl : null,
    members,
    lastReadAt,
    hidden: chat.viewpoint?.isHidden ?? false,
    joinUrl: isWebLink(chat.onlineMeetingInfo?.joinWebUrl)
      ? (chat.onlineMeetingInfo?.joinWebUrl ?? null)
      : null,
    messages,
    ...chatFlags({ messages, lastReadAt }, me),
  };
  return { externalId: chat.id, kind: 'chat', title, people: [...new Set(people)], status: 'open', detail };
}
