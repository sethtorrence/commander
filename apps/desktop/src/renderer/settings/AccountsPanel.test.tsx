// @vitest-environment jsdom
import type {
  AccountsRequest,
  AccountsResponse,
  AccountsState,
  LinearAccountSummary,
  TeamsAccountSummary,
} from '@commander/domain/ipc';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsPanel } from './AccountsPanel';

// Settings → Accounts over a stand-in for the main process: what it lists, and what it answers.

const acme: LinearAccountSummary = {
  id: 'linear:org-acme',
  source: 'linear',
  name: 'Acme',
  urlKey: 'acme',
  method: 'oauth',
  status: 'connected',
  user: { id: 'user-1', name: 'Sam Rivera' },
  sync: null,
};

const samTeams: TeamsAccountSummary = {
  id: 'teams:tenant-1:user-9',
  source: 'teams',
  name: 'Teams · sam@contoso.test',
  userPrincipalName: 'sam@contoso.test',
  method: 'oauth',
  status: 'connected',
  user: { id: 'user-9', name: 'Sam Rivera' },
  sync: null,
};

const bothConfigured: AccountsState['sources'] = [
  { source: 'linear', oauth: true, apiKey: true },
  { source: 'teams', oauth: true, apiKey: false },
];

let state: AccountsState;
let requests: AccountsRequest[];
let answer: (request: AccountsRequest) => AccountsResponse;

beforeEach(() => {
  state = { accounts: [], sources: bothConfigured };
  requests = [];
  answer = () => ({ ok: true, state });
  Object.assign(window, {
    commander: {
      accounts: async (request: AccountsRequest) => {
        requests.push(request);
        return answer(request);
      },
      onAccountsChanged: () => () => {},
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const source = (name: 'linear' | 'teams') => within(screen.getByTestId(`source-${name}`));

describe('Settings → Accounts', () => {
  it('groups the Accounts by Source, each Source with its own Connect', async () => {
    state = { accounts: [acme, samTeams], sources: bothConfigured };

    render(<AccountsPanel no="02" />);

    await waitFor(() =>
      expect(source('teams').getByTestId('account-name').textContent).toContain(samTeams.name),
    );
    expect(
      source('linear')
        .getAllByTestId('account-name')
        .map((name) => name.textContent),
    ).toEqual(['Acme']);
    expect(
      (source('linear').getByRole('button', { name: 'Connect Linear' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (source('teams').getByRole('button', { name: 'Connect Teams' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(source('teams').getByText(/Microsoft work account · Sam Rivera/)).toBeTruthy();
  });

  it('connects Teams through the browser', async () => {
    render(<AccountsPanel no="02" />);
    const connect = await waitFor(() => source('teams').getByRole('button', { name: 'Connect Teams' }));

    fireEvent.click(connect);

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'teams',
        method: 'oauth',
        reconnect: undefined,
      }),
    );
  });

  it('shows Connect Teams disabled, with a pointer to the README, in a build without the Microsoft app', async () => {
    state = {
      accounts: [],
      sources: [
        { source: 'linear', oauth: true, apiKey: true },
        { source: 'teams', oauth: false, apiKey: false },
      ],
    };

    render(<AccountsPanel no="02" />);

    await waitFor(() =>
      expect(
        (source('teams').getByRole('button', { name: 'Connect Teams' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(source('teams').getByText(/See “Connecting Teams” in the README/)).toBeTruthy();
  });

  it('offers Reconnect and Remove on a Teams Account', async () => {
    state = { accounts: [{ ...samTeams, status: 'needs-reconnect' }], sources: bothConfigured };
    render(<AccountsPanel no="02" />);
    const account = within(await waitFor(() => source('teams').getByTestId('account')));

    expect(account.getByTestId('account-status').textContent).toContain('Needs reconnecting');
    fireEvent.click(account.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'teams',
        method: 'oauth',
        reconnect: samTeams.id,
      }),
    );
    expect(account.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('explains a tenant that needs admin consent under Teams, with the permissions and the link to copy', async () => {
    const url = 'https://login.example/tenant-1/adminconsent?client_id=app';
    answer = (request) =>
      request.op === 'connect'
        ? {
            ok: false,
            source: 'teams',
            error:
              'Your organisation needs an administrator to approve Commander before you can connect Teams.',
            adminConsent: { permissions: ['User.Read', 'Chat.ReadWrite'], url },
            state,
          }
        : { ok: true, state };
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AccountsPanel no="02" />);

    fireEvent.click(await waitFor(() => source('teams').getByRole('button', { name: 'Connect Teams' })));

    const alert = within(await waitFor(() => source('teams').getByRole('alert')));
    expect(alert.getByText(/needs an administrator to approve Commander/)).toBeTruthy();
    expect(alert.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'User.Read',
      'Chat.ReadWrite',
    ]);
    expect((alert.getByLabelText('Admin consent link') as HTMLInputElement).value).toBe(url);
    fireEvent.click(alert.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    expect(source('linear').queryByRole('alert')).toBeNull();
  });
});
