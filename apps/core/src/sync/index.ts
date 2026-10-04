// Source sync in the Core: the sync engine with every Source adapter, driven by the main process's
// messages (the Accounts, Settings → Accounts commands, the machine asleep or offline) and reporting
// each Account's sync status and refused sign-ins back. Adapters borrow access tokens per request;
// nothing here keeps or logs them.
import {
  type CoreAccountRefused,
  type CoreSyncStatus,
  coreSyncAccounts,
  coreSyncCommand,
  coreSystemState,
} from '@commander/domain';
import { createLinearSource, type LinearSourceOptions, type SourceAdapter } from '@commander/sources';
import { z } from 'zod';
import type { AccessTokens } from '../access-tokens';
import type { ItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

export type { SyncEngine, SyncedEvent } from './engine';

export type SyncOptions = {
  send: (message: CoreSyncStatus | CoreAccountRefused) => void;
  accessTokens: Pick<AccessTokens, 'request'>;
  // For tests: stands in for the Linear adapter.
  linearSource?: (options: LinearSourceOptions) => SourceAdapter;
  random?: () => number;
  log?: (message: string) => void;
};

const isSyncMessage = z.object({ type: z.enum(['sync-accounts', 'sync-command', 'system-state']) });

export function setUpSync(
  store: ItemStore,
  {
    send,
    accessTokens,
    linearSource = createLinearSource,
    random,
    log = (message) => console.warn(message),
  }: SyncOptions,
) {
  // Where Linear lives, from the main process (a fake on this machine in the end-to-end tests).
  let linearApiUrl = 'https://api.linear.app/graphql';
  const engine: SyncEngine = createSyncEngine({
    store,
    adapters: [linearSource({ apiUrl: () => linearApiUrl })],
    accessTokens,
    onSignInRefused: (account) => send({ type: 'account-refused', account }),
    random,
    log,
  });
  engine.onStatus((accounts) => send({ type: 'sync-status', accounts }));

  return {
    engine,

    // A message from the main process. Returns true when it was a sync message, handled here.
    handle(raw: unknown): boolean {
      const header = isSyncMessage.safeParse(raw);
      if (!header.success) return false;
      const reject = (error: z.ZodError) => {
        log(`Rejected malformed ${header.data.type} message: ${error.message}`);
        return true;
      };
      switch (header.data.type) {
        case 'sync-accounts': {
          const parsed = coreSyncAccounts.safeParse(raw);
          if (!parsed.success) return reject(parsed.error);
          linearApiUrl = parsed.data.endpoints.linear;
          engine.setAccounts(parsed.data.accounts);
          return true;
        }
        case 'sync-command': {
          const parsed = coreSyncCommand.safeParse(raw);
          if (!parsed.success) return reject(parsed.error);
          const { command } = parsed.data;
          if (command.op === 'refresh') void engine.refresh(command.account, command.source);
          else engine.setCadence(command.account, command.minutes, command.source);
          return true;
        }
        case 'system-state': {
          const parsed = coreSystemState.safeParse(raw);
          if (!parsed.success) return reject(parsed.error);
          engine.setSystemState(parsed.data);
          return true;
        }
      }
    },

    // The Account is being removed: stop its syncing before its Items go, so none come back.
    forget(account: string) {
      engine.forget(account);
    },

    stop() {
      engine.stop();
    },
  };
}
