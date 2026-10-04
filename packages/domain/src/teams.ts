import { z } from 'zod';

// The `chat` kind detail: what Teams sync keeps of each Chat (a one-to-one, group or meeting chat)
// and its recent messages, as Teams reported them. Message text is plain text converted from Teams'
// HTML (paragraphs, lists, links and @mentions kept, markup dropped): untrusted Source content, kept
// as data only. People in a Chat are kept as they are (handles) until People are matched across
// Sources. Files are links only; Commander never downloads them.

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
