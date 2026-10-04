import type { ChatSetting, Item } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import {
  type Chat,
  chatCounts,
  inFilters,
  isWaiting,
  latestLine,
  messageParts,
  messagesByDay,
  NO_FILTERS,
  orderChats,
  peopleIn,
  reactionSummary,
  toChats,
  unreadChats,
} from './chats';
import { ANA, chat, DAY, HOUR, LEE, message, NOW, PRIYA, SAM, TEAMS } from './test-chats';

// The Teams Section's logic: which Chats come first, the filters and their counts, and how a Chat's
// messages read (one line in the list; by day, with reactions and mentions, in the Chat view).

const item = (input: Parameters<typeof chat>[0]): Item => {
  const source = chat(input);
  return {
    id: `item-${input.id}`,
    kind: 'chat',
    source: 'teams',
    account: TEAMS,
    externalId: source.externalId,
    title: source.title,
    people: [],
    filing: null,
    status: 'open',
    detail: source.detail ?? null,
    createdAt: NOW - DAY,
    updatedAt: NOW,
    deletedAt: null,
  };
};

const muted = (chatId: string): ChatSetting => ({
  account: TEAMS,
  chatId,
  name: chatId,
  muted: true,
  excludedAt: null,
  updatedAt: NOW,
});

const quiet = item({
  id: 'quiet',
  title: 'Quiet',
  messages: [message(PRIYA, 'Old news', 3 * DAY)],
  lastReadAt: NOW,
});
const unread = item({ id: 'unread', title: 'Unread', messages: [message(PRIYA, 'New thing', 2 * HOUR)] });
const newer = item({
  id: 'newer',
  title: 'Newer',
  chatType: 'group',
  messages: [message(LEE, 'Newer thing', HOUR)],
});
const mention = item({
  id: 'mention',
  title: 'Mention',
  chatType: 'meeting',
  messages: [message(PRIYA, '@Sam Rivera look', 5 * HOUR, { mentions: [SAM] })],
});
const noisy = item({
  id: 'noisy',
  title: 'Noisy',
  chatType: 'group',
  messages: [message(ANA, '@Sam Rivera lunch?', 10 * 60_000, { mentions: [SAM] })],
});

describe('ordering Chats', () => {
  it('puts unread mentions of the User first, then other unread Chats, then the rest, each newest first', () => {
    const chats = toChats([quiet, unread, newer, mention, noisy], []);
    expect(orderChats(chats).map((each) => each.title)).toEqual([
      'Noisy',
      'Mention',
      'Newer',
      'Unread',
      'Quiet',
    ]);
  });

  it('drops a muted Chat out of unread ordering and the unread count', () => {
    const chats = toChats([quiet, unread, newer, mention, noisy], [muted('noisy')]);
    expect(orderChats(chats).map((each) => each.title)).toEqual([
      'Mention',
      'Newer',
      'Unread',
      'Noisy',
      'Quiet',
    ]);
    expect(chats.find((each) => each.title === 'Noisy')?.muted).toBe(true);
    expect(unreadChats(chats)).toBe(3);
  });
});

describe('filtering Chats', () => {
  const chats = toChats([quiet, unread, newer, mention, noisy], [muted('noisy')]);

  it('narrows by Chat type and Unread only, together', () => {
    const titles = (filters: Parameters<typeof inFilters>[1]) =>
      chats.filter((each) => inFilters(each, filters)).map((each) => each.title);
    expect(titles({ ...NO_FILTERS, type: 'group' })).toEqual(['Newer', 'Noisy']);
    expect(titles({ ...NO_FILTERS, type: 'group', unreadOnly: true })).toEqual(['Newer']);
    expect(titles({ ...NO_FILTERS, unreadOnly: true })).toEqual(['Unread', 'Newer', 'Mention']);
  });

  it('counts each choice under the other filter: types under Unread only, and unread under the type', () => {
    expect(chatCounts(chats, NO_FILTERS)).toEqual({
      types: { all: 5, 'one-on-one': 2, group: 2, meeting: 1 },
      unread: 3,
      waiting: 0,
    });
    expect(chatCounts(chats, { ...NO_FILTERS, type: 'group', unreadOnly: true })).toEqual({
      types: { all: 3, 'one-on-one': 1, group: 1, meeting: 1 },
      unread: 1,
      waiting: 0,
    });
  });

  it('has a Waiting on you filter: the Chats Ares flagged, never a muted one, counted under the others (#109)', () => {
    const flag = { messageId: 'm', reason: 'Priya asked for the rollout plan', at: NOW };
    const flagged = toChats(
      [
        quiet,
        { ...unread, waiting: flag },
        { ...newer, waiting: flag },
        mention,
        { ...noisy, waiting: flag },
      ],
      [muted('noisy')],
    );
    const titles = (filters: Parameters<typeof inFilters>[1]) =>
      flagged.filter((each) => inFilters(each, filters)).map((each) => each.title);
    expect(flagged.filter(isWaiting).map((each) => each.title)).toEqual(['Unread', 'Newer']);
    expect(titles({ ...NO_FILTERS, waitingOnly: true })).toEqual(['Unread', 'Newer']);
    expect(titles({ ...NO_FILTERS, type: 'group', waitingOnly: true })).toEqual(['Newer']);
    expect(chatCounts(flagged, NO_FILTERS).waiting).toBe(2);
    expect(chatCounts(flagged, { ...NO_FILTERS, type: 'one-on-one' }).waiting).toBe(1);
    expect(chatCounts(flagged, { ...NO_FILTERS, waitingOnly: true })).toMatchObject({
      types: { all: 2, 'one-on-one': 1, group: 1, meeting: 0 },
      unread: 2,
    });
  });
});

describe('how a Chat reads', () => {
  const [launch] = toChats(
    [
      item({
        id: 'launch',
        title: 'Launch crew',
        chatType: 'group',
        members: [
          { userId: SAM.userId, name: SAM.name, email: null },
          { userId: PRIYA.userId, name: PRIYA.name, email: null },
          { userId: LEE.userId, name: LEE.name, email: null },
        ],
        messages: [
          message(LEE, 'Launch moved\n\nto **Thursday**', 26 * HOUR),
          message(SAM, 'Thanks!', 25 * HOUR),
          message(PRIYA, '', 2 * HOUR, { deleted: true }),
          message(null, '', HOUR, { event: 'members added' }),
        ],
      }),
    ],
    [],
  ) as [Chat];

  it('shows its latest message as one line with its sender, skipping deletions and events', () => {
    expect(latestLine(launch, SAM.userId)).toEqual({ sender: 'You', text: 'Thanks!', at: NOW - 25 * HOUR });
    const [other] = toChats([unread], []) as [Chat];
    expect(latestLine(other, SAM.userId)).toEqual({
      sender: 'Priya Patel',
      text: 'New thing',
      at: NOW - 2 * HOUR,
    });
  });

  it('names the people in it, the User last', () => {
    expect(peopleIn(launch, SAM.userId)).toBe('Priya Patel, Lee Chen and you');
  });

  it('groups messages by day, oldest first, the latest day last', () => {
    const days = messagesByDay(launch.detail.messages, NOW);
    expect(days.map((day) => [day.label, day.messages.length])).toEqual([
      ['Yesterday', 2],
      ['Today', 2],
    ]);
  });

  it('sums reactions by kind, in Teams’ words', () => {
    const by = (person: typeof PRIYA) => ({ by: person });
    expect(
      reactionSummary([
        { type: 'like', ...by(PRIYA) },
        { type: 'heart', ...by(LEE) },
        { type: 'like', ...by(LEE) },
        { type: 'like', ...by(ANA) },
        { type: '🎉', ...by(ANA) },
      ]),
    ).toEqual(['Like 3', 'Heart 1', '🎉 1']);
  });
});

describe('the parts of a message’s text', () => {
  it('finds web and mail links, images and mentions of the User, leaving the rest as text', () => {
    expect(
      messageParts(
        '@Sam Rivera see https://contoso.test/plan, [image] or mail priya@x.test (mailto:priya@x.test).',
        ['Sam Rivera'],
      ),
    ).toEqual([
      { kind: 'mention', text: '@Sam Rivera' },
      { kind: 'text', text: ' see ' },
      { kind: 'link', text: 'https://contoso.test/plan', href: 'https://contoso.test/plan' },
      { kind: 'text', text: ', ' },
      { kind: 'image' },
      { kind: 'text', text: ' or mail priya@x.test (' },
      { kind: 'link', text: 'mailto:priya@x.test', href: 'mailto:priya@x.test' },
      { kind: 'text', text: ').' },
    ]);
  });

  it('never makes a link of anything but a web or mail address', () => {
    const parts = messageParts('javascript:alert(1) data:text/html,x file:///etc/passwd vbscript:x', []);
    expect(parts).toEqual([
      { kind: 'text', text: 'javascript:alert(1) data:text/html,x file:///etc/passwd vbscript:x' },
    ]);
  });

  it('highlights only mentions of the User, not of others', () => {
    expect(messageParts('@Priya Patel and @Sam Rivera', ['Sam Rivera'])).toEqual([
      { kind: 'text', text: '@Priya Patel and ' },
      { kind: 'mention', text: '@Sam Rivera' },
    ]);
  });
});
