import { describe, expect, it } from 'vitest';
import { rankingFingerprint } from './ares-ranking';
import type { Item } from './items';
import { chatAttention, type RankingContext, rankByBandRules } from './ranking';
import { type ChatDetail, type ChatMessage, type ChatPerson, chatFlags } from './teams';
import {
  busyChatThreshold,
  fromOthersSince,
  messagesInRange,
  stillWaiting,
  summaryRangeStart,
} from './teams-ares';

// Ares on Teams (#109), the pure parts: a Chat Ares flagged as waiting on the User on the Dashboard
// (Today, with his reason) until the User replies after the message, the messages a summary covers
// for each range, and counting a busy Chat's messages from others. Thursday 1 October 2026, 11:40.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TEAMS = 'teams:tenant:sam';

const SAM: ChatPerson = { userId: 'u-sam', name: 'Sam Rivera' };
const OMAR: ChatPerson = { userId: 'u-omar', name: 'Omar Haddad' };
const LEE: ChatPerson = { userId: 'u-lee', name: 'Lee Chen' };

const context: RankingContext = { now: NOW, users: { [TEAMS]: 'u-sam' } };

let counter = 0;
function message(from: ChatPerson | null, at: number, text = 'hello', mentions: ChatPerson[] = []) {
  counter += 1;
  return {
    id: `m${counter}`,
    from,
    event: from ? null : 'members added',
    createdAt: at,
    modifiedAt: at,
    deleted: false,
    text,
    mentions,
    reactions: [],
    attachments: [],
    replyTo: null,
  } satisfies ChatMessage;
}

function chat(
  id: string,
  messages: ChatMessage[],
  {
    type = 'group',
    lastReadAt = null,
    ...rest
  }: Partial<Item> & {
    type?: ChatDetail['chatType'];
    lastReadAt?: number | null;
  } = {},
): Item & { detail: ChatDetail } {
  return {
    id,
    kind: 'chat',
    source: 'teams',
    account: TEAMS,
    externalId: `19:${id}`,
    title: id,
    people: [],
    filing: null,
    status: 'open',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    detail: {
      kind: 'chat',
      chatType: type,
      topic: type === 'one-on-one' ? null : id,
      webUrl: null,
      members: [],
      lastReadAt,
      hidden: false,
      joinUrl: null,
      messages,
      ...chatFlags({ messages, lastReadAt }, 'u-sam'),
    },
    ...rest,
  } as Item & { detail: ChatDetail };
}

const REASON = 'Omar asked whether you can sign off the TL release today';

describe('a Chat waiting on the User, on the Dashboard', () => {
  it('sits in Today with Ares’s reason, even in a group Chat with no mention', () => {
    const ask = message(OMAR, NOW - 30 * MINUTE, 'Can Sam sign off the TL release today?');
    const titanlink = chat('Titanlink eng', [message(LEE, NOW - HOUR, 'Morning'), ask], {
      lastReadAt: NOW - 10 * MINUTE,
      waiting: { messageId: ask.id, reason: REASON, at: NOW - 20 * MINUTE },
    });
    expect(rankByBandRules([titanlink], context)).toEqual([
      { itemId: 'Titanlink eng', band: 'today', reason: REASON, rank: 1 },
    ]);
    expect(chatAttention(titanlink, 'u-sam', NOW)).toEqual({ why: 'waiting', message: ask });
  });

  it('takes Ares’s reason over the rules’ when it also mentions the User', () => {
    const ask = message(OMAR, NOW - 30 * MINUTE, '@Sam can you sign off?', [SAM]);
    const titanlink = chat('Titanlink eng', [ask], {
      waiting: { messageId: ask.id, reason: REASON, at: NOW },
    });
    expect(rankByBandRules([titanlink], context)[0]?.reason).toBe(REASON);
  });

  it('leaves once the User replies after the message, whether or not the Core has cleared it yet', () => {
    const ask = message(OMAR, NOW - 30 * MINUTE, 'Can Sam sign off?');
    const replied = chat('Titanlink eng', [ask, message(SAM, NOW - 5 * MINUTE, 'Yes, signing now')], {
      waiting: { messageId: ask.id, reason: REASON, at: NOW },
    });
    expect(stillWaiting(replied.detail, replied.waiting, 'u-sam')).toBe(false);
    expect(rankByBandRules([replied], context)).toEqual([]);
    // A word from someone else afterwards doesn't bring it back: the User answered.
    const thanked = chat('Titanlink eng', [...replied.detail.messages, message(OMAR, NOW, 'Thanks!')], {
      waiting: replied.waiting,
    });
    expect(rankByBandRules([thanked], context)).toEqual([]);
  });

  it('stays off when the Chat is muted, or the flagged message is gone', () => {
    const ask = message(OMAR, NOW - 30 * MINUTE, 'Can Sam sign off?');
    const waiting = { messageId: ask.id, reason: REASON, at: NOW };
    const muted = chat('Titanlink eng', [ask], { waiting });
    expect(rankByBandRules([muted], { ...context, muted: new Set(['Titanlink eng']) })).toEqual([]);
    const gone = chat('Other', [message(OMAR, NOW - HOUR, 'Hi')], { waiting });
    expect(rankByBandRules([gone], context)).toEqual([]);
  });

  it('is part of what Ares ranks the Chat by', () => {
    const ask = message(OMAR, NOW - 30 * MINUTE, 'Can Sam sign off?');
    const plain = chat('Titanlink eng', [ask]);
    const flagged = { ...plain, waiting: { messageId: ask.id, reason: REASON, at: NOW } };
    expect(rankingFingerprint(flagged)).not.toBe(rankingFingerprint(plain));
  });
});

describe('the messages a summary covers', () => {
  const messages = [
    message(LEE, NOW - 8 * DAY, 'Last week'),
    message(OMAR, NOW - 3 * DAY, 'Monday'),
    message(SAM, NOW - DAY, 'Yesterday'),
    message(OMAR, NOW - 2 * HOUR, 'This morning'),
    message(null, NOW - HOUR),
    message(LEE, NOW - 10 * MINUTE, 'Just now'),
  ];
  const detail = chat('Titanlink eng', messages, { lastReadAt: NOW - 3 * HOUR }).detail;
  const texts = (found: ChatMessage[]) => found.map((each) => each.text);

  it('“since I last read”: the messages after the User last read it', () => {
    expect(texts(messagesInRange(detail, 'since-read', NOW))).toEqual(['This morning', 'Just now']);
  });

  it('“today” and “this week” (the last seven days), leaving out system events and deleted messages', () => {
    expect(texts(messagesInRange(detail, 'today', NOW))).toEqual(['This morning', 'Just now']);
    expect(texts(messagesInRange(detail, 'week', NOW))).toEqual([
      'Monday',
      'Yesterday',
      'This morning',
      'Just now',
    ]);
    expect(summaryRangeStart(detail, 'today', NOW)).toBe(new Date(2026, 9, 1).getTime());
  });

  it('“since I last read” a Chat never read covers the last day', () => {
    const never = chat('Never read', messages).detail;
    expect(texts(messagesInRange(never, 'since-read', NOW))).toEqual(['This morning', 'Just now']);
  });
});

describe('a busy Chat', () => {
  it('counts the messages from others since a moment, not the User’s or system events', () => {
    const messages = [
      message(OMAR, NOW - 3 * HOUR),
      message(SAM, NOW - 2 * HOUR),
      message(LEE, NOW - HOUR),
      message(null, NOW - HOUR),
      { ...message(LEE, NOW - 30 * MINUTE), deleted: true },
      message(OMAR, NOW - 10 * MINUTE),
    ];
    const { detail } = chat('Titanlink eng', messages);
    expect(fromOthersSince(detail, 'u-sam', NOW - 4 * HOUR)).toHaveLength(3);
    expect(fromOthersSince(detail, 'u-sam', NOW - 90 * MINUTE)).toHaveLength(2);
  });

  it('is busy at 20 messages from others unless Settings → Ares says otherwise', () => {
    expect(busyChatThreshold({})).toBe(20);
    expect(busyChatThreshold({ busyChatMessages: 35 })).toBe(35);
  });
});
