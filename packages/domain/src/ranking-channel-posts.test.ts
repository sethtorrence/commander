import { describe, expect, it } from 'vitest';
import type { ChannelMessage, ChannelPostDetail } from './channel-posts';
import type { Item } from './items';
import { rankByBandRules } from './ranking';

// Channel posts on the Dashboard (#111): a post or reply that mentions the User by name, unseen,
// goes in Today. Team and channel mentions don't.

const ACCOUNT = 'teams:tenant-1:u-me';
const ME = 'u-me';
const NOW = new Date(2026, 9, 5, 15, 0).getTime();
const MIN = 60_000;

const message = (
  id: string,
  at: number,
  from: string,
  extra: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id,
  from: { userId: from, name: from === 'u-priya' ? 'Priya Patel' : 'Sam Rivera' },
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

function post(replies: ChannelMessage[], extra: Partial<ChannelPostDetail> = {}, id = 'post-1'): Item {
  const detail: ChannelPostDetail = {
    kind: 'channel-post',
    team: { id: 'team-tl', name: 'TL' },
    channel: { id: 'c-releases', name: 'releases' },
    subject: 'Release 4.2',
    post: message('p', NOW - 60 * MIN, 'u-sam'),
    replies,
    webUrl: null,
    mentionsMe: true,
    lastActivityAt: NOW,
    ...extra,
  };
  return {
    id,
    kind: 'channel-post',
    source: 'teams',
    account: ACCOUNT,
    externalId: `team-tl/c-releases/${id}`,
    title: 'Release 4.2',
    people: [],
    filing: null,
    status: 'open',
    detail,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW,
    deletedAt: null,
  };
}

const rank = (items: Item[]) => rankByBandRules(items, { now: NOW, users: { [ACCOUNT]: ME } });

describe('Channel posts on the Dashboard', () => {
  it('puts an unseen reply mentioning the User in Today, saying who and where', () => {
    const at = new Date(2026, 9, 5, 14, 20).getTime();
    const items = [post([message('r1', at, 'u-priya', { mentions: [{ userId: ME, name: 'Me' }] })])];
    expect(rank(items)).toEqual([
      { itemId: 'post-1', band: 'today', reason: 'Priya mentioned you in TL / releases · 14:20', rank: 1 },
    ]);
  });

  it('leaves out team and channel mentions, and posts the User has seen', () => {
    const channelMention = message('r1', NOW - MIN, 'u-priya', {
      mentions: [{ userId: null, name: 'releases' }],
      conversationMentions: [{ kind: 'channel', id: 'c-releases', name: 'releases' }],
    });
    const seen = message('r2', NOW - 2 * MIN, 'u-priya', { mentions: [{ userId: ME, name: 'Me' }] });
    expect(
      rank([post([channelMention], {}, 'a'), post([seen], { seenAt: NOW - MIN }, 'b'), post([], {}, 'c')]),
    ).toEqual([]);
  });

  it('never places a deleted post', () => {
    const item = post([message('r1', NOW - MIN, 'u-priya', { mentions: [{ userId: ME, name: 'Me' }] })]);
    expect(rank([{ ...item, deletedAt: NOW }])).toEqual([]);
  });
});
