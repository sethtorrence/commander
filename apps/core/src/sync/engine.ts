// The sync engine: one scheduler for every Account of every Source, in the Core. Each Account has
// its own queue, so one Account's failure or slowness never holds up another. It runs each Source's
// adapter on the Account's cadence (with a little random spread) or at once on `refresh`, never two
// syncs of one Account together; saves what the adapter hands over through the Item store; pauses
// while the machine is asleep or offline and catches up once after; backs off exponentially (capped)
// on failures, always honouring the Source's Retry-After; and skips Accounts that need reconnecting.
// Where each Account stands is kept in the Item store's database, so it carries on after a restart.
import type {
  AccountSyncStatus,
  Source,
  SyncActivity,
  SyncOutcomeKind,
  SyncProblem,
  SyncTrigger,
} from '@commander/domain';
import {
  CursorExpired,
  RateLimited,
  SignInRefused,
  type SourceAdapter,
  SourceUnavailable,
  type SyncCost,
  type SyncResult,
} from '@commander/sources';
import { type AccessToken, AccessTokenUnavailable } from '../access-tokens';
import type { ItemStore, SyncState } from '../item-store';

// Back-off after failures: 1, 2, 4… minutes, never more than an hour (a Retry-After can ask for more).
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
// The most a sync's start is spread by at random, so Accounts and Sources don't all fire together.
export const SPREAD_MS = 60_000;
// setTimeout can't wait longer than this; longer waits are re-armed.
const MAX_TIMER_MS = 2 ** 31 - 1;

export type SyncAccount = { id: string; source: Source; needsReconnect: boolean };
export type SystemState = { awake: boolean; online: boolean };
// After every sync of any Account: other Sources can hook in here (Teams syncs alongside each one).
export type SyncedEvent = { account: string; source: Source; outcome: SyncOutcomeKind };

export type SyncEngineOptions = {
  store: ItemStore;
  adapters: SourceAdapter[];
  accessTokens: { request(account: string): Promise<AccessToken> };
  // The Source refused an Account's sign-in: the main process checks it and may mark it Reconnect.
  onSignInRefused?: (account: string) => void;
  now?: () => number;
  random?: () => number;
  log?: (message: string) => void;
};

export type SyncEngine = {
  // Every Account to sync, with whether it needs reconnecting. Accounts not listed stop syncing.
  setAccounts(accounts: SyncAccount[]): void;
  setSystemState(state: SystemState): void;
  // Syncs the Account at once, or joins its sync already running. Resolves when that sync is over
  // (at once when skipped: offline, asleep, needing reconnecting, or waiting out a rate limit).
  refresh(account: string): Promise<void>;
  // Minutes between the Account's syncs, from its Source's choices. Kept across restarts.
  setCadence(account: string, minutes: number): void;
  // The Account was removed: stop it at once, save nothing more from it, and drop its sync state.
  forget(account: string): void;
  statuses(): AccountSyncStatus[];
  onStatus(listener: (statuses: AccountSyncStatus[]) => void): () => void;
  onSynced(listener: (event: SyncedEvent) => void): () => void;
  stop(): void;
};

type Entry = {
  account: SyncAccount;
  adapter: SourceAdapter;
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number | null;
  running: Promise<void> | null;
  abort: AbortController | null;
};

const backoff = (failures: number) =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

export function createSyncEngine({
  store,
  adapters,
  accessTokens,
  onSignInRefused = () => {},
  now = Date.now,
  random = Math.random,
  log = (message) => console.warn(message),
}: SyncEngineOptions): SyncEngine {
  const bySource = new Map(adapters.map((adapter) => [adapter.source, adapter]));
  const entries = new Map<string, Entry>();
  const statusListeners = new Set<(statuses: AccountSyncStatus[]) => void>();
  const syncedListeners = new Set<(event: SyncedEvent) => void>();
  let system: SystemState = { awake: true, online: true };
  let stopped = false;

  const paused = () => !system.awake || !system.online;
  const isCurrent = (entry: Entry) => !stopped && entries.get(entry.account.id) === entry;

  function load({ account }: Entry): SyncState {
    return (
      store.syncState.get(account.id) ?? {
        account: account.id,
        source: account.source,
        cadenceMinutes: null,
        cursor: null,
        lastSyncedAt: null,
        failures: 0,
        retryAt: null,
        problem: null,
      }
    );
  }

  const cadenceMs = (entry: Entry, state: SyncState) =>
    (state.cadenceMinutes ?? entry.adapter.cadence.defaultMinutes) * 60_000;

  function statusOf(entry: Entry): AccountSyncStatus {
    const state = load(entry);
    let activity: SyncActivity = 'idle';
    if (entry.account.needsReconnect) activity = 'needs-reconnect';
    else if (entry.running) activity = 'syncing';
    else if (!system.awake) activity = 'asleep';
    else if (!system.online) activity = 'offline';
    else if (state.retryAt !== null) activity = 'backing-off';
    return {
      account: entry.account.id,
      source: entry.account.source,
      activity,
      cadenceMinutes: cadenceMs(entry, state) / 60_000,
      cadenceChoices: [...entry.adapter.cadence.choices],
      lastSyncedAt: state.lastSyncedAt,
      nextSyncAt: entry.dueAt,
      itemCount: store.syncState.countItems(entry.account.source, entry.account.id),
      problem: state.problem,
    };
  }

  function statuses() {
    return [...entries.values()].map(statusOf);
  }

  function emit() {
    if (stopped || statusListeners.size === 0) return;
    const current = statuses();
    for (const listener of statusListeners) listener(current);
  }

  function clearTimer(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.dueAt = null;
  }

  // Works out the Account's next sync and arms its timer.
  function schedule(entry: Entry) {
    clearTimer(entry);
    if (!isCurrent(entry) || entry.running || entry.account.needsReconnect || paused()) return;
    const state = load(entry);
    let due: number;
    if (state.retryAt !== null) due = state.retryAt;
    else if (state.lastSyncedAt === null) due = now();
    else due = state.lastSyncedAt + cadenceMs(entry, state) + random() * SPREAD_MS;
    // Overdue (after a restart, sleep or going offline): catch up once, soon, spread a little.
    if (due < now()) due = now() + random() * SPREAD_MS;
    arm(entry, due);
  }

  function arm(entry: Entry, due: number) {
    entry.dueAt = Math.round(due);
    const wait = Math.max(0, entry.dueAt - now());
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        if (wait > MAX_TIMER_MS) arm(entry, due);
        else void run(entry, 'scheduled');
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  function run(entry: Entry, trigger: SyncTrigger): Promise<void> {
    if (entry.running) return entry.running;
    if (!isCurrent(entry) || entry.account.needsReconnect || paused()) return Promise.resolve();
    const state = load(entry);
    // A refresh never cuts a Source's Retry-After short.
    if (trigger === 'refresh' && state.problem?.kind === 'rate-limited' && (state.retryAt ?? 0) > now()) {
      return Promise.resolve();
    }
    clearTimer(entry);
    const abort = new AbortController();
    entry.abort = abort;
    entry.running = execute(entry, state.cursor, trigger, abort.signal)
      .catch((error) => log(`Sync engine error for ${entry.account.id}: ${String(error)}`))
      .finally(() => {
        entry.running = null;
        entry.abort = null;
        schedule(entry);
        emit();
      });
    emit();
    return entry.running;
  }

  async function execute(entry: Entry, startCursor: unknown, trigger: SyncTrigger, signal: AbortSignal) {
    const { id: account, source } = entry.account;
    const startedAt = now();
    const saved = { created: 0, updated: 0, tombstoned: 0, unchanged: 0 };
    let result: SyncResult | null = null;
    let failure: unknown = null;
    try {
      let cursor = startCursor;
      for (;;) {
        try {
          result = await entry.adapter.sync({
            account,
            cursor,
            accessToken: () => accessTokens.request(account),
            save(page) {
              if (signal.aborted) throw new Error('The sync was stopped');
              const outcome = store.saveFromSource({
                source,
                account,
                items: page.items,
                deleted: page.deleted,
              });
              saved.created += outcome.created.length;
              saved.updated += outcome.updated.length;
              saved.tombstoned += outcome.tombstoned.length;
              saved.unchanged += outcome.unchanged.length;
            },
            signal,
          });
          break;
        } catch (error) {
          // The Source no longer knows the cursor: sync again from scratch, once.
          if (error instanceof CursorExpired && cursor !== null) {
            log(`${source} no longer accepts ${account}'s sync cursor; syncing it again from scratch`);
            cursor = null;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      failure = error;
    }
    if (signal.aborted || !isCurrent(entry)) return;

    // Read again: the User may have changed the cadence while the sync ran.
    const latest = load(entry);
    let next: SyncState;
    let outcome: SyncOutcomeKind;
    let cost: SyncCost | null = null;
    let problem: SyncProblem | null = null;
    if (result) {
      outcome = 'synced';
      cost = result.cost;
      next = {
        ...latest,
        cursor: result.cursor,
        lastSyncedAt: now(),
        failures: 0,
        retryAt: null,
        problem: null,
      };
    } else {
      const failures = latest.failures + 1;
      const message = failure instanceof Error ? failure.message : String(failure);
      if (failure instanceof AccessTokenUnavailable && failure.reason === 'needs-reconnect') {
        outcome = 'refused';
        problem = { kind: 'refused', message: 'This Account needs reconnecting.' };
        entry.account = { ...entry.account, needsReconnect: true };
        next = { ...latest, retryAt: null, problem };
      } else if (failure instanceof SignInRefused) {
        outcome = 'refused';
        problem = { kind: 'refused', message };
        next = { ...latest, failures, retryAt: now() + backoff(failures), problem };
        onSignInRefused(account);
      } else if (failure instanceof RateLimited) {
        outcome = 'rate-limited';
        cost = failure.cost;
        problem = { kind: 'rate-limited', message };
        const wait = Math.max(failure.retryAfterMs ?? 0, backoff(failures));
        next = { ...latest, failures, retryAt: now() + wait, problem };
      } else if (paused()) {
        // Lost the connection, or the machine slept, mid-sync: not the Source's fault. It catches
        // up when the machine is back.
        outcome = 'failed';
        next = latest;
      } else {
        outcome = 'failed';
        if (failure instanceof SourceUnavailable) cost = failure.cost;
        const known = failure instanceof SourceUnavailable || failure instanceof AccessTokenUnavailable;
        problem = { kind: 'failed', message: known ? message : 'Commander couldn’t sync this Account.' };
        next = { ...latest, failures, retryAt: now() + backoff(failures), problem };
      }
      log(`${source} sync of ${account} did not finish (${outcome}): ${message}`);
    }
    store.syncState.save(next);
    store.syncState.recordRun({
      account,
      source,
      trigger,
      startedAt,
      finishedAt: now(),
      outcome,
      ...saved,
      requests: cost?.requests ?? 0,
      complexity: cost?.complexity ?? null,
      error: problem?.message ?? null,
    });
    for (const listener of syncedListeners) listener({ account, source, outcome });
  }

  function drop(entry: Entry) {
    clearTimer(entry);
    entry.abort?.abort();
    entries.delete(entry.account.id);
  }

  return {
    setAccounts(accounts) {
      const listed = new Set(accounts.map((account) => account.id));
      for (const entry of entries.values()) if (!listed.has(entry.account.id)) drop(entry);
      for (const account of accounts) {
        const adapter = bySource.get(account.source);
        if (!adapter) continue;
        const entry = entries.get(account.id);
        if (!entry) {
          const added: Entry = { account, adapter, timer: null, dueAt: null, running: null, abort: null };
          entries.set(account.id, added);
          schedule(added);
          continue;
        }
        const reconnected = entry.account.needsReconnect && !account.needsReconnect;
        entry.account = account;
        if (reconnected) {
          // A fresh sign-in: forget the old failures and sync at once.
          store.syncState.save({ ...load(entry), failures: 0, retryAt: null, problem: null });
          void run(entry, 'refresh');
        } else if (account.needsReconnect) {
          clearTimer(entry);
        }
      }
      emit();
    },

    setSystemState(state) {
      const wasPaused = paused();
      system = { ...state };
      if (paused()) for (const entry of entries.values()) clearTimer(entry);
      else if (wasPaused) for (const entry of entries.values()) schedule(entry);
      emit();
    },

    refresh(account) {
      const entry = entries.get(account);
      if (!entry) return Promise.resolve();
      const running = run(entry, 'refresh');
      emit();
      return running;
    },

    setCadence(account, minutes) {
      const entry = entries.get(account);
      if (!entry) return;
      if (!entry.adapter.cadence.choices.includes(minutes)) {
        log(`Ignored a cadence of ${minutes} minutes for ${account}: not one of its Source's choices`);
        return;
      }
      store.syncState.save({ ...load(entry), cadenceMinutes: minutes });
      if (!entry.running && entry.timer) schedule(entry);
      emit();
    },

    forget(account) {
      const entry = entries.get(account);
      if (entry) drop(entry);
      store.syncState.remove(account);
      emit();
    },

    statuses,

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    onSynced(listener) {
      syncedListeners.add(listener);
      return () => syncedListeners.delete(listener);
    },

    stop() {
      for (const entry of entries.values()) {
        clearTimer(entry);
        entry.abort?.abort();
      }
      stopped = true;
      entries.clear();
    },
  };
}
