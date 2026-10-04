import { join } from 'node:path';
import type { CoreAccessTokenReply, CoreRemoveAccountItems } from '@commander/domain';
import { ipc } from '@commander/domain/ipc';
import { app, BrowserWindow, ipcMain, net, powerMonitor, shell } from 'electron';
import { linearConfig, microsoftConfig, parseBuildConfig } from '../build-config';
import { createLinearAccounts } from '../linear/linear-accounts';
import { createTeamsAccounts } from '../microsoft/teams-accounts';
import type { Secrets } from '../secrets';
import { type CoreSyncMessage, createCoreSyncChannel } from '../sync/core-sync-channel';
import { watchSystemState } from '../sync/system-state';
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
}: {
  secrets: Secrets;
  sendToCore: (message: CoreAccessTokenReply | CoreRemoveAccountItems | CoreSyncMessage) => void;
  // End-to-end tests (COMMANDER_TEST_HOOKS=1) may take the machine offline: COMMANDER_TEST_OFFLINE=1
  // starts Commander offline, and the returned setOnline switches it (checked every half second).
  testHooks?: boolean;
}): { fromCore: (raw: unknown) => boolean; setOnline: (online: boolean) => void } {
  const build = parseBuildConfig(__COMMANDER_BUILD_CONFIG__);
  const linearSettings = linearConfig(build, process.env);
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
      config: microsoftConfig(build, process.env),
      removeItems: ({ id, name }) => core.removeItems({ source: 'teams', account: id, name }),
    }),
  ]);

  // Syncing runs in the Core: it learns the Accounts (and which need reconnecting) from here, and
  // reports a sign-in a Source refused, which may mean the Account needs reconnecting. Sources the
  // Core can't sync yet (Teams, for now) are passed on and left alone there.
  const sync = createCoreSyncChannel({
    send: sendToCore,
    endpoints: { linear: linearSettings.apiUrl },
    onRefused: (account) => void accounts.reportRefused(account),
  });
  const syncAccounts = async () => sync.setAccounts(await accounts.list());
  void syncAccounts();
  // Accounts connected before Commander kept who signed in find out now.
  void accounts.identifyUsers();
  // Syncing pauses while the machine is asleep or offline.
  let testOffline = testHooks && process.env.COMMANDER_TEST_OFFLINE === '1';
  watchSystemState({
    powerMonitor,
    isOnline: () => !testOffline && net.isOnline(),
    onChange: (state) => sync.systemState(state),
    pollMs: testHooks ? 500 : undefined,
  });

  ipcMain.handle(ipc.accounts, (_event, request: unknown) => answerAccountsRequest(accounts, request, sync));
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
    fromCore: (raw) => core.handle(raw) || sync.handle(raw),
    setOnline: (online) => {
      if (testHooks) testOffline = !online;
    },
  };
}
