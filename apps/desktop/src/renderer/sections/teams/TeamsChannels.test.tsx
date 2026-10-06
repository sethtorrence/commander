// @vitest-environment jsdom
import type { ItemStore } from '@commander/core/src/item-store';
import type { ChannelMessage, ChannelPostDetail, SourceItem } from '@commander/domain';
import type { TeamsAccountSummary } from '@commander/domain/ipc';
import { Toaster } from '@commander/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemChanges } from '../../item-store/changes';
import { openTestItemStore } from '../../item-store/test-item-store';
import { ProjectsProvider } from '../../projects/context';
import { type ProjectsClient, projectsIn } from '../../projects/projects';
import { ShortcutProvider, ShortcutScope, useActiveScopes } from '../../shortcuts/react';
import { FrameControlsProvider, SectionProvider } from '../section';
import { teams as definition } from '.';
import { channelPostsIn } from './channel-posts';
import { TeamsSheet } from './TeamsSheet';
import { type TeamsAccountsClient, teamsChatsIn } from './teams-chats';
import { HOUR, NOW, PRIYA, SAM, TEAMS } from './test-chats';

// The Teams Section's Channels group (#111), against a real Item store: nothing about channels until
// an Account syncs Channel posts; then posts by team and channel, opened with their replies (seen,
// Commander's own mark), and replied to through the outgoing queue.

let store: ItemStore;
let client: ReturnType<typeof openTestItemStore>['client'];
let changes: ItemChanges;
let projects: ProjectsClient;
let close: () => void;
const controls = { openSection: vi.fn(), setTabCount: vi.fn() };

function account(channelPosts: { granted: boolean; enabled: boolean }): TeamsAccountSummary {
  return {
    id: TEAMS,
    source: 'teams',
    name: 'Teams · sam@contoso.test',
    userPrincipalName: 'sam@contoso.test',
    method: 'oauth',
    status: 'connected',
    user: { id: SAM.userId ?? '', name: SAM.name },
    sync: null,
    channelPosts: { ...channelPosts, permissions: [], adminConsentUrl: null },
  };
}

let current: TeamsAccountSummary[];
const listeners = new Set<(accounts: TeamsAccountSummary[]) => void>();
const accounts: TeamsAccountsClient = {
  list: async () => current,
  syncNow: async () => {},
  onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

let next = 0;
const said = (
  from: typeof PRIYA,
  text: string,
  ago: number,
  rest: Partial<ChannelMessage> = {},
): ChannelMessage => {
  next += 1;
  return {
    id: `cm-${next}`,
    from,
    event: null,
    createdAt: NOW - ago,
    modifiedAt: NOW - ago,
    deleted: false,
    text,
    mentions: [],
    reactions: [],
    attachments: [],
    replyTo: null,
    ...rest,
  };
};

function post(
  team: string,
  channel: string,
  id: string,
  title: string,
  root: ChannelMessage,
  replies: ChannelMessage[] = [],
): SourceItem {
  const detail: ChannelPostDetail = {
    kind: 'channel-post',
    team: { id: `team-${team}`, name: team },
    channel: { id: `19:${channel}@thread.tacv2`, name: channel },
    subject: null,
    post: root,
    replies,
    webUrl: 'https://teams.microsoft.com/l/message/x',
    mentionsMe: false,
    lastActivityAt: Math.max(root.createdAt, ...replies.map((reply) => reply.createdAt)),
  };
  return {
    externalId: `team-${team}/19:${channel}@thread.tacv2/${id}`,
    kind: 'channel-post',
    title,
    detail,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const opened = openTestItemStore();
  ({ store, close, changes, client } = opened);
  projects = projectsIn(client);
  current = [account({ granted: true, enabled: true })];
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  store.saveFromSource({
    source: 'teams',
    account: TEAMS,
    items: [
      post(
        'Titanlink',
        'releases',
        'p1',
        'Release 4.2',
        said(PRIYA, 'Release 4.2 is out <script>alert(1)</script>', 5 * HOUR),
        [said(PRIYA, '@Sam Rivera can you check the notes?', HOUR, { mentions: [SAM] })],
      ),
      post('Titanlink', 'releases', 'p2', 'Freeze on Friday', said(PRIYA, 'Freeze on Friday', 2 * HOUR)),
      post('Ops', 'on-call', 'p3', 'Pager rota', said(PRIYA, 'Pager rota', 3 * HOUR)),
    ],
  });
});

afterEach(() => {
  cleanup();
  close();
  listeners.clear();
  vi.useRealTimers();
});

function Active({ children }: { children: ReactNode }) {
  useActiveScopes(['teams']);
  return children;
}

function renderSheet() {
  const bridge = {
    accounts: async () => ({ ok: true as const, state: { accounts: current, sources: [] } }),
    onAccountsChanged: () => () => {},
  };
  return render(
    <ShortcutProvider>
      <ProjectsProvider client={projects} storage={localStorage}>
        <FrameControlsProvider value={controls}>
          <SectionProvider place={{ definition, number: 8, total: 9, active: true }}>
            <ShortcutScope scope="teams" group="Teams">
              <Active>
                <TeamsSheet
                  chats={teamsChatsIn(client)}
                  accounts={accounts}
                  changes={changes}
                  channelPosts={channelPostsIn(bridge as never, client)}
                />
              </Active>
              <Toaster />
            </ShortcutScope>
          </SectionProvider>
        </FrameControlsProvider>
      </ProjectsProvider>
    </ShortcutProvider>,
  );
}

const postItem = (externalId: string) =>
  store.query({ kinds: ['channel-post'] }).find((item) => item.externalId === externalId);

describe('the Channels group', () => {
  it('isn’t there at all until an Account syncs Channel posts', async () => {
    current = [account({ granted: false, enabled: false })];
    renderSheet();
    await screen.findByText(/No chats here/);
    expect(screen.queryByRole('region', { name: 'Channels' })).toBeNull();
    expect(screen.queryByText('Release 4.2')).toBeNull();

    // Granted but not switched on: still nothing.
    act(() => {
      for (const listener of listeners) listener([account({ granted: true, enabled: false })]);
    });
    expect(screen.queryByRole('region', { name: 'Channels' })).toBeNull();
  });

  it('lists posts by team, then channel, by latest activity, marking an unseen mention', async () => {
    renderSheet();
    const channels = await screen.findByRole('region', { name: 'Channels' });
    const places = (await within(channels).findAllByRole('heading', { level: 3 })).map(
      (heading) => heading.textContent,
    );
    expect(places).toEqual(['Ops / on-call', 'Titanlink / releases']);
    const releases = within(channels).getByRole('region', { name: 'Titanlink / releases' });
    const rows = within(releases).getAllByTestId('teams-channel-post');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Release 4.2', 'Freeze on Friday']);
    expect(within(rows[0] as HTMLElement).getByText('@')).toBeTruthy();
  });

  it('opens a post with its replies, as text only, and marks it seen in Commander alone', async () => {
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Release 4.2' }));
    const view = await screen.findByRole('region', { name: 'Channel post' });
    expect(within(view).getByText('Titanlink / releases · Teams')).toBeTruthy();
    expect(within(view).getByText(/Release 4\.2 is out <script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(view.querySelector('script')).toBeNull();
    expect(
      within(within(view).getByRole('region', { name: 'Replies' })).getByText(/can you check the notes/),
    ).toBeTruthy();

    const id = 'team-Titanlink/19:releases@thread.tacv2/p1';
    await waitFor(() => expect((postItem(id)?.detail as ChannelPostDetail | undefined)?.seenAt).toBe(NOW));
    expect(store.outgoing.forItem(postItem(id)?.id ?? '')).toEqual([]);
  });

  it('replies to the post through the outgoing queue', async () => {
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze on Friday' }));
    const view = await screen.findByRole('region', { name: 'Channel post' });
    fireEvent.change(within(view).getByRole('textbox', { name: 'Reply' }), {
      target: { value: 'Noted, thanks' },
    });
    fireEvent.click(within(view).getByRole('button', { name: 'Send' }));

    const id = postItem('team-Titanlink/19:releases@thread.tacv2/p2')?.id ?? '';
    await waitFor(() =>
      expect(
        store.outgoing
          .forItem(id)
          .map((row) => [row.field.startsWith('reply:'), (row.value as { text: string }).text]),
      ).toEqual([[true, 'Noted, thanks']]),
    );
    expect(await within(view).findByRole('region', { name: 'On its way to Teams' })).toBeTruthy();
  });
});
