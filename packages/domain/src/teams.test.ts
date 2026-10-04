import { describe, expect, it } from 'vitest';
import { type ChatMessage, chatFlags } from './teams';

const ME = 'user-me';
const T = Date.UTC(2026, 9, 3, 9);
const MIN = 60_000;

const message = (
  id: string,
  at: number,
  from: string | null,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  from: from === null ? null : { userId: from, name: from },
  event: from === null ? 'members added' : null,
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

describe('what a Chat says about itself', () => {
  it('counts messages from others since the User last read it', () => {
    const messages = [
      message('1', T, 'priya'),
      message('2', T + 1 * MIN, ME),
      message('3', T + 2 * MIN, 'priya'),
      message('4', T + 3 * MIN, 'sam'),
      message('5', T + 4 * MIN, null),
      message('6', T + 5 * MIN, 'sam', { deleted: true }),
    ];

    expect(chatFlags({ messages, lastReadAt: T + 1 * MIN }, ME)).toEqual({
      unreadCount: 2,
      mentionsMe: false,
      latestFromMe: false,
      lastMessageAt: T + 3 * MIN,
    });
  });

  it('knows when an unread message mentions the User, and when the User spoke last', () => {
    const mention = { userId: ME, name: 'Me' };
    const read = [message('1', T, 'priya', { mentions: [mention] }), message('2', T + MIN, ME)];
    expect(chatFlags({ messages: read, lastReadAt: T + MIN }, ME)).toMatchObject({
      unreadCount: 0,
      mentionsMe: false,
      latestFromMe: true,
    });

    const unread = [message('1', T, ME), message('2', T + MIN, 'priya', { mentions: [mention] })];
    expect(chatFlags({ messages: unread, lastReadAt: T }, ME)).toMatchObject({
      unreadCount: 1,
      mentionsMe: true,
      latestFromMe: false,
    });
  });

  it('counts everything from others as unread when the Chat was never read, and knows nothing of “me” without it', () => {
    const messages = [
      message('1', T, 'priya', { mentions: [{ userId: ME, name: 'Me' }] }),
      message('2', T + MIN, ME),
    ];

    expect(chatFlags({ messages, lastReadAt: null }, null)).toEqual({
      unreadCount: 2,
      mentionsMe: false,
      latestFromMe: false,
      lastMessageAt: T + MIN,
    });
  });
});
