// The sync engine: one scheduler for every Account of every Source, in the Core. Each Account has
// its own queue, so one Account's failure or slowness never holds up another. An Account may carry
// several Sources that share its sign-in (a Google Account: Gmail and Google Calendar); each of them
// keeps its own cursor, cadence, status and back-off, but they take turns on the Account's one queue,
// so no two calls for one identity ever run at once. It runs each Source's adapter on its cadence
// (with a little random spread) or at once on `refresh`, never two syncs of one Account together;
// saves what the adapter hands over through the Item store; pauses while the machine is asleep or
// offline and catches up once after; backs off exponentially (capped) on failures, always honouring
// the Source's Retry-After; and skips Accounts that need reconnecting. Where each Account stands
// (Source by Source) is kept in the Item store's database, so it carries on after a restart.
//
// Two-way sync's outgoing side runs on the same per-Account queue: changes made in Commander to
// Source Items are queued by the Item store (with the time they were made) and sent from here, one
// Item at a time, never alongside that Account's sync. They wait while offline or asleep and for a
// reconnect; retry with back-off (honouring Retry-After); stop as Couldn't sync after repeated
// failure or when the Source refuses the change outright; and are followed by a refresh. A change
// that lost to a newer one at the Source is dropped, with the Source's value saved and a note. What a
// write saved from the Source's answer (a new issue numbered by Linear) is reported with the refresh.
//
// Sources with a light sync (Teams, whose cadence has `alsoAfterOtherSources`) run full syncs on
// their cadence, counted from the last full one, and a light check on refresh and whenever another
// Source's Account finishes syncing: a moment later, so syncs finishing together cause one check,
// never within 5 minutes of the Account's last sync, never while it is backing off, and not at all
// when the User switches it off.
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
  type Superseded,
  type SyncCost,
  type SyncMode,
  type SyncResult,
  WriteRejected,
} from '@commander/sources';
import { type AccessToken, AccessTokenUnavailable } from '../access-tokens';
import type { ItemStore, OutgoingRow, SyncState } from '../item-store';

// Back-off after failures: 1, 2, 4… minutes, never more than an hour (a Retry-After can ask for more).
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
// The most a sync's start is spread by at random, so Accounts and Sources don't all fire together.
export const SPREAD_MS = 60_000;
// setTimeout can't wait longer than this; longer waits are re-armed.
const MAX_TIMER_MS = 2 ** 31 - 1;
// Outgoing changes retry after 10, 20, 40, 80 seconds; the fifth failure in a row is Couldn't sync.
export const WRITE_BACKOFF_BASE_MS = 10_000;
export const MAX_WRITE_ATTEMPTS = 5;
// Checks alongside other Sources: a moment after another Account's sync finishes (so several finishing
// together cause one), and never within 5 minutes of the Account's last sync.
export const CHECK_DELAY_MS = 5_000;
export const CHECK_INTERVAL_MS = 5 * 60_000;

const SOURCE_NAMES: Record<Source, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-calendar': 'Google Calendar',
  'outlook-calendar': 'Outlook Calendar',
  teams: 'Teams',
  linear: 'Linear',
  github: 'GitHub',
};

const pad = (n: number) => String(n).padStart(2, '0');

// The note on a change from the Source that won over the User's: "Changed in Linear by Priya Patel
// at 14:02" (the newest such change, at the machine's local time).
export function supersededNote(source: Source, superseded: Superseded[]): string | undefined {
  const [first, ...rest] = superseded;
  if (!first) return undefined;
  const newest = rest.reduce((a, b) => (b.at > a.at ? b : a), first);
  const at = new Date(newest.at);
  const by = newest.by ? ` by ${newest.by}` : '';
  return `Changed in ${SOURCE_NAMES[source]}${by} at ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// `me`: who the User is at the Source in the Account (their Linear user id), when known. Most
// Accounts carry one Source (`source`); one that carries several lists those to sync (`sources`).
export type SyncAccount = { id: string; needsReconnect: boolean; me?: string | null } & (
  | { source: Source }
  | { sources: readonly Source[] }
);
export const sourcesOf = (account: SyncAccount): readonly Source[] =>
  'sources' in account ? account.sources : [account.source];
export type SystemState = { awake: boolean; online: boolean };
// After every sync of any Account: other Sources can hook in here (Teams syncs alongside each one).
// `itemIds`: the Items it changed (the Source's, and Todos that followed them), for open views.
export type SyncedEvent = { account: string; source: Source; outcome: SyncOutcomeKind; itemIds: string[] };

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
  // Syncs the Account at once (every Source it carries, or just `source`), or joins its sync already
  // running. Resolves when that sync is over (at once when skipped: offline, asleep, needing
  // reconnecting, or waiting out a rate limit).
  refresh(account: string, source?: Source): Promise<void>;
  // Minutes between the Account's syncs (of `source`, or of each of its Sources offering that
  // choice), from its Source's choices. Kept across restarts.
  setCadence(account: string, minutes: number, source?: Source): void;
  // Sources with a light sync: whether the Account also checks whenever another Source syncs. Kept
  // across restarts.
  setAlsoAfterOtherSources(account: string, enabled: boolean): void;
  // The Account was removed: stop it at once, save nothing more from it, and drop its sync state.
  forget(account: string): void;
  statuses(): AccountSyncStatus[];
  onStatus(listener: (statuses: AccountSyncStatus[]) => void): () => void;
  onSynced(listener: (event: SyncedEvent) => void): () => void;
  stop(): void;
};

// One Source of an Account: its own schedule and sync, on the Account's queue.
type Lane = {
  source: Source;
  adapter: SourceAdapter;
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number | null;
  // Asked for (perhaps still waiting its turn), and actually running.
  running: Promise<void> | null;
  active: boolean;
  abort: AbortController | null;
  // Items saved from the Source's answers to writes since the last sync, reported with the next one.
  written: Set<string>;
  // A check alongside another Source's sync, waiting to run.
  checkTimer: ReturnType<typeof setTimeout> | null;
  // When the Source's last sync of any kind started.
  lastStartedAt: number | null;
};

type Entry = {
  account: SyncAccount;
  lanes: Map<Source, Lane>;
  // The Account's syncs (of every Source it carries) and outgoing writes take turns on this chain,
  // never overlapping.
  turn: Promise<void>;
  writing: Promise<void> | null;
  // More changes arrived while writing: look again once done.
  writeAgain: boolean;
  writeTimer: ReturnType<typeof setTimeout> | null;
  writeAbort: AbortController | null;
  // No writes before this (a rate limit, or a refused sign-in being checked).
  writesHeldUntil: number | null;
};

const backoff = (failures: number) =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
const writeBackoff = (attempts: number) => WRITE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);

// Runs the task once the Account's syncs and writes before it are done.
function takeTurn<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
  const result = entry.turn.then(task, task);
  entry.turn = result.then(
    () => {},
    () => {},
  );
  return result;
}

type WriteOutcome = 'written' | 'next' | 'stop';

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
  const isCurrent = (entry: Entry, lane?: Lane) =>
    !stopped && entries.get(entry.account.id) === entry && (!lane || entry.lanes.get(lane.source) === lane);

  function load({ account }: Entry, { source }: Lane): SyncState {
    return (
      store.syncState.get(account.id, source) ?? {
        account: account.id,
        source,
        cadenceMinutes: null,
        cursor: null,
        lastSyncedAt: null,
        failures: 0,
        retryAt: null,
        problem: null,
        lastFullSyncAt: null,
        alsoAfterOtherSources: null,
      }
    );
  }

  // Whether the Source has a light sync (a cheap check) beside its full one.
  const hasLightSync = (lane: Lane) => lane.adapter.cadence.alsoAfterOtherSources === true;
  const checksAlongside = (lane: Lane, state: SyncState) =>
    hasLightSync(lane) && (state.alsoAfterOtherSources ?? true);

  const cadenceMs = (lane: Lane, state: SyncState) =>
    (state.cadenceMinutes ?? lane.adapter.cadence.defaultMinutes) * 60_000;

  function statusOf(entry: Entry, lane: Lane): AccountSyncStatus {
    const state = load(entry, lane);
    let activity: SyncActivity = 'idle';
    if (entry.account.needsReconnect) activity = 'needs-reconnect';
    else if (lane.active) activity = 'syncing';
    else if (!system.awake) activity = 'asleep';
    else if (!system.online) activity = 'offline';
    else if (state.retryAt !== null) activity = 'backing-off';
    return {
      account: entry.account.id,
      source: lane.source,
      activity,
      cadenceMinutes: cadenceMs(lane, state) / 60_000,
      cadenceChoices: [...lane.adapter.cadence.choices],
      lastSyncedAt: state.lastSyncedAt,
      nextSyncAt: lane.dueAt,
      itemCount: store.syncState.countItems(lane.source, entry.account.id),
      problem: state.problem,
      outgoing: store.outgoing.counts(entry.account.id),
      ...(hasLightSync(lane) ? { alsoAfterOtherSources: checksAlongside(lane, state) } : {}),
    };
  }

  function statuses() {
    return [...entries.values()].flatMap((entry) =>
      [...entry.lanes.values()].map((lane) => statusOf(entry, lane)),
    );
  }

  function emit() {
    if (stopped || statusListeners.size === 0) return;
    const current = statuses();
    for (const listener of statusListeners) listener(current);
  }

  function clearTimer(lane: Lane) {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = null;
    lane.dueAt = null;
  }

  function clearCheckTimer(lane: Lane) {
    if (lane.checkTimer) clearTimeout(lane.checkTimer);
    lane.checkTimer = null;
  }

  // Every Source's timers of the Account: its next sync, and any check alongside others.
  const clearTimers = (entry: Entry) => {
    for (const lane of entry.lanes.values()) {
      clearTimer(lane);
      clearCheckTimer(lane);
    }
  };

  const scheduleAll = (entry: Entry) => {
    for (const lane of entry.lanes.values()) schedule(entry, lane);
  };

  // Syncs every Source of the Account (or just `source`) at once, one after another on its queue.
  const runAll = (entry: Entry, trigger: SyncTrigger, source?: Source) =>
    Promise.all(
      [...entry.lanes.values()]
        .filter((lane) => source === undefined || lane.source === source)
        .map((lane) => run(entry, lane, trigger)),
    ).then(() => {});

  // Works out the Source's next sync and arms its timer.
  function schedule(entry: Entry, lane: Lane) {
    clearTimer(lane);
    if (!isCurrent(entry, lane) || lane.running || entry.account.needsReconnect || paused()) return;
    const state = load(entry, lane);
    // A Source with a light sync counts its cadence from its last full sync, not its last check.
    const last = hasLightSync(lane) ? state.lastFullSyncAt : state.lastSyncedAt;
    let due: number;
    if (state.retryAt !== null) due = state.retryAt;
    else if (last === null) due = now();
    else due = last + cadenceMs(lane, state) + random() * SPREAD_MS;
    // Overdue (after a restart, sleep or going offline): catch up once, soon, spread a little.
    if (due < now()) due = now() + random() * SPREAD_MS;
    arm(entry, lane, due);
  }

  function arm(entry: Entry, lane: Lane, due: number) {
    lane.dueAt = Math.round(due);
    const wait = Math.max(0, lane.dueAt - now());
    lane.timer = setTimeout(
      () => {
        lane.timer = null;
        if (wait > MAX_TIMER_MS) arm(entry, lane, due);
        else void run(entry, lane, 'scheduled');
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  function run(entry: Entry, lane: Lane, trigger: SyncTrigger): Promise<void> {
    if (lane.running) return lane.running;
    if (!isCurrent(entry, lane) || entry.account.needsReconnect || paused()) return Promise.resolve();
    const state = load(entry, lane);
    // A refresh never cuts a Source's Retry-After short.
    if (trigger === 'refresh' && state.problem?.kind === 'rate-limited' && (state.retryAt ?? 0) > now()) {
      return Promise.resolve();
    }
    // A check alongside another Source never runs while backing off.
    if (trigger === 'alongside' && (state.retryAt ?? 0) > now()) return Promise.resolve();
    clearTimer(lane);
    clearCheckTimer(lane);
    lane.lastStartedAt = now();
    const abort = new AbortController();
    lane.abort = abort;
    lane.running = takeTurn(entry, async () => {
      // Switched off or removed while it waited its turn.
      if (abort.signal.aborted || !isCurrent(entry, lane)) return;
      lane.active = true;
      emit();
      try {
        await execute(entry, lane, load(entry, lane).cursor, trigger, abort.signal);
      } finally {
        lane.active = false;
      }
    })
      .catch((error) => log(`Sync engine error for ${entry.account.id} (${lane.source}): ${String(error)}`))
      .finally(() => {
        lane.running = null;
        lane.abort = null;
        schedule(entry, lane);
        emit();
      });
    emit();
    return lane.running;
  }

  async function execute(
    entry: Entry,
    lane: Lane,
    startCursor: unknown,
    trigger: SyncTrigger,
    signal: AbortSignal,
  ) {
    const { id: account } = entry.account;
    const { source } = lane;
    const startedAt = now();
    const saved = { created: 0, updated: 0, tombstoned: 0, unchanged: 0 };
    const changed = new Set<string>(lane.written);
    lane.written.clear();
    const recheck = store.recheckIds({ source, account });
    let result: SyncResult | null = null;
    let failure: unknown = null;
    let mode: SyncMode = 'full';
    try {
      let cursor = startCursor;
      for (;;) {
        // Light only for Sources that have one, with a cursor to check from, off their cadence.
        mode = hasLightSync(lane) && cursor !== null && trigger !== 'scheduled' ? 'light' : 'full';
        try {
          result = await lane.adapter.sync({
            account,
            cursor,
            mode,
            me: entry.account.me ?? null,
            stored: (externalIds) =>
              store.fromSource({ source, account }, externalIds).map((item) => ({
                externalId: item.externalId ?? '',
                title: item.title,
                people: item.people,
                status: item.status,
                detail: item.detail,
              })),
            accessToken: () => accessTokens.request(account),
            recheck,
            saveCatalog(catalog) {
              if (!signal.aborted) store.syncState.saveCatalog(account, source, catalog, now());
            },
            save(page) {
              if (signal.aborted) throw new Error('The sync was stopped');
              const outcome = store.saveFromSource({
                source,
                account,
                items: page.items,
                deleted: page.deleted,
                me: entry.account.me ?? null,
              });
              for (const ids of [outcome.created, outcome.updated, outcome.tombstoned, outcome.todos])
                for (const id of ids) changed.add(id);
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
    if (signal.aborted || !isCurrent(entry, lane)) return;

    // Read again: the User may have changed the cadence while the sync ran.
    const latest = load(entry, lane);
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
        lastFullSyncAt: mode === 'full' ? now() : latest.lastFullSyncAt,
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
    const itemIds = [...changed];
    for (const listener of syncedListeners) listener({ account, source, outcome, itemIds });
  }

  // After another Account's sync: a check of each Account with a light sync that checks alongside
  // others, a moment later (joining one already waiting), unless it synced in the last 5 minutes,
  // is backing off, or can't sync now.
  function checkAlongside({ source, outcome }: SyncedEvent) {
    if (outcome !== 'synced' || stopped) return;
    for (const entry of entries.values()) {
      if (entry.account.needsReconnect || paused()) continue;
      for (const lane of entry.lanes.values()) {
        if (lane.source === source || lane.checkTimer || lane.running) continue;
        const state = load(entry, lane);
        if (!checksAlongside(lane, state) || state.lastSyncedAt === null) continue;
        if ((state.retryAt ?? 0) > now()) continue;
        const last = Math.max(state.lastSyncedAt, lane.lastStartedAt ?? 0);
        if (now() - last < CHECK_INTERVAL_MS) continue;
        lane.checkTimer = setTimeout(() => {
          lane.checkTimer = null;
          if (isCurrent(entry, lane)) void run(entry, lane, 'alongside');
        }, CHECK_DELAY_MS);
      }
    }
  }
  syncedListeners.add(checkAlongside);

  function dropLane(entry: Entry, lane: Lane) {
    clearTimer(lane);
    clearCheckTimer(lane);
    lane.abort?.abort();
    entry.lanes.delete(lane.source);
  }

  function drop(entry: Entry) {
    for (const lane of entry.lanes.values()) dropLane(entry, lane);
    clearWriteTimer(entry);
    entry.writeAbort?.abort();
    entries.delete(entry.account.id);
  }

  function addLane(entry: Entry, adapter: SourceAdapter): Lane {
    const lane: Lane = {
      source: adapter.source,
      adapter,
      timer: null,
      dueAt: null,
      running: null,
      active: false,
      abort: null,
      written: new Set(),
      checkTimer: null,
      lastStartedAt: null,
    };
    entry.lanes.set(adapter.source, lane);
    return lane;
  }

  // The lane of a Source the Account syncs and can write to.
  const writerOf = (entry: Entry, source: Source) => {
    const lane = entry.lanes.get(source);
    return lane?.adapter.write ? lane : undefined;
  };

  // ------------------------------------------------------------------------------------------
  // Outgoing changes (Two-way sync)

  const canWrite = (entry: Entry) =>
    [...entry.lanes.values()].some((lane) => !!lane.adapter.write) &&
    isCurrent(entry) &&
    !entry.account.needsReconnect &&
    !paused();

  function clearWriteTimer(entry: Entry) {
    if (entry.writeTimer) clearTimeout(entry.writeTimer);
    entry.writeTimer = null;
  }

  // Sends the Account's due changes, then refreshes it if any reached the Source.
  function kickWrites(entry: Entry) {
    if (entry.writing) {
      entry.writeAgain = true;
      return;
    }
    if (!canWrite(entry)) return;
    clearWriteTimer(entry);
    entry.writing = takeTurn(entry, () => sendDue(entry))
      .then((wrote) => {
        if (!isCurrent(entry)) return;
        for (const source of wrote) {
          const lane = entry.lanes.get(source);
          if (lane) void run(entry, lane, 'refresh');
        }
      })
      .catch((error) => log(`Outgoing changes for ${entry.account.id} stopped: ${String(error)}`))
      .finally(() => {
        entry.writing = null;
        if (entry.writeAgain) {
          entry.writeAgain = false;
          kickWrites(entry);
        } else scheduleWrites(entry);
        emit();
      });
  }

  // Arms a timer for the Account's next change waiting on a back-off (or a hold).
  function scheduleWrites(entry: Entry) {
    clearWriteTimer(entry);
    if (!canWrite(entry) || entry.writing) return;
    const due = store.outgoing.nextDueAt(entry.account.id);
    if (due === null) return;
    const at = Math.max(due, entry.writesHeldUntil ?? 0);
    entry.writeTimer = setTimeout(
      () => {
        entry.writeTimer = null;
        kickWrites(entry);
      },
      Math.min(MAX_TIMER_MS, Math.max(0, at - now())),
    );
  }

  // Resolves with the Sources it wrote to, to refresh.
  async function sendDue(entry: Entry): Promise<Set<Source>> {
    const wrote = new Set<Source>();
    for (;;) {
      if (!canWrite(entry)) return wrote;
      if (entry.writesHeldUntil !== null && entry.writesHeldUntil > now()) return wrote;
      // Changes to a Source the Account doesn't sync now (switched off) wait for it.
      const changes = store.outgoing
        .due(entry.account.id, now())
        .find(([first]) => first && writerOf(entry, first.source));
      if (!changes?.[0]) return wrote;
      const outcome = await writeItem(entry, changes);
      if (outcome === 'written') wrote.add(changes[0].source);
      if (outcome === 'stop') return wrote;
    }
  }

  // Writes one Item's due changes: settled when they reached the Source (or lost to a newer change
  // there), else back in the queue or stopped as Couldn't sync.
  async function writeItem(entry: Entry, changes: OutgoingRow[]): Promise<WriteOutcome> {
    const { id: account } = entry.account;
    const [first] = changes;
    const lane = first && writerOf(entry, first.source);
    if (!first || !lane?.adapter.write) return 'stop';
    const { source } = lane;
    const ids = changes.map((change) => change.id);
    store.outgoing.markSending(ids);
    emit();
    const abort = new AbortController();
    entry.writeAbort = abort;
    try {
      const result = await lane.adapter.write({
        account,
        externalId: first.externalId,
        changes: changes.map(({ field, value, synced, madeAt }) => ({ field, value, synced, madeAt })),
        accessToken: () => accessTokens.request(account),
        signal: abort.signal,
      });
      if (abort.signal.aborted || !isCurrent(entry)) return 'stop';
      const at = now();
      store.transaction(() => {
        store.outgoing.settle(ids);
        // Edits made to these fields while they were on their way come after this write.
        store.outgoing.follow(
          first.itemId,
          changes.map((change) => change.field),
          at,
        );
        lane.written.add(first.itemId);
        if (result.item) {
          const why = supersededNote(source, result.superseded);
          const saved = store.saveFromSource({
            source,
            account,
            items: [result.item],
            deleted: [],
            why,
            me: entry.account.me ?? null,
          });
          for (const ids of [saved.created, saved.updated, saved.tombstoned, saved.todos])
            for (const id of ids) lane.written.add(id);
        }
      });
      entry.writesHeldUntil = null;
      return 'written';
    } catch (error) {
      if (abort.signal.aborted || !isCurrent(entry)) {
        store.outgoing.release(ids, null);
        return 'stop';
      }
      return writeFailed(entry, source, changes, error);
    } finally {
      entry.writeAbort = null;
    }
  }

  function writeFailed(entry: Entry, source: Source, changes: OutgoingRow[], error: unknown): WriteOutcome {
    const { id: account } = entry.account;
    const ids = changes.map((change) => change.id);
    const message = error instanceof Error ? error.message : String(error);
    log(`A change to ${source} for ${account} did not go through: ${message}`);
    if (error instanceof WriteRejected) {
      // Trying again won't help: Couldn't sync at once, and on with the Account's other changes.
      store.outgoing.fail(ids, { error: message, failed: true, nextAttemptAt: null });
      return 'next';
    }
    if (error instanceof AccessTokenUnavailable && error.reason === 'needs-reconnect') {
      store.outgoing.release(ids, null);
      entry.account = { ...entry.account, needsReconnect: true };
      return 'stop';
    }
    if (error instanceof SignInRefused) {
      // The main process checks the sign-in and may mark the Account Reconnect; until then, wait.
      store.outgoing.release(ids, null);
      entry.writesHeldUntil = now() + BACKOFF_BASE_MS;
      onSignInRefused(account);
      return 'stop';
    }
    if (error instanceof RateLimited) {
      const wait = Math.max(error.retryAfterMs ?? 0, WRITE_BACKOFF_BASE_MS);
      store.outgoing.release(ids, null);
      entry.writesHeldUntil = now() + wait;
      return 'stop';
    }
    if (paused()) {
      // Lost the connection, or the machine slept, mid-write: it goes when the machine is back.
      store.outgoing.release(ids, null);
      return 'stop';
    }
    const attempts = Math.max(...changes.map((change) => change.attempts)) + 1;
    const known = error instanceof SourceUnavailable || error instanceof AccessTokenUnavailable;
    store.outgoing.fail(ids, {
      error: known ? message : `Commander couldn’t send this change to ${SOURCE_NAMES[source]}.`,
      failed: attempts >= MAX_WRITE_ATTEMPTS,
      nextAttemptAt: now() + writeBackoff(attempts),
    });
    return 'stop';
  }

  // Nothing is on its way after a restart; changes queued (by the window, the gate, an undo) go now.
  store.outgoing.resetSending();
  const stopListening = store.outgoing.onChange((account) => {
    const entry = entries.get(account);
    if (entry) kickWrites(entry);
    emit();
  });

  return {
    setAccounts(accounts) {
      const listed = new Set(accounts.map((account) => account.id));
      for (const entry of entries.values()) if (!listed.has(entry.account.id)) drop(entry);
      for (const account of accounts) {
        const adapters = sourcesOf(account).flatMap((source) => bySource.get(source) ?? []);
        let entry = entries.get(account.id);
        if (!entry && adapters.length === 0) continue;
        const isNew = !entry;
        if (!entry) {
          entry = {
            account,
            lanes: new Map(),
            turn: Promise.resolve(),
            writing: null,
            writeAgain: false,
            writeTimer: null,
            writeAbort: null,
            writesHeldUntil: null,
          };
          entries.set(account.id, entry);
        }
        const reconnected = entry.account.needsReconnect && !account.needsReconnect;
        entry.account = account;
        // Sources switched off (or no longer carried) stop; those switched on start.
        const wanted = new Set(adapters.map((adapter) => adapter.source));
        for (const lane of entry.lanes.values()) if (!wanted.has(lane.source)) dropLane(entry, lane);
        const added = adapters.filter((adapter) => !entry.lanes.has(adapter.source));
        for (const adapter of added) schedule(entry, addLane(entry, adapter));
        if (entry.lanes.size === 0) {
          drop(entry);
          continue;
        }
        if (reconnected) {
          // A fresh sign-in: forget the old failures and sync at once.
          for (const lane of entry.lanes.values())
            store.syncState.save({ ...load(entry, lane), failures: 0, retryAt: null, problem: null });
          entry.writesHeldUntil = null;
          void runAll(entry, 'refresh');
        } else if (account.needsReconnect) {
          clearTimers(entry);
          clearWriteTimer(entry);
        }
        if (isNew || reconnected || added.length > 0) kickWrites(entry);
      }
      emit();
    },

    setSystemState(state) {
      const wasPaused = paused();
      system = { ...state };
      if (paused()) {
        for (const entry of entries.values()) {
          clearTimers(entry);
          clearWriteTimer(entry);
        }
      } else if (wasPaused) {
        for (const entry of entries.values()) {
          scheduleAll(entry);
          kickWrites(entry);
        }
      }
      emit();
    },

    refresh(account, source) {
      const entry = entries.get(account);
      if (!entry) return Promise.resolve();
      const running = runAll(entry, 'refresh', source);
      emit();
      return running;
    },

    setCadence(account, minutes, source) {
      const entry = entries.get(account);
      if (!entry) return;
      const lanes = [...entry.lanes.values()].filter(
        (lane) =>
          (source === undefined || lane.source === source) && lane.adapter.cadence.choices.includes(minutes),
      );
      if (lanes.length === 0) {
        log(`Ignored a cadence of ${minutes} minutes for ${account}: not one of its Source's choices`);
        return;
      }
      for (const lane of lanes) {
        store.syncState.save({ ...load(entry, lane), cadenceMinutes: minutes });
        if (!lane.running && lane.timer) schedule(entry, lane);
      }
      emit();
    },

    setAlsoAfterOtherSources(account, enabled) {
      const entry = entries.get(account);
      if (!entry) return;
      const lanes = [...entry.lanes.values()].filter(hasLightSync);
      if (lanes.length === 0) {
        log(`Ignored checking ${account} alongside other Sources: its Source has no light sync`);
        return;
      }
      for (const lane of lanes) {
        store.syncState.save({ ...load(entry, lane), alsoAfterOtherSources: enabled });
        if (!enabled) clearCheckTimer(lane);
      }
      emit();
    },

    forget(account) {
      const entry = entries.get(account);
      if (entry) drop(entry);
      store.syncState.remove(account);
      store.outgoing.removeAccount(account);
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
      stopListening();
      for (const entry of entries.values()) {
        clearTimers(entry);
        for (const lane of entry.lanes.values()) lane.abort?.abort();
        clearWriteTimer(entry);
        entry.writeAbort?.abort();
      }
      stopped = true;
      entries.clear();
    },
  };
}
