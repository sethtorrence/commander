import { join } from 'node:path';
import type { CoreAccessTokenReply, CoreRemoveAccountItems } from '@commander/domain';
import { ipc } from '@commander/domain/ipc';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { linearConfig, parseBuildConfig } from '../build-config';
import { createLinearAccounts } from '../linear/linear-accounts';
import type { Secrets } from '../secrets';
import { createAccountStore } from './account-store';
import { accountsState, answerAccountsRequest } from './accounts-requests';
import { createCoreAccountChannel } from './core-account-channel';

// The private build config (config/local.json, or config/example.json), injected by
// electron.vite.config.ts.
declare const __COMMANDER_BUILD_CONFIG__: unknown;

// Wires Accounts into the app: Settings → Accounts for the window, access tokens and Item removal
// with the Core. Call once the app is ready. Returns the handler for messages from the Core.
export function setUpAccounts({
  secrets,
  sendToCore,
}: {
  secrets: Secrets;
  sendToCore: (message: CoreAccessTokenReply | CoreRemoveAccountItems) => void;
}): { fromCore: (raw: unknown) => boolean } {
  const config = linearConfig(parseBuildConfig(__COMMANDER_BUILD_CONFIG__), process.env);
  const core = createCoreAccountChannel({
    send: sendToCore,
    accessToken: (account) => linear.accessToken(account),
  });
  const linear = createLinearAccounts({
    config,
    secrets,
    store: createAccountStore(join(app.getPath('userData'), 'accounts.json')),
    // Read at call time, so the end-to-end tests can stand in for the browser.
    openBrowser: (url) => shell.openExternal(url),
    removeItems: ({ id, name }) => core.removeItems({ source: 'linear', account: id, name }),
  });

  ipcMain.handle(ipc.accounts, (_event, request: unknown) => answerAccountsRequest(linear, request));
  // Status changes (an Account needing reconnecting) can happen without the window asking.
  linear.onChange(async () => {
    const state = await accountsState(linear);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(ipc.accountsChanged, state);
  });

  return { fromCore: core.handle };
}
