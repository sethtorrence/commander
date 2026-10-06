// @vitest-environment jsdom
import type { ChannelChoices, ChannelSettingAction } from '@commander/domain';
import type { AccountsResponse, TeamsAccountSummary } from '@commander/domain/ipc';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelPostsSettings } from './ChannelPostsSettings';
import type { ChannelPostsClient } from './channel-posts';

// Settings → Teams → Channel posts (#111): off with what's needed until Microsoft grants reading
// channels, then the switch, then the teams and channels with exclude.

const URL = 'https://login.test/tenant/adminconsent?client_id=app';
const PERMISSIONS = ['ChannelMessage.Read.All', 'ChannelMessage.Send'];

function account(channelPosts: { granted: boolean; enabled: boolean }): TeamsAccountSummary {
  return {
    id: 'teams:t:u-sam',
    source: 'teams',
    name: 'Teams · sam@contoso.test',
    userPrincipalName: 'sam@contoso.test',
    method: 'oauth',
    status: 'connected',
    user: { id: 'u-sam', name: 'Sam' },
    sync: null,
    channelPosts: { ...channelPosts, permissions: PERMISSIONS, adminConsentUrl: URL },
  };
}

const CHOICES: ChannelChoices = {
  account: 'teams:t:u-sam',
  listedAt: 1,
  teams: [
    {
      id: 'team-tl',
      name: 'Titanlink',
      excluded: false,
      channels: [
        { id: 'c-general', name: 'General', excluded: false },
        { id: 'c-releases', name: 'releases', excluded: false },
      ],
    },
  ],
};

function fakeClient(initial: TeamsAccountSummary, answer?: Partial<AccountsResponse>) {
  let current = initial;
  const asked: string[] = [];
  const changes: ChannelSettingAction[] = [];
  const response = (): AccountsResponse =>
    ({ ok: true, state: { accounts: [current], sources: [] }, ...answer }) as AccountsResponse;
  const client: ChannelPostsClient = {
    accounts: async () => [current],
    onAccounts: () => () => {},
    requestAccess: async (id) => {
      asked.push(`request ${id}`);
      if (!answer) current = account({ granted: true, enabled: false });
      return response();
    },
    setEnabled: async (id, enabled) => {
      asked.push(`set ${id} ${enabled}`);
      current = account({ granted: true, enabled });
      return response();
    },
    syncNow: async (id) => {
      asked.push(`sync ${id}`);
    },
    choices: async () => [CHOICES],
    change: async (action) => {
      changes.push(action);
      return CHOICES;
    },
    list: async () => [],
    reply: async () => {
      throw new Error('not here');
    },
    markSeen: async () => {
      throw new Error('not here');
    },
    kindOf: async () => null,
  };
  return { client, asked, changes };
}

afterEach(() => cleanup());

describe('Channel posts in Settings → Teams', () => {
  it('without the permission: explains what’s needed, names it, shows the steps and the admin consent link', async () => {
    const { client, asked } = fakeClient(account({ granted: false, enabled: false }));
    render(<ChannelPostsSettings client={client} />);
    const section = await screen.findByRole('region', { name: 'Channel posts' });
    expect(within(section).getByText(/Channel posts need the delegated permission/)).toBeTruthy();
    expect(within(section).getAllByText('ChannelMessage.Read.All').length).toBeGreaterThan(0);
    expect(within(section).getByTestId('channel-posts-steps').textContent).toMatch(/Grant admin consent/);
    expect((within(section).getByLabelText('Admin consent link') as HTMLInputElement).value).toBe(URL);
    expect(within(section).queryByRole('switch')).toBeNull();
    expect(within(section).queryByText('Titanlink')).toBeNull();

    fireEvent.click(within(section).getByRole('button', { name: 'Request access' }));
    await waitFor(() =>
      expect(within(section).getByRole('switch', { name: 'Sync Channel posts' })).toBeTruthy(),
    );
    expect(asked).toEqual(['request teams:t:u-sam']);
    expect(within(section).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('shows Microsoft’s admin consent answer when the tenant needs an administrator', async () => {
    const { client } = fakeClient(account({ granted: false, enabled: false }), {
      ok: false,
      error: 'Your organisation needs an administrator to approve Commander.',
      adminConsent: { permissions: PERMISSIONS, url: URL },
    });
    render(<ChannelPostsSettings client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/needs an administrator/);
    expect(screen.getByTestId('admin-consent-permissions').textContent).toContain('ChannelMessage.Send');
  });

  it('once granted: the switch, and with it on the teams and channels, each with Exclude', async () => {
    const { client, asked, changes } = fakeClient(account({ granted: true, enabled: false }));
    render(<ChannelPostsSettings client={client} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Sync Channel posts' }));
    const list = await screen.findByRole('list', { name: 'Teams and channels' });
    expect(asked).toEqual(['set teams:t:u-sam true']);
    expect(within(list).getByText('Titanlink')).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Exclude Titanlink / releases' }));
    await waitFor(() =>
      expect(changes).toEqual([
        { account: 'teams:t:u-sam', teamId: 'team-tl', channelId: 'c-releases', change: 'exclude' },
      ]),
    );
  });
});
