import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { chatSummariserIn } from './chat-summary';
import { TeamsSheet } from './TeamsSheet';
import { teamsAccountsIn, teamsChatsIn } from './teams-chats';

// The Teams Section: the User's Teams Chats, mentions and unread first, opened into the Chat view,
// filed into Projects, muted or excluded, and summarised by Ares (through the Updates bridge). It reaches the app only through teams-chats.ts, via the
// window's bridge.
function TeamsSection() {
  const chats = useMemo(() => teamsChatsIn(window.commander.itemStore), []);
  const accounts = useMemo(() => teamsAccountsIn(window.commander), []);
  const summariser = useMemo(() => chatSummariserIn(window.commander.updates), []);
  return (
    <TeamsSheet chats={chats} accounts={accounts} changes={itemChangesFromCore} summariser={summariser} />
  );
}

export const teams: SectionDefinition = {
  id: 'teams',
  label: 'Teams',
  code: 'TMS',
  Component: TeamsSection,
};
