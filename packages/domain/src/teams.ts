import { z } from 'zod';

// The `chat` kind detail: what Teams sync keeps of each Chat (a one-to-one, group or meeting chat)
// and its recent messages, as Teams reported them. Message text is plain text converted from Teams'
// HTML (paragraphs, lists, links and @mentions kept, markup dropped): untrusted Source content, kept
// as data only. People in a Chat are kept as they are; the Item's handles belong to People
// (people.ts). Files are links only; Commander never downloads them.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

export const chatTypes = ['one-on-one', 'group', 'meeting'] as const;
export const chatType = z.enum(chatTypes);
export type ChatType = z.infer<typeof chatType>;

// Someone in a Chat. `userId` is their Microsoft user id (null for guests Teams gives none for).
export const chatMember = z.object({ userId: id.nullable(), name: z.string(), email: z.string().nullable() });
export type ChatMember = z.infer<typeof chatMember>;

export const chatPerson = z.object({ userId: id.nullable(), name: z.string() });
export type ChatPerson = z.infer<typeof chatPerson>;

export const chatMessage = z.object({
  id,
  // null for a system event (someone added, the Chat renamed, a call ended).
  from: chatPerson.nullable(),
  // What a system event was, in plain words ("members added"); null for a message.
  event: z.string().nullable(),
  createdAt: timestamp,
  // When it was last edited, deleted or reacted to.
  modifiedAt: timestamp,
  // When its text was last edited, if it was (absent in Chats synced before Commander kept it).
  editedAt: timestamp.optional(),
  deleted: z.boolean(),
  text: z.string(),
  mentions: z.array(chatPerson),
  // `type` as Teams names it (like, heart, laugh…, or an emoji), and who reacted.
  reactions: z.array(z.object({ type: z.string(), by: chatPerson })),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })),
  // The message it replies to (quotes), if any.
  replyTo: id.nullable(),
});
export type ChatMessage = z.infer<typeof chatMessage>;

// The most text one reply may hold (Teams takes about 28 KB of HTML in a message).
export const MAX_REPLY_LENGTH = 20_000;

// A reply the User wrote in Commander that Teams doesn't have yet (#106): plain text with line
// breaks, under an id made in Commander. It is the Chat's synced field `message:<clientId>` (see
// synced-fields.ts), queued for Teams until it gets there; then it is one of the Chat's messages,
// under Teams's own id, and leaves `replies`.
export const chatReply = z.object({
  clientId: id,
  text: z.string().trim().min(1).max(MAX_REPLY_LENGTH),
  createdAt: timestamp,
});
export type ChatReply = z.infer<typeof chatReply>;

export const chatDetail = z.object({
  kind: z.literal('chat'),
  chatType,
  // The Chat's name, when it has one (meeting Chats are named after the meeting).
  topic: z.string().nullable(),
  // Opens the Chat in Teams.
  webUrl: z.string().nullable(),
  members: z.array(chatMember),
  // When the User last read the Chat (Teams' viewpoint), and whether they hid it.
  lastReadAt: timestamp.nullable(),
  hidden: z.boolean(),
  // A meeting Chat's join link.
  joinUrl: z.string().nullable(),
  // Recent messages, oldest first (Commander keeps about the newest 200).
  messages: z.array(chatMessage),
  // Derived from the messages, for the Teams Section and the Dashboard (see chatFlags).
  unreadCount: z.number().int().nonnegative(),
  mentionsMe: z.boolean(),
  latestFromMe: z.boolean(),
  lastMessageAt: timestamp.nullable(),
  // Replies written in Commander on their way to Teams, oldest first (absent when there are none).
  replies: z.array(chatReply).optional(),
});
export type ChatDetail = z.infer<typeof chatDetail>;

export type ChatFlags = Pick<ChatDetail, 'unreadCount' | 'mentionsMe' | 'latestFromMe' | 'lastMessageAt'>;

// What a Chat's messages say for the User (`me`: their Microsoft user id, null when not known):
// messages from others since they last read it, whether one of those mentions them, whether the
// latest message is theirs, and when the latest was sent. Deleted messages and system events don't count.
export function chatFlags(
  chat: { messages: readonly ChatMessage[]; lastReadAt: number | null },
  me: string | null,
): ChatFlags {
  const spoken = chat.messages.filter((message) => message.from !== null && !message.deleted);
  const fromMe = (message: ChatMessage) => me !== null && message.from?.userId === me;
  const unread = spoken.filter(
    (message) => !fromMe(message) && (chat.lastReadAt === null || message.createdAt > chat.lastReadAt),
  );
  const latest = spoken.reduce<ChatMessage | null>(
    (newest, message) => (newest === null || message.createdAt >= newest.createdAt ? message : newest),
    null,
  );
  return {
    unreadCount: unread.length,
    mentionsMe: me !== null && unread.some((message) => message.mentions.some((each) => each.userId === me)),
    latestFromMe: latest !== null && fromMe(latest),
    lastMessageAt: latest?.createdAt ?? null,
  };
}

// The latest message from someone other than the User (`me`; anyone's when not known), if any:
// where marking a Chat unread starts from. Deleted messages and system events don't count.
export function latestFromOthers(messages: readonly ChatMessage[], me: string | null): ChatMessage | null {
  return messages.reduce<ChatMessage | null>((newest, message) => {
    if (message.from === null || message.deleted || (me !== null && message.from.userId === me))
      return newest;
    return newest === null || message.createdAt >= newest.createdAt ? message : newest;
  }, null);
}

// What the User chose for a Chat in Commander (#105). Commander settings only: nothing changes in
// Teams. Kept by Account and the Chat's Teams id (the Item's external id), so an excluded Chat, whose
// Item is deleted, stays excluded, and the sync engine can tell the adapter to skip it.
//
// - Muted: the Chat stays and syncs, but drops out of unread ordering and counts, never reaches the
//   Dashboard, and Ares never summarises it unprompted.
// - Excluded: its Item is deleted from Commander (a tombstone, so Links show it as gone) and sync
//   skips it from then on, until the User includes it again.
export const chatSetting = z.object({
  account: id,
  chatId: id,
  // The Chat's name when last changed, for Settings → Teams once its Item is gone.
  name: z.string(),
  muted: z.boolean(),
  // When it was excluded; null while it isn't.
  excludedAt: timestamp.nullable(),
  updatedAt: timestamp,
});
export type ChatSetting = z.infer<typeof chatSetting>;

export const chatSettingChanges = ['mute', 'unmute', 'exclude', 'include'] as const;
export type ChatSettingChangeKind = (typeof chatSettingChanges)[number];
export const chatSettingAction = z.object({
  account: id,
  chatId: id,
  change: z.enum(chatSettingChanges),
});
export type ChatSettingAction = z.infer<typeof chatSettingAction>;

/** The Item ids of the muted Chats among `items` (matched by Account and Teams id), for the Dashboard to leave off. */
export function mutedChatIds(
  items: readonly { id: string; kind: string; account: string | null; externalId: string | null }[],
  settings: readonly Pick<ChatSetting, 'account' | 'chatId' | 'muted'>[],
): Set<string> {
  const muted = new Set(
    settings.filter((each) => each.muted).map((each) => `${each.account}\n${each.chatId}`),
  );
  return new Set(
    items
      .filter((item) => item.kind === 'chat' && muted.has(`${item.account}\n${item.externalId}`))
      .map((item) => item.id),
  );
}
