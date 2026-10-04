// @vitest-environment jsdom
import type {
  AccountsRequest,
  AccountsResponse,
  AccountsState,
  GoogleAccountSummary,
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

const source = (name: 'linear' | 'teams' | 'google') => within(screen.getByTestId(`source-${name}`));

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

describe('Google in Settings → Accounts', () => {
  const alex: GoogleAccountSummary = {
    id: 'google:1045',
    source: 'google',
    name: 'Google · alex@gmail.test',
    email: 'alex@gmail.test',
    method: 'oauth',
    status: 'connected',
    user: { id: '1045', name: 'Alex Kim' },
    sync: null,
    sources: [
      { source: 'gmail', granted: true, enabled: true },
      { source: 'google-calendar', granted: false, enabled: false },
    ],
  };
  const withGoogle = (oauth: boolean): AccountsState['sources'] => [
    ...bothConfigured,
    { source: 'google', oauth, apiKey: false },
  ];
  const google = () => within(screen.getByTestId('source-google'));

  it('connects Google through the browser', async () => {
    state = { accounts: [], sources: withGoogle(true) };
    render(<AccountsPanel no="02" />);

    fireEvent.click(await waitFor(() => google().getByRole('button', { name: 'Connect Google' })));

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'google',
        method: 'oauth',
        reconnect: undefined,
      }),
    );
  });

  it('hides Connect Google, saying why, in a build without the Google client', async () => {
    state = { accounts: [], sources: withGoogle(false) };
    render(<AccountsPanel no="02" />);

    await waitFor(() => expect(google().getByText(/See “Connecting Google” in the README/)).toBeTruthy());
    expect(google().queryByRole('button', { name: 'Connect Google' })).toBeNull();
  });

  it('lists Gmail and Google Calendar under the Account, each switchable, with Grant access for one not granted', async () => {
    state = { accounts: [alex], sources: withGoogle(true) };
    render(<AccountsPanel no="02" />);
    await waitFor(() => google().getByTestId('account'));

    expect(google().getByText(/Google account · Alex Kim · Signed in with Google/)).toBeTruthy();
    const gmail = within(google().getByTestId('carried-source-gmail'));
    const calendar = within(google().getByTestId('carried-source-google-calendar'));
    expect(gmail.getByText('Gmail')).toBeTruthy();
    expect(gmail.getByRole('switch', { name: 'Gmail' }).getAttribute('aria-checked')).toBe('true');
    expect(gmail.queryByRole('button', { name: 'Grant access' })).toBeNull();
    expect(calendar.getByText('Google Calendar')).toBeTruthy();
    expect((calendar.getByRole('switch', { name: 'Google Calendar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(gmail.getByRole('switch', { name: 'Gmail' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'set-source-enabled',
        accountId: alex.id,
        source: 'gmail',
        enabled: false,
      }),
    );

    fireEvent.click(calendar.getByRole('button', { name: 'Grant access' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'google',
        method: 'oauth',
        reconnect: alex.id,
      }),
    );
  });

  it('shows a blocked Workspace plainly under Google', async () => {
    state = { accounts: [], sources: withGoogle(true) };
    const blocked =
      'Your Google Workspace admin hasn’t allowed Commander. Ask them to allow it, or connect a personal account.';
    answer = (request) =>
      request.op === 'connect' ? { ok: false, source: 'google', error: blocked, state } : { ok: true, state };
    render(<AccountsPanel no="02" />);

    fireEvent.click(await waitFor(() => google().getByRole('button', { name: 'Connect Google' })));

    await waitFor(() => expect(google().getByRole('alert').textContent).toBe(blocked));
  });
});
