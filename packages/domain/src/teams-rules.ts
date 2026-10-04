import type { RuleField, RuleFieldValue } from './rules';
import type { ChatDetail, ChatType } from './teams';

// Teams' Rule fields (#108): what a Chat can be filed by. "person in Chat is Omar Haddad → TL",
// "Chat is TL eng → TL". Team and channel fields join with Channel posts.

type Readable = Parameters<RuleField['read']>[0];

const choices = ['is', 'is-not'] as const;

/** The User's Microsoft user id in a Teams Account (named `teams:<tenant>:<user>`), or null. */
export function teamsUserOf(account: string | null | undefined): string | null {
  const [source, tenant, user] = (account ?? '').split(':');
  return source === 'teams' && tenant && user ? user : null;
}

const chatOf = (item: Readable): ChatDetail | null =>
  item.source === 'teams' && item.detail?.kind === 'chat' ? item.detail : null;

const CHAT_TYPE_WORDS: Record<ChatType, string> = {
  'one-on-one': 'one-to-one',
  group: 'group',
  meeting: 'meeting',
};

/**
 * The people in a Chat other than the User, as Rules know them: by email address (lower case) or,
 * for someone Teams gives none for, their Teams user id; labelled with their name. The User is in
 * every Chat, so "person in Chat is you" would say nothing.
 */
export function chatPeople(item: Readable): RuleFieldValue[] {
  const chat = chatOf(item);
  if (!chat) return [];
  const me = teamsUserOf(item.account);
  const found = new Map<string, RuleFieldValue>();
  for (const member of chat.members) {
    if (me !== null && member.userId === me) continue;
    const value = member.email?.trim().toLowerCase() || member.userId;
    if (value && !found.has(value)) found.set(value, { value, label: member.name });
  }
  return [...found.values()];
}

export const teamsRuleFields: readonly RuleField[] = [
  {
    id: 'teams.account',
    name: 'Teams account',
    label: 'Account',
    ops: choices,
    read: (item) => {
      const chat = chatOf(item);
      if (!chat || !item.account) return [];
      const me = teamsUserOf(item.account);
      const own = chat.members.find((member) => me !== null && member.userId === me)?.email;
      return [{ value: item.account, label: own || item.account }];
    },
  },
  {
    id: 'teams.chat',
    name: 'Chat',
    label: 'Chat',
    ops: choices,
    read: (item) => (chatOf(item) && item.externalId ? [{ value: item.externalId, label: item.title }] : []),
  },
  {
    id: 'teams.person',
    name: 'person in Chat',
    label: 'Person in Chat',
    ops: choices,
    read: chatPeople,
  },
  {
    id: 'teams.chat-type',
    name: 'Chat type',
    label: 'Chat type',
    ops: choices,
    read: (item) => {
      const chat = chatOf(item);
      return chat ? [{ value: chat.chatType, label: CHAT_TYPE_WORDS[chat.chatType] }] : [];
    },
  },
  {
    id: 'teams.title',
    name: 'Chat name',
    label: 'Chat name',
    ops: ['contains'],
    read: (item) => (chatOf(item) ? [{ value: item.title, label: item.title }] : []),
  },
];
