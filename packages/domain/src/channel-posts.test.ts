import { describe, expect, it } from 'vitest';
import {
  type ChannelMessage,
  type ChannelPostDetail,
  channelPostAttention,
  channelPostFlags,
  channelPostId,
  isChannelExcluded,
  parseChannelPostId,
  unseenMessages,
} from './channel-posts';

const ME = 'user-me';
const T = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;

const message = (
  id: string,
  at: number,
  from: string,
  extra: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  from: { userId: from, name: from },
  event: null,
  createdAt: at,
  modifiedAt: at,
  deleted: false,
  text: `Message ${id}`,
  mentions: [],
  reactions: [],
  attachments: [],
  replyTo: null,
  ...extra,
});

const post = (replies: ChannelMessage[], extra: Partial<ChannelPostDetail> = {}): ChannelPostDetail => ({
  kind: 'channel-post',
  team: { id: 'team-1', name: 'Titanlink' },
  channel: { id: '19:releases@thread.tacv2', name: 'releases' },
  subject: 'Release 4.2',
  post: message('p', T, 'priya'),
  replies,
  webUrl: null,
  mentionsMe: false,
  lastActivityAt: T,
  ...extra,
});

const mentioning = (who: string) => ({ mentions: [{ userId: who, name: who }] });

describe('a post’s external id', () => {
  it('names the team, channel and message, and tells a Chat’s id apart', () => {
    const id = channelPostId('team-1', '19:abc@thread.tacv2', '1700000000000');
    expect(parseChannelPostId(id)).toEqual({
      teamId: 'team-1',
      channelId: '19:abc@thread.tacv2',
      messageId: '1700000000000',
    });
    expect(parseChannelPostId('19:abc_def@unq.gbl.spaces')).toBeNull();
  });
});

describe('what a thread says for the User', () => {
  it('counts a mention of the User by someone else, and the newest message', () => {
    const detail = post([message('r1', T + MIN, 'sam'), message('r2', T + 2 * MIN, 'omar', mentioning(ME))]);
    expect(channelPostFlags(detail, ME)).toEqual({ mentionsMe: true, lastActivityAt: T + 2 * MIN });
  });

  it('never counts team and channel mentions, nor the User mentioning themselves', () => {
    const detail = post([
      message('r1', T + MIN, 'sam', {
        conversationMentions: [{ kind: 'channel', id: 'c', name: 'releases' }],
        mentions: [{ userId: null, name: 'releases' }],
      }),
      message('r2', T + 2 * MIN, ME, mentioning(ME)),
    ]);
    expect(channelPostFlags(detail, ME).mentionsMe).toBe(false);
  });
});

describe('the Dashboard’s look at a post', () => {
  const item = (detail: ChannelPostDetail) => ({ kind: 'channel-post', detail });

  it('is the latest unseen message mentioning the User', () => {
    const detail = post([
      message('r1', T + MIN, 'sam', mentioning(ME)),
      message('r2', T + 2 * MIN, 'omar', mentioning(ME)),
      message('r3', T + 3 * MIN, 'omar'),
    ]);
    expect(channelPostAttention(item(detail), ME)?.message.id).toBe('r2');
  });

  it('goes once the User has seen it, and comes back with a newer mention', () => {
    const seen = post([message('r1', T + MIN, 'sam', mentioning(ME))], { seenAt: T + MIN });
    expect(channelPostAttention(item(seen), ME)).toBeNull();
    const again = { ...seen, replies: [...seen.replies, message('r2', T + 5 * MIN, 'sam', mentioning(ME))] };
    expect(channelPostAttention(item(again), ME)?.message.id).toBe('r2');
  });

  it('leaves a deleted mention out, and needs to know who the User is', () => {
    const detail = post([message('r1', T + MIN, 'sam', { ...mentioning(ME), deleted: true })]);
    expect(channelPostAttention(item(detail), ME)).toBeNull();
    expect(channelPostAttention(item(post([message('r1', T, 'sam', mentioning(ME))])), null)).toBeNull();
  });

  it('lists what the User hasn’t seen from others', () => {
    const detail = post([message('r1', T + MIN, ME), message('r2', T + 2 * MIN, 'sam')], { seenAt: T });
    expect(unseenMessages(detail, ME).map((each) => each.id)).toEqual(['r2']);
  });
});

describe('excluded teams and channels', () => {
  it('excludes a channel by itself or with its team', () => {
    const settings = [
      { teamId: 'a', channelId: null },
      { teamId: 'b', channelId: 'b1' },
    ];
    expect(isChannelExcluded(settings, 'a', 'a9')).toBe(true);
    expect(isChannelExcluded(settings, 'b', 'b1')).toBe(true);
    expect(isChannelExcluded(settings, 'b', 'b2')).toBe(false);
  });
});
