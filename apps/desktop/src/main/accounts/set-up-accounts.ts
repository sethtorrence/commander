import { join } from 'node:path';
import type {
  CoreAccessTokenReply,
  CoreGitHubDiscussionRequest,
  CoreGitHubTestItems,
  CoreGitHubWatchRequest,
  CoreRemoveAccountItems,
} from '@commander/domain';
import { ipc } from '@commander/domain/ipc';
import { app, BrowserWindow, ipcMain, net, powerMonitor, shell } from 'electron';
import { githubConfig, googleConfig, linearConfig, microsoftConfig, parseBuildConfig } from '../build-config';
import { ghCli } from '../github/gh-cli';
import { createGitHubAccounts } from '../github/github-accounts';
import { createGitHubDiscussionChannel } from '../github/github-discussion-channel';
import { createGitHubWatchChannel } from '../github/github-watch-channel';
import { createGoogleAccounts } from '../google/google-accounts';
import { createLinearAccounts } from '../linear/linear-accounts';
import { createOutlookAccounts } from '../microsoft/outlook-accounts';
import { createTeamsAccounts } from '../microsoft/teams-accounts';
import type { Secrets } from '../secrets';
import { type CoreSyncMessage, createCoreSyncChannel } from '../sync/core-sync-channel';
import { type SystemState, watchSystemState } from '../sync/system-state';
import { createAccountStore } from './account-store';
import { combineAccounts } from './accounts';
import { accountsState, answerAccountsRequest } from './accounts-requests';
import { createCoreAccountChannel } from './core-account-channel';

// The private build config (config/local.json, or config/example.json), injected by
// electron.vite.config.ts.
declare const __COMMANDER_BUILD_CONFIG__: unknown;

// Wires Accounts into the app: Settings → Accounts for the window; access tokens, Item removal and
// Source sync with the Core. Call once the app is ready. Returns the handler for messages from the Core.
export function setUpAccounts({
  secrets,
  sendToCore,
  testHooks = false,
  whileCoreRuns = (run) => run(),
}: {
  secrets: Secrets;
  sendToCore: (
    message:
      | CoreAccessTokenReply
      | CoreRemoveAccountItems
      | CoreSyncMessage
      | CoreGitHubWatchRequest
      | CoreGitHubDiscussionRequest
      | CoreGitHubTestItems,
  ) => void;
  // End-to-end tests (COMMANDER_TEST_HOOKS=1) may take the machine offline: COMMANDER_TEST_OFFLINE=1
  // starts Commander offline, and the returned setOnline switches it (checked every half second).
  testHooks?: boolean;
  // Runs a request relayed to the Core only while it runs (#200; core-supervisor.ts).
  whileCoreRuns?: <R>(run: () => Promise<R>) => Promise<R | { ok: false; error: string }>;
}): {
  fromCore: (raw: unknown) => boolean;
  // A new Core started after one stopped (#200): it hears the Accounts and the machine's state again.
  coreRestarted: () => void;
  setOnline: (online: boolean) => void;
  // Test hooks only: saves pull requests in the Core as GitHub sync will.
  saveGitHubItems: (account: string, items: CoreGitHubTestItems['items']) => void;
} {
  const build = parseBuildConfig(__COMMANDER_BUILD_CONFIG__);
  const linearSettings = linearConfig(build, process.env);
  const microsoftSettings = microsoftConfig(build, process.env);
  const githubSettings = githubConfig(build, process.env);
  const googleSettings = googleConfig(build, process.env);
  const core = createCoreAccountChannel({
    send: sendToCore,
    accessToken: (account) => accounts.accessToken(account),
  });
  // What every Source's Accounts share: one Accounts file, the keyring, the browser and the Core.
  const shared = {
    secrets,
    store: createAccountStore(join(app.getPath('userData'), 'accounts.json')),
    // Read at call time, so the end-to-end tests can stand in for the browser.
    openBrowser: (url: string) => shell.openExternal(url),
  };
  // Each Source's Accounts, in the order Settings → Accounts shows them.
  const accounts = combineAccounts([
    createLinearAccounts({
      ...shared,
      config: linearSettings,
      removeItems: ({ id, name }) => core.removeItems({ source: 'linear', account: id, name }),
    }),
    createTeamsAccounts({
      ...shared,
      config: microsoftSettings,
      removeItems: ({ id, name }) => core.removeItems({ source: 'teams', account: id, name }),
    }),
    createGitHubAccounts({
      ...shared,
      config: githubSettings,
      gh: ghCli(),
      removeItems: ({ id, name }) => core.removeItems({ source: 'github', account: id, name }),
    }),
    // One sign-in for both Google Sources: removing the Account removes the Items of each.
    createGoogleAccounts({
      ...shared,
      config: googleSettings,
      removeItems: async ({ id, name }) => {
        await core.removeItems({ source: 'gmail', account: id, name });
        await core.removeItems({ source: 'google-calendar', account: id, name });
      },
    }),
    // One Microsoft sign-in (the Teams app's) for both Outlook Sources, mail and calendar.
    createOutlookAccounts({
      ...shared,
      config: microsoftSettings,
      removeItems: async ({ id, name }) => {
        await core.removeItems({ source: 'outlook', account: id, name });
        await core.removeItems({ source: 'outlook-calendar', account: id, name });
      },
    }),
  ]);

  // Syncing runs in the Core: it learns the Accounts (and which need reconnecting) from here, and
  // reports a sign-in a Source refused, which may mean the Account needs reconnecting.
  const sync = createCoreSyncChannel({
    send: sendToCore,
    endpoints: {
      linear: linearSettings.apiUrl,
      graph: microsoftSettings.graphUrl,
      googleCalendar: googleSettings.calendarUrl,
      github: githubSettings.apiUrl,
      gmail: googleSettings.gmailUrl,
    },
    onRefused: (account) => void accounts.reportRefused(account),
    onChannelPostsRefused: (account) => void accounts.channelPostsRefused(account),
  });
  // Each Account with when it was connected (Gmail downloads the 30 days before).
  const syncAccounts = async () => {
    const connected = new Map((await shared.store.list()).map((record) => [record.id, record.connectedAt]));
    sync.setAccounts(
      (await accounts.list()).map((account) => ({
        ...account,
        connectedAt: connected.get(account.id) ?? null,
      })),
    );
  };
  void syncAccounts();
  // Accounts connected before Commander kept who signed in find out now.
  void accounts.identifyUsers();
  // Where Commander's GitHub App is installed may have changed since the last start.
  void accounts.refreshDetails();
  // Syncing pauses while the machine is asleep or offline.
  let testOffline = testHooks && process.env.COMMANDER_TEST_OFFLINE === '1';
  let systemState: SystemState | null = null;
  watchSystemState({
    powerMonitor,
    isOnline: () => !testOffline && net.isOnline(),
    onChange: (state) => {
      systemState = state;
      sync.systemState(state);
    },
    pollMs: testHooks ? 500 : undefined,
  });

  ipcMain.handle(ipc.accounts, (_event, request: unknown) => answerAccountsRequest(accounts, request, sync));
  // Settings → GitHub: the Core lists what each GitHub Account reaches, with the token it borrows.
  const githubWatch = createGitHubWatchChannel({ apiUrl: githubSettings.apiUrl, send: sendToCore });
  ipcMain.handle(ipc.githubWatch, (_event, request: unknown) =>
    whileCoreRuns(() => githubWatch.request(request)),
  );
  // The GitHub Section: the Core fetches a pull request's or issue's discussion when it is opened.
  const githubDiscussion = createGitHubDiscussionChannel({ apiUrl: githubSettings.apiUrl, send: sendToCore });
  ipcMain.handle(ipc.githubDiscussion, (_event, request: unknown) =>
    whileCoreRuns(() => githubDiscussion.request(request)),
  );
  // Status changes (an Account needing reconnecting, a sync finishing) happen without the window asking.
  const broadcast = async () => {
    const state = await accountsState(accounts, sync);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipc.accountsChanged, state);
  };
  accounts.onChange(() => {
    void syncAccounts();
    void broadcast();
  });
  sync.onChange(() => void broadcast());

  return {
    fromCore: (raw) =>
      core.handle(raw) || sync.handle(raw) || githubWatch.settle(raw) || githubDiscussion.settle(raw),
    setOnline: (online) => {
      if (testHooks) testOffline = !online;
    },
    coreRestarted: () => {
      void syncAccounts();
      if (systemState) sync.systemState(systemState);
    },
    saveGitHubItems: (account, items) => {
      if (testHooks) sendToCore({ type: 'github-test-items', account, items });
    },
  };
}
