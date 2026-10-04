// The main process's side of Source sync, which runs in the Core: it tells the Core which Accounts
// to sync (and which need reconnecting), relays what the User asked for in Settings → Accounts and
// the machine's state, and keeps the Core's latest sync status for the window. All validated (see
// sync-messages.ts).
import {
  type AccountSyncStatus,
  type CoreSyncAccounts,
  type CoreSyncCommand,
  type CoreSystemState,
  coreAccountRefused,
  coreSyncStatus,
  SOURCES_OF_ACCOUNT,
  type Source,
} from '@commander/domain';
import type { AccountSource, CarriedSource } from '@commander/domain/ipc';
import { z } from 'zod';

export type CoreSyncMessage = CoreSyncAccounts | CoreSyncCommand | CoreSystemState;

const isSyncReport = z.object({ type: z.enum(['sync-status', 'account-refused']) });

export function createCoreSyncChannel({
  send,
  endpoints,
  onRefused,
}: {
  send: (message: CoreSyncMessage) => void;
  endpoints: CoreSyncAccounts['endpoints'];
  // The Source refused an Account's sign-in during a sync.
  onRefused: (account: string) => void;
}) {
  // The Core's statuses, one per Source of each Account (most Accounts carry one).
  let latest: AccountSyncStatus[] = [];
  const listeners = new Set<() => void>();

  return {
    setAccounts(
      accounts: {
        id: string;
        source: AccountSource;
        status: 'connected' | 'needs-reconnect';
        // Who the User is in the Account (their Linear user), for "assigned to me"; null until known.
        user: { id: string; name: string } | null;
        // The Sources an Account carrying several has, and which are on.
        sources?: CarriedSource[];
      }[],
    ) {
      send({
        type: 'sync-accounts',
        accounts: accounts.flatMap(({ id, source, status, user, sources }): CoreSyncAccounts['accounts'] => {
          const account = { id, needsReconnect: status === 'needs-reconnect', me: user?.id ?? null };
          const [only, ...others] = SOURCES_OF_ACCOUNT[source];
          if (!sources && only && others.length === 0) return [{ ...account, source: only }];
          // Only the Sources switched on sync; with none on, the Account doesn't.
          const on: Source[] = (sources ?? []).filter((each) => each.enabled).map((each) => each.source);
          return on.length > 0 ? [{ ...account, sources: on }] : [];
        }),
        endpoints,
      });
    },

    refresh(account: string) {
      send({ type: 'sync-command', command: { op: 'refresh', account } });
    },

    setCadence(account: string, minutes: number) {
      send({ type: 'sync-command', command: { op: 'set-cadence', account, minutes } });
    },

    systemState(state: { awake: boolean; online: boolean }) {
      send({ type: 'system-state', ...state });
    },

    // The Core's latest sync status for an Account (of `source`, or its first), if it reported one.
    status(account: string, source?: Source): AccountSyncStatus | null {
      return (
        latest.find(
          (status) => status.account === account && (source === undefined || status.source === source),
        ) ?? null
      );
    },

    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // A message from the Core. Returns true when it was a sync report, handled here.
    handle(raw: unknown): boolean {
      const header = isSyncReport.safeParse(raw);
      if (!header.success) return false;
      if (header.data.type === 'account-refused') {
        const refused = coreAccountRefused.safeParse(raw);
        if (refused.success) onRefused(refused.data.account);
        else console.warn('Rejected malformed account-refused message from the Core:', refused.error.message);
        return true;
      }
      const report = coreSyncStatus.safeParse(raw);
      if (!report.success) {
        console.warn('Rejected malformed sync status from the Core:', report.error.message);
        return true;
      }
      latest = report.data.accounts;
      for (const listener of listeners) listener();
      return true;
    },
  };
}

export type CoreSyncChannel = ReturnType<typeof createCoreSyncChannel>;
