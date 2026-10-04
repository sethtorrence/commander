import { describe, expect, it } from 'vitest';
import type { Item } from './items';
import { describeRule, firstMatch, RULE_FIELDS, RULE_SOURCES, type RuleWhen, ruleMatches } from './rules';
import type { ChatDetail } from './teams';
import { teamsRuleFields, teamsUserOf } from './teams-rules';

// Teams' Rule fields (#108): what a Chat can be filed by. Read from Chats as Teams sync saves them.

const ACCOUNT = 'teams:tenant-1:u-sam';

function chat(detail: Partial<ChatDetail> = {}, title = 'TL eng'): Item {
  return {
    id: 'item-1',
    kind: 'chat',
    source: 'teams',
    account: ACCOUNT,
    externalId: '19:tl-eng@thread.v2',
    title,
    detail: {
      kind: 'chat',
      chatType: 'group',
      topic: title,
      webUrl: null,
      members: [
        { userId: 'u-sam', name: 'Sam Rivera', email: 'sam@contoso.test' },
        { userId: 'u-omar', name: 'Omar Haddad', email: 'Omar@Titanlink.io' },
        { userId: 'u-guest', name: 'A guest', email: null },
      ],
      lastReadAt: null,
      hidden: false,
      joinUrl: null,
      messages: [],
      unreadCount: 0,
      mentionsMe: false,
      latestFromMe: false,
      lastMessageAt: null,
      ...detail,
    },
  } as Item;
}

const linearIssue = {
  kind: 'linear-issue',
  source: 'linear',
  account: 'linear:acme',
  title: 'TL eng',
} as Item;

const fields = new Map(teamsRuleFields.map((field) => [field.id, field]));
const read = (id: string, item: Item) => fields.get(id)?.read(item);

describe('Teams Rule fields', () => {
  it('reads the Account, labelled with the User’s own address in it', () => {
    expect(read('teams.account', chat())).toEqual([{ value: ACCOUNT, label: 'sam@contoso.test' }]);
  });

  it('reads the Chat by its Teams id, labelled with its name', () => {
    expect(read('teams.chat', chat())).toEqual([{ value: '19:tl-eng@thread.v2', label: 'TL eng' }]);
  });

  it('reads the people in the Chat other than the User, by email address or else Teams user id', () => {
    expect(read('teams.person', chat())).toEqual([
      { value: 'omar@titanlink.io', label: 'Omar Haddad' },
      { value: 'u-guest', label: 'A guest' },
    ]);
  });

  it('reads the Chat type and the Chat name', () => {
    expect(read('teams.chat-type', chat())).toEqual([{ value: 'group', label: 'group' }]);
    expect(read('teams.chat-type', chat({ chatType: 'one-on-one' }))).toEqual([
      { value: 'one-on-one', label: 'one-to-one' },
    ]);
    expect(read('teams.chat-type', chat({ chatType: 'meeting' }))).toEqual([
      { value: 'meeting', label: 'meeting' },
    ]);
    expect(read('teams.title', chat({}, 'Omar Haddad'))).toEqual([
      { value: 'Omar Haddad', label: 'Omar Haddad' },
    ]);
  });

  it('reads nothing from an Item that isn’t a Chat', () => {
    for (const field of teamsRuleFields) expect(field.read(linearIssue)).toEqual([]);
  });

  it('are registered for the Rule editor and matching, in the editor’s order', () => {
    expect(RULE_SOURCES.find((each) => each.source === 'teams')?.fields.map((field) => field.id)).toEqual([
      'teams.account',
      'teams.chat',
      'teams.person',
      'teams.chat-type',
      'teams.title',
    ]);
    for (const field of teamsRuleFields) expect(RULE_FIELDS.get(field.id)).toBe(field);
  });

  it('match Chats in Rules, and read as a sentence', () => {
    const omar: RuleWhen = {
      join: 'and',
      terms: [{ field: 'teams.person', op: 'is', value: 'omar@titanlink.io', label: 'Omar Haddad' }],
    };
    const named: RuleWhen = {
      join: 'and',
      terms: [
        { field: 'teams.title', op: 'contains', value: 'tl ', label: 'TL ' },
        { field: 'teams.chat-type', op: 'is-not', value: 'meeting', label: 'meeting' },
      ],
    };
    expect(ruleMatches(omar, chat())).toBe(true);
    expect(ruleMatches(omar, chat({ members: [] }))).toBe(false);
    expect(ruleMatches(named, chat())).toBe(true);
    expect(ruleMatches(named, chat({ chatType: 'meeting' }))).toBe(false);
    expect(firstMatch([{ when: omar }], linearIssue)).toBeUndefined();
    expect(describeRule(omar)).toBe('person in Chat is Omar Haddad');
    expect(describeRule(named)).toBe('Chat name contains “TL ” AND Chat type is not meeting');
    expect(
      describeRule({
        join: 'and',
        terms: [{ field: 'teams.chat', op: 'is', value: '19:tl-eng@thread.v2', label: 'TL eng' }],
      }),
    ).toBe('Chat is TL eng');
  });
});

describe('the User in a Teams Account', () => {
  it('is the Microsoft user id the Account was named with', () => {
    expect(teamsUserOf(ACCOUNT)).toBe('u-sam');
    expect(teamsUserOf('linear:acme')).toBeNull();
    expect(teamsUserOf(null)).toBeNull();
  });
});
