import { useMemo } from 'react';
import { itemChangesFromCore } from '../../item-store/changes';
import type { SectionDefinition } from '../section';
import { channelPostsIn } from './channel-posts';
import { chatSummariserIn } from './chat-summary';
import { chatWorkIn } from './chat-work';
import { TeamsSheet } from './TeamsSheet';
import { teamsAccountsIn, teamsChatsIn } from './teams-chats';

// The Teams Section: the User's Teams Chats, mentions and unread first, opened into the Chat view,
// with the Channels group under them once an Account syncs Channel posts (#111, channel-posts.ts),
// filed into Projects, muted or excluded, and summarised by Ares (through the Updates bridge), with
// his suggested Todos and replies and Draft (chat-work.ts). It reaches the app only through
// teams-chats.ts and chat-work.ts, via the window's bridge.
function TeamsSection() {
  const chats = useMemo(() => teamsChatsIn(window.commander.itemStore), []);
  const accounts = useMemo(() => teamsAccountsIn(window.commander), []);
  const summariser = useMemo(() => chatSummariserIn(window.commander.updates), []);
  const work = useMemo(() => chatWorkIn(window.commander), []);
  const channelPosts = useMemo(() => channelPostsIn(window.commander, window.commander.itemStore), []);
  return (
    <TeamsSheet
      chats={chats}
      accounts={accounts}
      channelPosts={channelPosts}
      changes={itemChangesFromCore}
      summariser={summariser}
      work={work}
    />
  );
}

export const teams: SectionDefinition = {
  id: 'teams',
  label: 'Teams',
  code: 'TMS',
  Component: TeamsSection,
};
