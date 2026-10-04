// The Agent in the Core: Ares's jobs, run by the job runner on what the Core hears of. The Core tells
// it when the User changes Items (typing in a Daily Note becomes a pause trigger once it stops) and
// when a Source has synced; it works out for itself when the machine has been idle long enough for
// catch-up work. The main process's idle and lock reports (Updates, #70) can call `idle()` too.
import type { CoreMessage } from '@commander/domain';
import type { ModelClient } from '@commander/models';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import type { SyncedEvent } from '../sync';
import { createJobRunner, type JobRunner } from './runner';
import { suggestTodosJob } from './suggest-todos';

export type { JobRunner } from './runner';

export type AgentOptions = {
  gate: Gate;
  client: ModelClient;
  send: (message: Extract<CoreMessage, { type: 'ares-status' }>) => void;
  now?: () => number;
  // How long the User must change nothing before the catch-up runs.
  idleAfterMs?: number;
  // Overrides every job's typing pause (the end-to-end tests shorten it).
  typingPauseMs?: number;
  // The tokens and keys the Core holds: no prompt may carry one.
  secrets?: KnownSecrets;
  // Items the Agent changed outside the gate (a steering warning mark), so open views catch up.
  onItemsChanged?: (itemIds: string[]) => void;
  log?: (message: string) => void;
};

export type Agent = {
  runner: JobRunner;
  // The User changed these Items (through the window).
  userChanged(itemIds: string[]): void;
  synced(event: SyncedEvent): void;
  // The machine is idle: catch-up work.
  idle(): void;
  stop(): void;
};

const IDLE_AFTER_MS = 5 * 60_000;
const IDLE_CHECK_MS = 30_000;

export function setUpAgent(itemStore: ItemStore, options: AgentOptions): Agent {
  const now = options.now ?? Date.now;
  const idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
  const runner = createJobRunner({
    jobs: [suggestTodosJob(itemStore, { now })],
    client: options.client,
    gate: options.gate,
    store: itemStore.agent,
    injectionWarnings: itemStore.injectionWarnings,
    secrets: options.secrets,
    onItemsChanged: options.onItemsChanged,
    now,
    typingPauseMs: options.typingPauseMs,
    log: options.log,
    onStatus: (status) => options.send({ type: 'ares-status', ...status }),
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
