// Source sync in the Core: the sync engine with every Source adapter, driven by the main process's
// messages (the Accounts, Settings → Accounts commands, the machine asleep or offline) and reporting
// each Account's sync status and refused sign-ins back. Adapters borrow access tokens per request;
// nothing here keeps or logs them. It also knows every Account the main process listed (its name,
// who the User is there, and whether it needs reconnecting, as the main process or a sync found),
// for Ares.
import {
  type AccountSyncStatus,
  type CoreAccountRefused,
  type CoreSyncAccounts,
  type CoreSyncStatus,
  coreSyncAccounts,
  coreSyncCommand,
  coreSystemState,
  type Source,
} from '@commander/domain';
import {
  type CalendarChoices,
  createGitHubSource,
  createGmailSource,
  createGoogleCalendarSource,
  createLinearSource,
  createOutlookCalendarSource,
  createOutlookSource,
  createTeamsSource,
  type FreeBusyRequest,
  type FreeBusyResult,
  type GitHubSourceOptions,
  type GmailSourceOptions,
  type GoogleCalendarSourceOptions,
  type LinearSourceOptions,
  type OutlookCalendarSourceOptions,
  type OutlookSourceOptions,
  type SourceAdapter,
  type SyncWatch,
  type TeamsSourceOptions,
} from '@commander/sources';
import { z } from 'zod';
import type { AccessTokens } from '../access-tokens';
import type { ItemStore } from '../item-store';
import { createSyncEngine, type SyncEngine } from './engine';

export type { SyncEngine, SyncedEvent } from './engine';

// An Account as Ares sees it: its Sources, its name, the User's addresses in it (their own handles that
// are email addresses, when the main process knows them) and whether it needs reconnecting.
export type KnownAccount = {
  account: string;
  sources: readonly Source[];
  name: string | null;
  addresses?: readonly string[];
  needsReconnect: boolean;
};

export type SyncOptions = {
  send: (message: CoreSyncStatus | CoreAccountRefused) => void;
  accessTokens: Pick<AccessTokens, 'request'>;
  // For tests: stands in for the Linear adapter.
  linearSource?: (options: LinearSourceOptions) => SourceAdapter;
  // For tests: stands in for the Teams adapter.
  teamsSource?: (options: TeamsSourceOptions) => SourceAdapter;
  // For tests: stands in for the Google Calendar adapter.
  googleCalendarSource?: (options: GoogleCalendarSourceOptions) => SourceAdapter;
  // For tests: stands in for the Outlook Calendar adapter.
  outlookCalendarSource?: (options: OutlookCalendarSourceOptions) => SourceAdapter;
  // For tests: stands in for the GitHub adapter.
  githubSource?: (options: GitHubSourceOptions) => SourceAdapter;
  // What a GitHub Account watches, for its syncs (Settings → GitHub works out the first selection
  // when there is none yet, asking GitHub at `apiUrl`).
  githubWatch?: (account: string, apiUrl: string) => Promise<SyncWatch | null>;
  // For tests: stands in for the Gmail adapter.
  gmailSource?: (options: GmailSourceOptions) => SourceAdapter;
  // For tests: stands in for the Outlook mail adapter.
  outlookSource?: (options: OutlookSourceOptions) => SourceAdapter;
  random?: () => number;
  log?: (message: string) => void;
  // The Accounts changed, or whether one needs reconnecting did.
  onAccountsChanged?: () => void;
};

// Each calendar Account's calendars and the User's switches live in the Item store.
export function calendarChoicesIn(
  store: Pick<ItemStore, 'calendars' | 'calendarEvents'>,
  source: 'google-calendar' | 'outlook-calendar',
): CalendarChoices {
  return {
    listed: (account, calendars) => store.calendars.listed(account, source, calendars),
    held: (account, calendarId) =>
      store.calendarEvents({ source, account }, calendarId).map((item) => ({
        externalId: item.externalId ?? '',
        title: item.title,
        people: item.people,
        status: item.status,
        detail: item.detail,
      })),
  };
}

const isSyncMessage = z.object({ type: z.enum(['sync-accounts', 'sync-command', 'system-state']) });

export function setUpSync(
  store: ItemStore,
  {
    send,
    accessTokens,
    linearSource = createLinearSource,
    teamsSource = createTeamsSource,
    googleCalendarSource = createGoogleCalendarSource,
    outlookCalendarSource = createOutlookCalendarSource,
    githubSource = createGitHubSource,
    githubWatch,
    gmailSource = createGmailSource,
    outlookSource = createOutlookSource,
    random,
    log = (message) => console.warn(message),
    onAccountsChanged,
  }: SyncOptions,
) {
  // Where Linear lives, from the main process (a fake on this machine in the end-to-end tests).
  let linearApiUrl = 'https://api.linear.app/graphql';
  let graphUrl = 'https://graph.microsoft.com/v1.0';
  let googleCalendarUrl = 'https://www.googleapis.com/calendar/v3';
  let githubApiUrl = 'https://api.github.com';
  let gmailUrl = 'https://gmail.googleapis.com';
  const adapters: SourceAdapter[] = [
    linearSource({ apiUrl: () => linearApiUrl }),
    teamsSource({ graphUrl: () => graphUrl }),
    googleCalendarSource({
      apiUrl: () => googleCalendarUrl,
      calendars: calendarChoicesIn(store, 'google-calendar'),
    }),
    // Outlook Calendar reaches Graph where Teams does.
    outlookCalendarSource({
      graphUrl: () => graphUrl,
      calendars: calendarChoicesIn(store, 'outlook-calendar'),
    }),
    githubSource({ apiUrl: () => githubApiUrl }),
    gmailSource({ gmailUrl: () => gmailUrl }),
    // Outlook mail (#136), through Graph too.
    outlookSource({ graphUrl: () => graphUrl }),
  ];
  const engine: SyncEngine = createSyncEngine({
    store,
    adapters,
    accessTokens,
    watchOf: (account, source) =>
      source === 'github' && githubWatch ? githubWatch(account, githubApiUrl) : null,
    onSignInRefused: (account) => send({ type: 'account-refused', account }),
    random,
    log,
  });
  // The Accounts as the main process last listed them.
  let listed: CoreSyncAccounts['accounts'] = [];
  function accounts(statuses = engine.statuses()): KnownAccount[] {
    const gone = new Set(
      statuses.filter((status) => status.activity === 'needs-reconnect').map((status) => status.account),
    );
    return listed.map((account) => ({
      account: account.id,
      sources: 'sources' in account ? account.sources : [account.source],
      name: account.name ?? null,
      addresses: (account.own?.handles ?? []).filter((handle) => /^[^\s@]+@[^\s@]+$/.test(handle)),
      needsReconnect: account.needsReconnect || gone.has(account.id),
    }));
  }
  let lastAccounts = '';
  function accountsMayHaveChanged(statuses?: AccountSyncStatus[]) {
    const key = JSON.stringify(accounts(statuses));
    if (key === lastAccounts) return;
    lastAccounts = key;
    onAccountsChanged?.();
  }

  engine.onStatus((statuses) => {
    send({ type: 'sync-status', accounts: statuses });
    accountsMayHaveChanged(statuses);
  });

  return {
    engine,

    // A Source's adapter (the email reader fetches parts through it, paced with its syncs).
    adapterFor: (source: Source) => adapters.find((adapter) => adapter.source === source),

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
          if (parsed.data.endpoints.graph) graphUrl = parsed.data.endpoints.graph;
          if (parsed.data.endpoints.googleCalendar) googleCalendarUrl = parsed.data.endpoints.googleCalendar;
          if (parsed.data.endpoints.github) githubApiUrl = parsed.data.endpoints.github;
          if (parsed.data.endpoints.gmail) gmailUrl = parsed.data.endpoints.gmail;
          listed = parsed.data.accounts;
          engine.setAccounts(parsed.data.accounts);
          // The User is a Person too, recognised from their Accounts.
          try {
            store.people.recogniseUser(
              parsed.data.accounts.flatMap((account) => (account.own ? [account.own] : [])),
            );
          } catch (error) {
            log(`Could not recognise the User among People: ${String(error)}`);
          }
          accountsMayHaveChanged();
          return true;
        }
        case 'sync-command': {
          const parsed = coreSyncCommand.safeParse(raw);
          if (!parsed.success) return reject(parsed.error);
          const { command } = parsed.data;
          if (command.op === 'refresh') void engine.refresh(command.account, command.source);
          else if (command.op === 'set-cadence')
            engine.setCadence(command.account, command.minutes, command.source);
          else engine.setAlsoAfterOtherSources(command.account, command.enabled);
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

    accounts: () => accounts(),

    // Where GitHub's REST API lives, as the main process last said.
    githubApiUrl: () => githubApiUrl,

    // Guests' free/busy through one of the User's calendar Accounts (#132), borrowing its token.
    freeBusy(
      account: string,
      source: Source,
      request: Omit<FreeBusyRequest, 'account' | 'accessToken'>,
    ): Promise<FreeBusyResult> {
      const adapter = adapters.find((each) => each.source === source);
      if (!adapter?.freeBusy) return Promise.reject(new Error(`${source} has no free/busy`));
      return adapter.freeBusy({ ...request, account, accessToken: () => accessTokens.request(account) });
    },

    // Who the User is in the Account (their Linear user id), when known.
    me(account: string): string | null {
      return listed.find((each) => each.id === account)?.me ?? null;
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
