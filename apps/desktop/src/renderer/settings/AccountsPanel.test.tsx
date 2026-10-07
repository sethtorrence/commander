// @vitest-environment jsdom
import type {
  AccountsRequest,
  AccountsResponse,
  AccountsState,
  GitHubAccountSummary,
  GoogleAccountSummary,
  LinearAccountSummary,
  OutlookAccountSummary,
  TeamsAccountSummary,
} from '@commander/domain/ipc';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
let answer: (request: AccountsRequest) => AccountsResponse | Promise<AccountsResponse>;
// What the main process pushes when the Accounts change without the window asking.
let pushState: (state: AccountsState) => void;

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
      onAccountsChanged: (listener: (state: AccountsState) => void) => {
        pushState = listener;
        return () => {};
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const source = (name: 'linear' | 'teams' | 'github' | 'google' | 'outlook') =>
  within(screen.getByTestId(`source-${name}`));

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

  it('says before removing an Account that snapshots hold its data until they age out, and that Wipe removes it at once', async () => {
    state = { accounts: [acme], sources: bothConfigured };
    render(<AccountsPanel no="02" />);
    const account = within(await waitFor(() => source('linear').getByTestId('account')));

    fireEvent.click(account.getByRole('button', { name: 'Remove' }));

    const dialog = within(await screen.findByTestId('remove-account-dialog'));
    expect(dialog.getByText(/removes its Linear issues for good/)).toBeTruthy();
    const snapshots = dialog.getByTestId('remove-account-snapshots').textContent;
    expect(snapshots).toContain('last 7 daily snapshots until it ages out (up to 7 days)');
    expect(snapshots).toContain('Wipe all Commander data, in Settings → Data, removes everything at once.');
    fireEvent.click(dialog.getByRole('button', { name: 'Remove Acme' }));
    await waitFor(() => expect(requests).toContainEqual({ op: 'remove', accountId: acme.id }));
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

const octocat: GitHubAccountSummary = {
  id: 'github:583231',
  source: 'github',
  name: 'octocat',
  login: 'octocat',
  signedInWith: 'github-app',
  installations: ['octocat', 'acme-org'],
  installUrl: 'https://github.com/apps/commander/installations/new',
  method: 'oauth',
  status: 'connected',
  user: { id: '583231', name: 'The Octocat' },
  sync: null,
};

const withGitHub = (github: Partial<AccountsState['sources'][number]> = {}): AccountsState['sources'] => [
  ...bothConfigured,
  { source: 'github', oauth: true, apiKey: true, cli: true, ...github },
];

describe('Settings → Accounts: GitHub', () => {
  it('lists GitHub Accounts by login, with where the app is installed and Install on another org…', async () => {
    state = { accounts: [octocat], sources: withGitHub() };

    render(<AccountsPanel no="02" />);

    await waitFor(() => expect(source('github').getByTestId('account-name').textContent).toBe('octocat'));
    const github = source('github');
    expect(github.getByText(/GitHub user · The Octocat · Signed in with the GitHub App/)).toBeTruthy();
    expect(github.getByTestId('github-installations').textContent).toContain(
      'Installed on octocat, acme-org',
    );
    const install = github.getByRole('link', { name: 'Install on another org…' }) as HTMLAnchorElement;
    expect(install.href).toBe(octocat.installUrl);
    expect(install.target).toBe('_blank');
    fireEvent.click(github.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(requests).toContainEqual({ op: 'refresh-details', accountId: octocat.id }));
  });

  it('says when the app isn’t installed anywhere yet', async () => {
    state = { accounts: [{ ...octocat, installations: [] }], sources: withGitHub() };

    render(<AccountsPanel no="02" />);

    await waitFor(() =>
      expect(source('github').getByTestId('github-installations').textContent).toMatch(
        /isn’t installed anywhere yet/,
      ),
    );
  });

  it('shows no installations for a token Account', async () => {
    state = {
      accounts: [{ ...octocat, method: 'api-key', signedInWith: 'gh', installations: null }],
      sources: withGitHub(),
    };

    render(<AccountsPanel no="02" />);

    await waitFor(() => expect(source('github').getByText(/Signed in with gh/)).toBeTruthy());
    expect(source('github').queryByTestId('github-installations')).toBeNull();
  });

  it('connects GitHub with a code to enter on GitHub: Copy code, Open GitHub and Cancel', async () => {
    state = { accounts: [], sources: withGitHub() };
    let finish: (response: AccountsResponse) => void = () => {};
    answer = (request) =>
      request.op === 'connect' ? new Promise((resolve) => (finish = resolve)) : { ok: true, state };
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AccountsPanel no="02" />);

    fireEvent.click(await waitFor(() => source('github').getByRole('button', { name: 'Connect GitHub' })));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'github',
        method: 'oauth',
        reconnect: undefined,
      }),
    );
    const prompt = {
      source: 'github' as const,
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: Date.now() + 900_000,
    };
    act(() => pushState({ ...state, deviceCode: prompt }));

    const dialog = within(await waitFor(() => screen.getByTestId('github-device-code')));
    expect(dialog.getByTestId('github-user-code').textContent).toBe('WDJB-MJHT');
    fireEvent.click(dialog.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('WDJB-MJHT'));
    const open = dialog.getByRole('link', { name: 'Open GitHub' }) as HTMLAnchorElement;
    expect(open.href).toBe(prompt.verificationUri);
    expect(open.target).toBe('_blank');
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(requests).toContainEqual({ op: 'cancel-sign-in' }));
    act(() => finish({ ok: true, state }));
    await waitFor(() => expect(screen.queryByTestId('github-device-code')).toBeNull());
  });

  it('connects with a classic token instead, saying what it needs', async () => {
    state = { accounts: [], sources: withGitHub() };
    render(<AccountsPanel no="02" />);

    fireEvent.click(
      await waitFor(() => source('github').getByRole('button', { name: 'Use a token instead' })),
    );
    expect(source('github').getByText(/repo and read:org scopes/)).toBeTruthy();
    fireEvent.change(source('github').getByLabelText('GitHub classic personal access token'), {
      target: { value: 'ghp_example' },
    });
    fireEvent.click(source('github').getByRole('button', { name: 'Connect with token' }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'github',
        method: 'api-key',
        apiKey: 'ghp_example',
        reconnect: undefined,
      }),
    );
  });

  it('clears a connected token from the always-open form of a build without the app', async () => {
    state = { accounts: [], sources: withGitHub({ oauth: false }) };
    render(<AccountsPanel no="02" />);
    const field = (await waitFor(() =>
      source('github').getByLabelText('GitHub classic personal access token'),
    )) as HTMLInputElement;

    fireEvent.change(field, { target: { value: 'ghp_example' } });
    fireEvent.click(source('github').getByRole('button', { name: 'Connect with token' }));

    await waitFor(() =>
      expect(
        (source('github').getByLabelText('GitHub classic personal access token') as HTMLInputElement).value,
      ).toBe(''),
    );
  });

  it('reuses gh’s sign-in when gh is installed', async () => {
    state = { accounts: [], sources: withGitHub() };
    render(<AccountsPanel no="02" />);
    fireEvent.click(
      await waitFor(() => source('github').getByRole('button', { name: 'Use a token instead' })),
    );

    fireEvent.click(source('github').getByRole('button', { name: 'Use my gh sign-in' }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'github',
        method: 'cli',
        reconnect: undefined,
      }),
    );
  });

  it('offers only the token fallbacks in a build without the GitHub App, and gh’s only when installed', async () => {
    state = { accounts: [], sources: withGitHub({ oauth: false, cli: false }) };

    render(<AccountsPanel no="02" />);

    await waitFor(() =>
      expect(source('github').getByLabelText('GitHub classic personal access token')).toBeTruthy(),
    );
    expect(source('github').queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    expect(source('github').queryByRole('button', { name: 'Use my gh sign-in' })).toBeNull();
    expect(source('github').getByText(/See “Connecting GitHub” in the README/)).toBeTruthy();
  });

  it('reconnects a token Account with a token, and an app Account with a new code', async () => {
    state = {
      accounts: [
        { ...octocat, status: 'needs-reconnect' },
        {
          ...octocat,
          id: 'github:2',
          name: 'mona',
          login: 'mona',
          method: 'api-key',
          signedInWith: 'classic-token',
          installations: null,
          status: 'needs-reconnect',
        },
      ],
      sources: withGitHub(),
    };
    render(<AccountsPanel no="02" />);
    const [app, token] = await waitFor(() => source('github').getAllByTestId('account'));

    fireEvent.click(within(app as HTMLElement).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'github',
        method: 'oauth',
        reconnect: octocat.id,
      }),
    );
    fireEvent.click(within(token as HTMLElement).getByRole('button', { name: 'Reconnect' }));
    fireEvent.change(source('github').getByLabelText('GitHub classic personal access token'), {
      target: { value: 'ghp_new' },
    });
    fireEvent.click(source('github').getByRole('button', { name: 'Reconnect mona' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'github',
        method: 'api-key',
        apiKey: 'ghp_new',
        reconnect: 'github:2',
      }),
    );
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

  it('lists Linear, Teams, GitHub and Google together, each with its own Connect', async () => {
    state = {
      accounts: [],
      sources: [...withGoogle(true), { source: 'github', oauth: true, apiKey: true }],
    };
    render(<AccountsPanel no="02" />);

    await waitFor(() => expect(google().getByRole('button', { name: 'Connect Google' })).toBeTruthy());
    for (const name of ['linear', 'teams', 'github', 'google'] as const) expect(source(name)).toBeTruthy();
    expect(source('github').getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });

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

  it('lists Google Calendar’s calendars, each with a switch that turns it on or off', async () => {
    const on = { ...alex, sources: [{ source: 'google-calendar' as const, granted: true, enabled: true }] };
    state = { accounts: [on], sources: withGoogle(true) };
    const calendars = [
      {
        account: alex.id,
        source: 'google-calendar',
        id: 'alex@gmail.test',
        name: 'alex@gmail.test',
        colour: '#9fe1e7',
        primary: true,
        accessRole: 'owner',
        on: true,
      },
      {
        account: alex.id,
        source: 'google-calendar',
        id: 'holidays',
        name: 'Holidays in United Kingdom',
        colour: '#16a765',
        primary: false,
        accessRole: 'reader',
        on: false,
      },
      {
        account: 'google:other',
        source: 'google-calendar',
        id: 'other',
        name: 'Someone else’s',
        colour: '#000000',
        primary: true,
        accessRole: 'owner',
        on: true,
      },
    ];
    const asked: unknown[] = [];
    Object.assign(window.commander, {
      itemStore: async (request: { op: string; calendarId?: string; on?: boolean }) => {
        asked.push(request);
        if (request.op === 'set-calendar-enabled') {
          return calendars.map((each) =>
            each.id === request.calendarId ? { ...each, on: request.on } : each,
          );
        }
        return calendars;
      },
    });
    render(<AccountsPanel no="02" />);
    const list = await waitFor(() => within(google().getByTestId('calendar-switches')));

    expect(
      list
        .getAllByRole('switch')
        .map((each) => [each.getAttribute('aria-label'), each.getAttribute('aria-checked')]),
    ).toEqual([
      ['alex@gmail.test', 'true'],
      ['Holidays in United Kingdom', 'false'],
    ]);
    expect(list.getByText('Subscribed')).toBeTruthy();

    fireEvent.click(list.getByRole('switch', { name: 'Holidays in United Kingdom' }));
    await waitFor(() =>
      expect(asked).toContainEqual({
        op: 'set-calendar-enabled',
        account: alex.id,
        calendarId: 'holidays',
        on: true,
      }),
    );
    await waitFor(() =>
      expect(
        list.getByRole('switch', { name: 'Holidays in United Kingdom' }).getAttribute('aria-checked'),
      ).toBe('true'),
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

describe('Outlook in Settings → Accounts', () => {
  const samOutlook: OutlookAccountSummary = {
    id: 'outlook:tenant-1:user-9',
    source: 'outlook',
    name: 'Outlook · sam@contoso.test',
    userPrincipalName: 'sam@contoso.test',
    method: 'oauth',
    status: 'connected',
    user: { id: 'user-9', name: 'Sam Rivera' },
    sync: null,
    sources: [
      { source: 'outlook', granted: true, enabled: true },
      { source: 'outlook-calendar', granted: false, enabled: false },
    ],
  };
  const withOutlook = (oauth: boolean): AccountsState['sources'] => [
    ...bothConfigured,
    { source: 'outlook', oauth, apiKey: false },
  ];
  const outlook = () => source('outlook');

  it('connects Outlook through the browser, once for mail and calendar', async () => {
    state = { accounts: [], sources: withOutlook(true) };
    render(<AccountsPanel no="02" />);

    expect(await waitFor(() => outlook().getByText(/both Outlook mail and Outlook Calendar/))).toBeTruthy();
    fireEvent.click(outlook().getByRole('button', { name: 'Connect Outlook' }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'outlook',
        method: 'oauth',
        reconnect: undefined,
      }),
    );
  });

  it('hides Connect Outlook, saying why, in a build without the Microsoft app', async () => {
    state = { accounts: [], sources: withOutlook(false) };
    render(<AccountsPanel no="02" />);

    await waitFor(() => expect(outlook().getByText(/See “Connecting Outlook” in the README/)).toBeTruthy());
    expect(outlook().queryByRole('button', { name: 'Connect Outlook' })).toBeNull();
  });

  it('lists Outlook and Outlook Calendar under the Account, each switchable, with Grant access for one not granted', async () => {
    state = { accounts: [samOutlook], sources: withOutlook(true) };
    render(<AccountsPanel no="02" />);
    await waitFor(() => outlook().getByTestId('account'));

    expect(outlook().getByText(/Microsoft account · Sam Rivera · Signed in with Microsoft/)).toBeTruthy();
    const mail = within(outlook().getByTestId('carried-source-outlook'));
    const calendar = within(outlook().getByTestId('carried-source-outlook-calendar'));
    expect(mail.getByRole('switch', { name: 'Outlook' }).getAttribute('aria-checked')).toBe('true');
    expect(calendar.getByText('Not allowed in Microsoft')).toBeTruthy();
    expect((calendar.getByRole('switch', { name: 'Outlook Calendar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(mail.getByRole('switch', { name: 'Outlook' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'set-source-enabled',
        accountId: samOutlook.id,
        source: 'outlook',
        enabled: false,
      }),
    );

    fireEvent.click(calendar.getByRole('button', { name: 'Grant access' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'outlook',
        method: 'oauth',
        reconnect: samOutlook.id,
      }),
    );
  });

  it('lists Outlook Calendar’s calendars, each with a switch that turns it on or off', async () => {
    const on: OutlookAccountSummary = {
      ...samOutlook,
      sources: [{ source: 'outlook-calendar', granted: true, enabled: true }],
    };
    state = { accounts: [on], sources: withOutlook(true) };
    const calendars = [
      {
        account: on.id,
        source: 'outlook-calendar',
        id: 'AAMk-default=',
        name: 'Calendar',
        colour: '#0078d4',
        primary: true,
        accessRole: 'owner',
        on: true,
      },
      {
        account: on.id,
        source: 'outlook-calendar',
        id: 'AAMk-dana=',
        name: 'Dana Ruiz',
        colour: '#4f9ee8',
        primary: false,
        accessRole: 'reader',
        on: false,
      },
    ];
    const asked: unknown[] = [];
    Object.assign(window.commander, {
      itemStore: async (request: { op: string; calendarId?: string; on?: boolean }) => {
        asked.push(request);
        if (request.op === 'set-calendar-enabled') {
          return calendars.map((each) =>
            each.id === request.calendarId ? { ...each, on: request.on } : each,
          );
        }
        return calendars;
      },
    });
    render(<AccountsPanel no="02" />);
    const list = await waitFor(() => within(outlook().getByTestId('calendar-switches')));

    expect(
      list
        .getAllByRole('switch')
        .map((each) => [each.getAttribute('aria-label'), each.getAttribute('aria-checked')]),
    ).toEqual([
      ['Calendar', 'true'],
      ['Dana Ruiz', 'false'],
    ]);
    fireEvent.click(list.getByRole('switch', { name: 'Dana Ruiz' }));
    await waitFor(() =>
      expect(asked).toContainEqual({
        op: 'set-calendar-enabled',
        account: on.id,
        calendarId: 'AAMk-dana=',
        on: true,
      }),
    );
  });

  it('offers Reconnect for an Outlook Account whose sign-in was refused for good', async () => {
    state = { accounts: [{ ...samOutlook, status: 'needs-reconnect' }], sources: withOutlook(true) };
    render(<AccountsPanel no="02" />);

    fireEvent.click(await waitFor(() => outlook().getByRole('button', { name: 'Reconnect' })));

    await waitFor(() =>
      expect(requests).toContainEqual({
        op: 'connect',
        source: 'outlook',
        method: 'oauth',
        reconnect: samOutlook.id,
      }),
    );
  });

  it('shows a tenant that needs admin consent under Outlook, with the permissions and the link', async () => {
    state = { accounts: [], sources: withOutlook(true) };
    answer = (request) =>
      request.op === 'connect'
        ? {
            ok: false,
            source: 'outlook',
            error: 'Your organisation needs an administrator to approve Commander.',
            adminConsent: {
              permissions: ['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'],
              url: 'https://login.example.test/tenant/adminconsent?client_id=app',
            },
            state,
          }
        : { ok: true, state };
    render(<AccountsPanel no="02" />);

    fireEvent.click(await waitFor(() => outlook().getByRole('button', { name: 'Connect Outlook' })));

    const permissions = await waitFor(() => outlook().getByTestId('admin-consent-permissions'));
    expect(
      within(permissions)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite']);
  });
});
