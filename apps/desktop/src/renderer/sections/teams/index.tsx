import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { TeamsSheet } from './TeamsSheet';
import { teamsAccountsIn, teamsChatsIn } from './teams-chats';

// The Teams Section: the User's Teams Chats, mentions and unread first, opened into the Chat view,
// filed into Projects, muted or excluded. It reaches the app only through teams-chats.ts, via the
// window's bridge.
function TeamsSection() {
  const chats = useMemo(() => teamsChatsIn(window.commander.itemStore), []);
  const accounts = useMemo(() => teamsAccountsIn(window.commander), []);
  return <TeamsSheet chats={chats} accounts={accounts} changes={itemChangesFromCore} />;
}

export const teams: SectionDefinition = {
  id: 'teams',
  label: 'Teams',
  code: 'TMS',
  Component: TeamsSection,
};
