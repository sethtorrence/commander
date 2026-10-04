// The Agent in the Core: Ares's jobs, run by the job runner on what the Core hears of. The Core tells
// it when the User changes Items (typing in a Daily Note becomes a pause trigger once it stops, and a
// change to Todos or Linear issues a Todos-changed one), when Ares did or suggested something, and
// when a Source has synced; it works out for itself when the machine has been idle long enough for
// catch-up work. The main process's idle and lock reports (Updates, #70) call `idle()` too.
import type { CoreMessage, Enqueue } from '@commander/domain';
import type { ModelClient } from '@commander/models';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import type { SyncedEvent } from '../sync';
import { rankDashboardJob } from './rank-dashboard';
import { createJobRunner, type JobRunner } from './runner';
import { spotStuckLinearJob } from './spot-stuck-linear';
import { suggestTodosJob } from './suggest-todos';

export type { JobRunner } from './runner';

export type AgentOptions = {
  gate: Gate;
  client: ModelClient;
  send: (message: Extract<CoreMessage, { type: 'ares-status' | 'dashboard-ranked' }>) => void;
  now?: () => number;
  // How long the User must change nothing before the catch-up runs.
  idleAfterMs?: number;
  // Overrides every job's typing pause (the end-to-end tests shorten it).
  typingPauseMs?: number;
  // The tokens and keys the Core holds: no prompt may carry one.
  secrets?: KnownSecrets;
  // Items the Agent changed outside the gate (a steering warning mark), so open views catch up.
  onItemsChanged?: (itemIds: string[]) => void;
  // Ares's queue for the Update: where the stuck Linear issues he spots go.
  enqueue?: (input: Enqueue) => unknown;
  // Who the User is in a Linear Account (their Linear user id), from Source sync, when known.
  me?: (account: string) => string | null;
  log?: (message: string) => void;
};

export type Agent = {
  runner: JobRunner;
  // The User changed these Items (through the window).
  userChanged(itemIds: string[]): void;
  synced(event: SyncedEvent): void;
  // Ares did or suggested something through the gate (a suggested Todo, say).
  aresChanged(): void;
  // The machine is idle: catch-up work.
  idle(): void;
  stop(): void;
};

const IDLE_AFTER_MS = 5 * 60_000;
const RANK_DASHBOARD_NAME = 'Rank the Dashboard';
// The Items whose changes may move the Dashboard: Todos, and the Linear issues behind them.
const RANKED_KINDS = new Set(['todo', 'linear-issue']);
const IDLE_CHECK_MS = 30_000;

export function setUpAgent(itemStore: ItemStore, options: AgentOptions): Agent {
  const now = options.now ?? Date.now;
  const idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
  let wasRanking = false;
  const runner = createJobRunner({
    jobs: [
      suggestTodosJob(itemStore, { now }),
      rankDashboardJob(itemStore, { now }),
      spotStuckLinearJob(itemStore, { now, enqueue: options.enqueue ?? (() => {}), me: options.me }),
    ],
    client: options.client,
    gate: options.gate,
    store: itemStore.agent,
    injectionWarnings: itemStore.injectionWarnings,
    secrets: options.secrets,
    onItemsChanged: options.onItemsChanged,
    now,
    typingPauseMs: options.typingPauseMs,
    log: options.log,
    onStatus: (status) => {
      options.send({ type: 'ares-status', ...status });
      // Each finished ranking run: the Dashboard reads its ranking again.
      const ranking = status.running.includes(RANK_DASHBOARD_NAME);
      if (wasRanking && !ranking) options.send({ type: 'dashboard-ranked', at: now() });
      wasRanking = ranking;
    },
  });

  let lastChange = now();
  let caughtUp = false;
  const idle = () => runner.trigger({ kind: 'idle' });
  const watch = setInterval(
    () => {
      if (caughtUp || now() - lastChange < idleAfterMs) return;
      caughtUp = true;
      idle();
    },
    Math.min(IDLE_CHECK_MS, idleAfterMs),
  );

  // Anything the User wrote while Commander was closed (or before it last ran): once the pause is
  // up, the jobs that follow typing look at what changed since their last run.
  runner.trigger({ kind: 'typing', itemIds: [] });

  return {
    runner,

    userChanged(itemIds) {
      lastChange = now();
      caughtUp = false;
      const blocks = itemIds.filter((id) => itemStore.get(id)?.item.kind === 'block');
      if (blocks.length) runner.trigger({ kind: 'typing', itemIds: blocks });
      const ranked = itemIds.filter((id) => RANKED_KINDS.has(itemStore.get(id)?.item.kind ?? ''));
      if (ranked.length) runner.trigger({ kind: 'todos-changed', itemIds: ranked });
    },

    aresChanged() {
      runner.trigger({ kind: 'todos-changed', itemIds: [] });
    },

    synced({ source, account }) {
      runner.trigger({ kind: 'source-sync', source, account });
    },

    idle,

    stop() {
      clearInterval(watch);
      runner.stop();
    },
  };
}
