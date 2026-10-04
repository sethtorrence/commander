import { describe, expect, it } from 'vitest';
import { type AresRankingEntry, aresRanker, type DashboardRanking, rankingFingerprint } from './ares-ranking';
import type { Item } from './items';
import { chatAttention, type RankingContext, rankByBandRules } from './ranking';
import { type ChatDetail, type ChatMessage, type ChatPerson, chatFlags, mutedChatIds } from './teams';

// The band rules for Teams Chats (#107), over fixture Chats, at a fixed local time: Thursday
// 1 October 2026, 11:40. Who the User is in the Teams Account comes from the context, as the window
// knows it from the Account; without it the Chat's own derived flags decide.

const NOW = new Date(2026, 9, 1, 11, 40).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TEAMS = 'teams:tenant:sam';

const SAM: ChatPerson = { userId: 'u-sam', name: 'Sam Rivera' };
const PRIYA: ChatPerson = { userId: 'u-priya', name: 'Priya Patel' };
const DANA: ChatPerson = { userId: 'u-dana', name: 'Dana Whitfield' };
const LEE: ChatPerson = { userId: 'u-lee', name: 'Lee Chen' };

const context: RankingContext = { now: NOW, users: { [TEAMS]: SAM.userId ?? '' } };

let counter = 0;
function message(
  from: ChatPerson | null,
  at: number,
  text = 'hello',
  mentions: ChatPerson[] = [],
): ChatMessage {
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
  };
}

function chat(
  id: string,
  {
    type = 'one-on-one',
    topic = null,
    messages,
    lastReadAt = null,
    ...rest
  }: {
    type?: ChatDetail['chatType'];
    topic?: string | null;
    messages: ChatMessage[];
    lastReadAt?: number | null;
  } & Partial<Item>,
): Item & { detail: ChatDetail } {
  const flags = chatFlags({ messages, lastReadAt }, SAM.userId);
  return {
    id,
    kind: 'chat',
    source: 'teams',
    account: TEAMS,
    externalId: `19:${id}`,
    title: topic ?? id,
    people: [],
    filing: null,
    status: 'open',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    deletedAt: null,
    detail: {
      kind: 'chat',
      chatType: type,
      topic,
      webUrl: null,
      members: [],
      lastReadAt,
      hidden: false,
      joinUrl: null,
      messages,
      ...flags,
    },
    ...rest,
  } as Item & { detail: ChatDetail };
}

const rank = (items: Item[], ctx: RankingContext = context) => rankByBandRules(items, ctx);

describe('Chats in the Today band', () => {
  it('holds a Chat with an unread message mentioning the User, naming who and where', () => {
    const launch = chat('launch', {
      type: 'group',
      topic: 'Titanlink eng',
      messages: [
        message(LEE, NOW - 3 * HOUR, 'Morning'),
        message(PRIYA, new Date(2026, 9, 1, 10, 42).getTime(), '@Sam can you sign off?', [SAM]),
      ],
    });
    expect(rank([launch])).toEqual([
      { itemId: 'launch', band: 'today', reason: 'Priya mentioned you in Titanlink eng · 10:42', rank: 1 },
    ]);
  });

  it('holds an unread one-to-one Chat whose latest message is from the other person', () => {
    const dana = chat('Dana Whitfield', { messages: [message(DANA, NOW - 40 * MINUTE, 'Got a minute?')] });
    expect(rank([dana])).toEqual([
      { itemId: 'Dana Whitfield', band: 'today', reason: 'Dana messaged you 40 min ago', rank: 1 },
    ]);
  });

  it('keeps an unanswered one-to-one Chat once read, until the User replies', () => {
    const messages = [message(SAM, NOW - 5 * HOUR, 'Ping'), message(DANA, NOW - 3 * HOUR, 'Will check')];
    const read = chat('dana', { messages, lastReadAt: NOW - HOUR });
    expect(read.detail.unreadCount).toBe(0);
    expect(rank([read])).toMatchObject([
      { itemId: 'dana', band: 'today', reason: 'Dana messaged you 3h ago' },
    ]);

    const answered = chat('dana', { messages: [...messages, message(SAM, NOW - 2 * HOUR, 'Thanks')] });
    expect(rank([answered])).toEqual([]);
  });

  it('says when an older unanswered message was sent', () => {
    const dana = chat('dana', { messages: [message(DANA, NOW - DAY, 'Any news?')] });
    expect(rank([dana])).toMatchObject([{ reason: 'Dana messaged you yesterday' }]);
    const lee = chat('lee', { messages: [message(LEE, NOW - 3 * DAY, 'Any news?')] });
    expect(rank([lee])).toMatchObject([{ reason: 'Lee messaged you on Monday' }]);
  });

  it('names the day of a mention that isn’t from today', () => {
    const launch = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [message(PRIYA, NOW - DAY, 'sign off?', [SAM])],
    });
    expect(rank([launch])).toMatchObject([{ reason: 'Priya mentioned you in Launch crew · yesterday' }]);
  });
});

describe('Chats left off the Dashboard', () => {
  it('leaves off a busy group or meeting Chat without an unread mention of the User', () => {
    const busy = chat('social', {
      type: 'group',
      topic: 'Social',
      messages: Array.from({ length: 40 }, (_, i) => message(i % 2 ? LEE : PRIYA, NOW - i * MINUTE, 'lol')),
    });
    const standup = chat('standup', {
      type: 'meeting',
      topic: 'Daily standup',
      messages: [
        message(PRIYA, NOW - HOUR, 'Notes'),
        message(LEE, NOW - 30 * MINUTE, '@Priya thanks', [PRIYA]),
      ],
    });
    expect(rank([busy, standup])).toEqual([]);
  });

  it('leaves off a mention the User has read', () => {
    const launch = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [message(PRIYA, NOW - 2 * HOUR, 'sign off?', [SAM])],
      lastReadAt: NOW - HOUR,
    });
    expect(rank([launch])).toEqual([]);
  });

  it('leaves off an answered one-to-one Chat', () => {
    const dana = chat('dana', {
      messages: [message(DANA, NOW - 2 * HOUR, 'Got a minute?'), message(SAM, NOW - HOUR, 'Sure')],
    });
    expect(rank([dana])).toEqual([]);
  });

  it('leaves off a one-to-one Chat with only system events, or nothing in it', () => {
    expect(rank([chat('a', { messages: [message(null, NOW - HOUR)] }), chat('b', { messages: [] })])).toEqual(
      [],
    );
  });

  it('leaves off muted Chats, mention or not', () => {
    const launch = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [message(PRIYA, NOW - HOUR, 'sign off?', [SAM])],
    });
    const dana = chat('dana', { messages: [message(DANA, NOW - HOUR, 'Got a minute?')] });
    expect(rank([launch, dana], { ...context, muted: new Set(['launch', 'dana']) })).toEqual([]);
    expect(rank([launch, dana], { ...context, muted: new Set(['dana']) })).toMatchObject([
      { itemId: 'launch' },
    ]);
  });

  it('knows the muted Chats from the User’s Chat settings, by Account and Teams id', () => {
    const launch = chat('launch', { type: 'group', messages: [] });
    const dana = chat('dana', { messages: [] });
    const settings = [
      { account: TEAMS, chatId: '19:launch', muted: true },
      { account: TEAMS, chatId: '19:dana', muted: false },
      { account: 'teams:other', chatId: '19:dana', muted: true },
    ];
    expect(mutedChatIds([launch, dana], settings)).toEqual(new Set(['launch']));
  });

  it('leaves off excluded (deleted) Chats', () => {
    const dana = chat('dana', { messages: [message(DANA, NOW - HOUR, 'hi')], deletedAt: NOW - MINUTE });
    expect(rank([dana])).toEqual([]);
  });

  it('lets an unanswered one-to-one Chat go after a week', () => {
    const dana = chat('dana', { messages: [message(DANA, NOW - 8 * DAY, 'thanks!')] });
    expect(rank([dana])).toEqual([]);
    const later = chat('dana', { messages: [message(DANA, NOW - 6 * DAY, 'thanks!')] });
    expect(rank([later])).toHaveLength(1);
  });
});

describe('one row per Chat', () => {
  it('shows a Chat once, however many messages mention the User, by the latest of them', () => {
    const latest = message(PRIYA, NOW - 10 * MINUTE, 'and again', [SAM]);
    const launch = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [
        message(PRIYA, NOW - 3 * HOUR, 'sign off?', [SAM]),
        message(LEE, NOW - 2 * HOUR, '@Sam this too', [SAM]),
        latest,
      ],
    });
    const rankings = rank([launch]);
    expect(rankings).toHaveLength(1);
    expect(chatAttention(launch, SAM.userId, NOW)).toEqual({ why: 'mention', message: latest });
  });

  it('gives a one-to-one Chat that mentions the User and is unanswered one row, as a mention', () => {
    const dana = chat('dana', { messages: [message(DANA, NOW - HOUR, '@Sam see this', [SAM])] });
    expect(rank([dana])).toEqual([
      { itemId: 'dana', band: 'today', reason: expect.stringMatching(/^Dana mentioned you · /), rank: 1 },
    ]);
  });
});

describe('the triggering message', () => {
  it('is the latest message from the other person in an unanswered one-to-one Chat', () => {
    const last = message(DANA, NOW - HOUR, 'one more thing');
    const dana = chat('dana', { messages: [message(DANA, NOW - 2 * HOUR, 'hi'), last] });
    expect(chatAttention(dana, SAM.userId, NOW)).toEqual({ why: 'unanswered', message: last });
  });

  it('is found from the Chat’s own flags when the User isn’t known', () => {
    const latest = message(PRIYA, NOW - HOUR, 'sign off?', [SAM]);
    const launch = chat('launch', { type: 'group', topic: 'Launch crew', messages: [latest] });
    expect(chatAttention(launch, null, NOW)).toEqual({ why: 'mention', message: latest });
    expect(rank([launch], { now: NOW, users: {} })).toMatchObject([{ itemId: 'launch', band: 'today' }]);
  });

  it('orders Chats with the band by its time, as the most recent change', () => {
    const older = chat('older', { messages: [message(DANA, NOW - 3 * HOUR, 'hi')], updatedAt: NOW });
    const newer = chat('newer', { messages: [message(LEE, NOW - HOUR, 'hi')], updatedAt: NOW - 5 * DAY });
    const todayTodo: Item = {
      ...older,
      id: 'todo',
      kind: 'todo',
      source: null,
      account: null,
      externalId: null,
      title: 'Due today',
      detail: { kind: 'todo', origin: 'manual', dueOn: '2026-10-01', backedBy: null },
    };
    expect(rank([older, newer, todayTodo]).map((r) => r.itemId)).toEqual(['todo', 'newer', 'older']);
  });
});

describe('beside the next meeting (#128)', () => {
  it('leaves the meeting about to start in Now, and the Chats in Today', () => {
    const start = NOW + 10 * MINUTE;
    const standup: Item = {
      id: 'standup',
      kind: 'event',
      source: 'google-calendar',
      account: 'google:1',
      externalId: 'standup',
      title: 'Standup',
      people: [],
      filing: null,
      status: 'open',
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
      deletedAt: null,
      detail: {
        kind: 'event',
        calendar: { id: 'primary', name: 'Primary', colour: '#9fe1e7' },
        accountEmail: null,
        start: { at: start, timeZone: null, date: null },
        end: { at: start + 15 * MINUTE, timeZone: null, date: null },
        allDay: false,
        location: null,
        description: null,
        organiser: null,
        attendees: [],
        myResponse: 'accepted',
        meetingUrl: null,
        busy: true,
        private: false,
        seriesId: null,
        webUrl: null,
        createdByCommander: null,
      },
    };
    const dana = chat('dana', { messages: [message(DANA, NOW - 5 * MINUTE, 'Got a minute?')] });
    const launch = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [message(PRIYA, NOW - HOUR, 'sign off?', [SAM])],
    });
    expect(rank([launch, dana, standup])).toEqual([
      { itemId: 'standup', band: 'now', reason: 'Starts in 10 minutes', rank: 1 },
      { itemId: 'dana', band: 'today', reason: 'Dana messaged you 5 min ago', rank: 1 },
      { itemId: 'launch', band: 'today', reason: expect.stringMatching(/^Priya mentioned you/), rank: 2 },
    ]);
  });
});

describe('the clock', () => {
  it('counts an unanswered message from when it was sent', () => {
    const dana = chat('dana', { messages: [message(DANA, NOW - 40 * MINUTE, 'hi')] });
    expect(rank([dana], { ...context, now: NOW + 80 * MINUTE })).toMatchObject([
      { reason: 'Dana messaged you 2h ago' },
    ]);
    expect(rank([dana], { ...context, now: NOW - 40 * MINUTE + 30_000 })).toMatchObject([
      { reason: 'Dana messaged you just now' },
    ]);
  });
});

describe('Ares’s ranking of Chats, as the window applies it', () => {
  const launch = () =>
    chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [message(PRIYA, NOW - HOUR, 'sign off?', [SAM])],
    });
  const ranking = (entries: Omit<AresRankingEntry, 'fingerprint'>[], items: Item[]): DashboardRanking => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return {
      by: 'ares',
      at: NOW - 10 * MINUTE,
      why: null,
      entries: entries.map((entry) => {
        const item = byId.get(entry.itemId);
        return { ...entry, fingerprint: item ? rankingFingerprint(item) : 'gone' };
      }),
    };
  };

  it('places a Chat where Ares put it, with his reason', () => {
    const social = chat('social', { type: 'group', topic: 'Social', messages: [message(LEE, NOW - HOUR)] });
    const items = [launch(), social];
    const his = ranking(
      [
        { itemId: 'social', band: 'waiting', rank: 1, reason: 'Lee is waiting on your lunch answer' },
        { itemId: 'launch', band: 'none', rank: 1, reason: '' },
      ],
      items,
    );
    expect(aresRanker(his)(items, context)).toEqual([
      { itemId: 'social', band: 'waiting', rank: 1, reason: 'Lee is waiting on your lunch answer' },
    ]);
  });

  it('never shows a muted Chat, even one he ranked', () => {
    const items = [launch()];
    const his = ranking(
      [{ itemId: 'launch', band: 'now', rank: 1, reason: 'Priya needs a sign-off' }],
      items,
    );
    expect(aresRanker(his)(items, { ...context, muted: new Set(['launch']) })).toEqual([]);
  });

  it('no longer holds once a newer message arrives or the Chat is read: the rules place it again', () => {
    const before = launch();
    const his = ranking([{ itemId: 'launch', band: 'fyi', rank: 1, reason: 'Just chatter' }], [before]);
    const newer = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: [...before.detail.messages, message(PRIYA, NOW - 5 * MINUTE, 'ping', [SAM])],
    });
    expect(rankingFingerprint(newer)).not.toBe(rankingFingerprint(before));
    expect(aresRanker(his)([newer], context)).toMatchObject([{ itemId: 'launch', band: 'today' }]);
    const read = chat('launch', {
      type: 'group',
      topic: 'Launch crew',
      messages: before.detail.messages,
      lastReadAt: NOW,
    });
    expect(rankingFingerprint(read)).not.toBe(rankingFingerprint(before));
  });
});
