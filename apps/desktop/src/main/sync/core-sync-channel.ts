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
  coreChannelPostsRefused,
  coreSyncStatus,
  ownHandles,
  SOURCES_OF_ACCOUNT,
  type Source,
} from '@commander/domain';
import type { AccountSource, CarriedSource } from '@commander/domain/ipc';
import { z } from 'zod';

export type CoreSyncMessage = CoreSyncAccounts | CoreSyncCommand | CoreSystemState;

const isSyncReport = z.object({ type: z.enum(['sync-status', 'account-refused', 'channel-posts-refused']) });

export function createCoreSyncChannel({
  send,
  endpoints,
  onRefused,
  onChannelPostsRefused = () => {},
}: {
  send: (message: CoreSyncMessage) => void;
  endpoints: CoreSyncAccounts['endpoints'];
  // The Source refused an Account's sign-in during a sync.
  onRefused: (account: string) => void;
  // Teams refused an Account's channel messages for want of permission (#111).
  onChannelPostsRefused?: (account: string) => void;
}) {
  // The Core's statuses, one per Source of each Account (most Accounts carry one).
  let latest: AccountSyncStatus[] = [];
  const listeners = new Set<() => void>();

  return {
    setAccounts(
      accounts: {
        id: string;
        // What the User sees ("Acme"), for Ares's Reconnect line.
        name?: string;
        source: AccountSource;
        status: 'connected' | 'needs-reconnect';
        // Who the User is in the Account (their Linear user), for "assigned to me"; null until known.
        user: { id: string; name: string } | null;
        // The Sources an Account carrying several has, and which are on.
        sources?: CarriedSource[];
        // When the User connected it (Gmail downloads the 30 days before).
        connectedAt?: number | null;
        // Teams (#111): Channel posts granted, and whether the User switched them on.
        channelPosts?: { granted: boolean; enabled: boolean };
        // Who signed in, by Source (GitHub's login, Google's address, Microsoft's principal name):
        // the User's own handles, so the User is one Person across their Accounts.
        login?: string;
        email?: string;
        userPrincipalName?: string;
      }[],
    ) {
      send({
        type: 'sync-accounts',
        accounts: accounts.flatMap((summary): CoreSyncAccounts['accounts'] => {
          const { id, name, source, status, user, sources, connectedAt, channelPosts } = summary;
          const handles = ownHandles(summary);
          const account = {
            id,
            needsReconnect: status === 'needs-reconnect',
            me: user?.id ?? null,
            ...(name ? { name } : {}),
            ...(connectedAt ? { connectedAt } : {}),
            ...(handles.length ? { own: { handles, name: user?.name ?? null } } : {}),
            ...(channelPosts ? { channelPosts: channelPosts.granted && channelPosts.enabled } : {}),
          };
          const [only, ...others] = SOURCES_OF_ACCOUNT[source];
          if (!sources && only && others.length === 0) return [{ ...account, source: only }];
          // Only the Sources switched on sync; with none on, the Account doesn't.
          const on: Source[] = (sources ?? []).filter((each) => each.enabled).map((each) => each.source);
          return on.length > 0 ? [{ ...account, sources: on }] : [];
        }),
        endpoints,
      });
    },

    // Every Source the Account carries, or just `source`.
    refresh(account: string, source?: Source) {
      send({ type: 'sync-command', command: { op: 'refresh', account, ...(source ? { source } : {}) } });
    },

    setCadence(account: string, minutes: number) {
      send({ type: 'sync-command', command: { op: 'set-cadence', account, minutes } });
    },

    // Teams: whether it also checks whenever another Source syncs.
    setAlsoAfterOtherSources(account: string, enabled: boolean) {
      send({ type: 'sync-command', command: { op: 'set-also-after-other-sources', account, enabled } });
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
      if (header.data.type === 'channel-posts-refused') {
        const refused = coreChannelPostsRefused.safeParse(raw);
        if (refused.success) onChannelPostsRefused(refused.data.account);
        return true;
      }
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
