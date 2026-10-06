import { z } from 'zod';
import { chatMessage, chatReply } from './teams';

// Channel posts (#111): a message posted in a Microsoft Teams team channel, with its replies, as a
// `channel-post` Item. Reading them needs `ChannelMessage.Read.All`, a delegated permission only an
// administrator can approve; replying needs `ChannelMessage.Send`. Until a Teams Account's sign-in
// carries `ChannelMessage.Read.All` and the User switches Sync Channel posts on, nothing about
// channels shows anywhere but the setting that explains what's needed.
//
// Text is plain text converted from Teams' HTML, exactly as for Chats (untrusted Source content,
// kept as data only, ADR 0004). Teams keeps no read state for channels, so Commander keeps its own
// "seen" mark per post, a synced field of Commander's own that never reaches Teams.

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();

/** What Commander asks Microsoft for to read Channel posts and reply to them. */
export const CHANNEL_POST_PERMISSIONS = ['ChannelMessage.Read.All', 'ChannelMessage.Send'] as const;
/** The one of them only an administrator can approve, without which nothing about channels shows. */
export const CHANNEL_READ_PERMISSION = 'ChannelMessage.Read.All';

// A mention of a whole team or channel (@General, @Titanlink): never a mention of the User.
export const conversationMention = z.object({
  kind: z.enum(['team', 'channel']),
  id: z.string(),
  name: z.string(),
});
export type ConversationMention = z.infer<typeof conversationMention>;

// A post or one of its replies: a Chat message's shape, with the team and channel mentions in it.
export const channelMessage = chatMessage.extend({
  conversationMentions: z.array(conversationMention).optional(),
});
export type ChannelMessage = z.infer<typeof channelMessage>;

// A reply written in Commander on its way to Teams: the post's synced field `reply:<clientId>`
// (synced-fields.ts), until Teams has it and it is one of the post's replies under Teams's id.
export const channelReply = chatReply;
export type ChannelReply = z.infer<typeof channelReply>;

export const channelPostDetail = z.object({
  kind: z.literal('channel-post'),
  team: z.object({ id, name: z.string() }),
  channel: z.object({ id, name: z.string() }),
  // The post's subject line, when it has one.
  subject: z.string().nullable(),
  // The post itself (the root of the thread).
  post: channelMessage,
  // Its replies, oldest first (Commander keeps about the newest 200).
  replies: z.array(channelMessage),
  // Opens the post in Teams.
  webUrl: z.string().nullable(),
  // Derived from the post and its replies (channelPostFlags), as Teams sync saw them.
  mentionsMe: z.boolean(),
  lastActivityAt: timestamp,
  // Commander's own "seen" mark: the User has seen the thread up to this time (absent: never opened).
  seenAt: timestamp.optional(),
  // Replies written in Commander on their way to Teams, oldest first (absent when there are none).
  pending: z.array(channelReply).optional(),
});
export type ChannelPostDetail = z.infer<typeof channelPostDetail>;

/**
 * A post's external id: its team, channel and message ids (message ids are unique only within a
 * channel). Chat ids never hold a slash, so a post's is told apart from a Chat's by it.
 */
export function channelPostId(teamId: string, channelId: string, messageId: string): string {
  return `${teamId}/${channelId}/${messageId}`;
}

/** The team, channel and message a post's external id names, or null for any other id (a Chat's). */
export function parseChannelPostId(
  externalId: string,
): { teamId: string; channelId: string; messageId: string } | null {
  const parts = externalId.split('/');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const [teamId = '', channelId = '', messageId = ''] = parts;
  return { teamId, channelId, messageId };
}

/** Every message of a thread, the post first, then its replies oldest first. */
export const threadOf = (detail: Pick<ChannelPostDetail, 'post' | 'replies'>): ChannelMessage[] => [
  detail.post,
  ...detail.replies,
];

const spoken = (message: ChannelMessage) => message.from !== null && !message.deleted;
const fromOthers = (message: ChannelMessage, me: string | null) =>
  spoken(message) && (me === null || message.from?.userId !== me);
// A mention of the User by name (their Teams user id); team and channel mentions never are.
const mentionsUser = (message: ChannelMessage, me: string | null) =>
  me !== null && message.mentions.some((person) => person.userId === me);

export type ChannelPostFlags = Pick<ChannelPostDetail, 'mentionsMe' | 'lastActivityAt'>;

/**
 * What a thread says for the User (`me`: their Microsoft user id, null when not known): whether
 * someone else mentions them by name in it, and when it was last active (its newest message).
 */
export function channelPostFlags(
  detail: Pick<ChannelPostDetail, 'post' | 'replies'>,
  me: string | null,
): ChannelPostFlags {
  const thread = threadOf(detail);
  return {
    mentionsMe: thread.some((message) => fromOthers(message, me) && mentionsUser(message, me)),
    lastActivityAt: thread.reduce((newest, message) => Math.max(newest, message.createdAt), 0),
  };
}

/** The messages from others the User hasn't seen yet (Commander's own mark), oldest first. */
export function unseenMessages(
  detail: Pick<ChannelPostDetail, 'post' | 'replies' | 'seenAt'>,
  me: string | null,
): ChannelMessage[] {
  const seenAt = detail.seenAt ?? null;
  return threadOf(detail).filter(
    (message) => fromOthers(message, me) && (seenAt === null || message.createdAt > seenAt),
  );
}

/**
 * What puts a post on the Dashboard: the latest message the User hasn't seen in which someone else
 * mentions them by name. A mention of the team or channel doesn't count, nor one the User saw.
 */
export function channelPostAttention(
  item: { kind: string; detail: unknown },
  me: string | null,
): { message: ChannelMessage } | null {
  if (item.kind !== 'channel-post') return null;
  const detail = item.detail as ChannelPostDetail | null;
  if (detail?.kind !== 'channel-post' || me === null) return null;
  const mention = unseenMessages(detail, me)
    .filter((message) => mentionsUser(message, me))
    .at(-1);
  return mention ? { message: mention } : null;
}

/** "Titanlink / releases": where a post was made. */
export const channelPlace = (detail: Pick<ChannelPostDetail, 'team' | 'channel'>) =>
  `${detail.team.name} / ${detail.channel.name}`;

// ---------------------------------------------------------------------------------------------
// The teams and channels a Teams Account can sync, and which the User excluded

// The User's teams and their channels, as the Account's last sync listed them (its Source catalog).
export const teamsCatalog = z.object({
  kind: z.literal('teams'),
  teams: z.array(
    z.object({
      id,
      name: z.string(),
      channels: z.array(z.object({ id, name: z.string() })),
    }),
  ),
});
export type TeamsCatalog = z.infer<typeof teamsCatalog>;

// A team (`channelId` null) or one channel the User excluded from Commander: its posts are deleted
// from Commander (tombstones, so Links show them as gone) and sync skips it until it is included
// again. Every channel of every team syncs unless excluded. Nothing changes in Teams.
export const channelSetting = z.object({
  account: id,
  teamId: id,
  channelId: id.nullable(),
  // The team's or channel's name when it was excluded, for Settings once the list no longer has it.
  name: z.string(),
  excludedAt: timestamp,
});
export type ChannelSetting = z.infer<typeof channelSetting>;

export const channelSettingAction = z.object({
  account: id,
  teamId: id,
  channelId: id.nullable(),
  change: z.enum(['exclude', 'include']),
});
export type ChannelSettingAction = z.infer<typeof channelSettingAction>;

/** Whether a channel is excluded, by itself or with its whole team. */
export function isChannelExcluded(
  settings: readonly Pick<ChannelSetting, 'teamId' | 'channelId'>[],
  teamId: string,
  channelId: string,
): boolean {
  return settings.some(
    (setting) => setting.teamId === teamId && (setting.channelId === null || setting.channelId === channelId),
  );
}

// One Account's teams and channels for Settings → Teams → Channel posts, each with whether it is
// excluded. `listedAt`: when sync last listed them (null before it has).
export const channelChoices = z.object({
  account: id,
  listedAt: timestamp.nullable(),
  teams: z.array(
    z.object({
      id,
      name: z.string(),
      excluded: z.boolean(),
      channels: z.array(z.object({ id, name: z.string(), excluded: z.boolean() })),
    }),
  ),
});
export type ChannelChoices = z.infer<typeof channelChoices>;
