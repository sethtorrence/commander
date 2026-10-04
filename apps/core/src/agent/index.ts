// The Agent in the Core: Ares's jobs, run by the job runner on what the Core hears of. The Core tells
// it when the User changes Items (typing in a Daily Note becomes a pause trigger once it stops, and a
// change to Todos or Linear issues a Todos-changed one), when Ares did or suggested something, and
// when a Source has synced; it works out for itself when the machine has been idle long enough for
// catch-up work. The main process's idle and lock reports (Updates, #70) call `idle()` too, and the
// User coming back calls `active()`: the daily GitHub summary may be due (#121).
import { type CoreMessage, DRAFT_REPLIES, type Enqueue, SUGGEST_TEAMS_REPLIES } from '@commander/domain';
import type { ModelClient } from '@commander/models';
import type { Gate } from '../autonomy/gate';
import type { ItemStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import type { SyncedEvent } from '../sync';
import { blockTimeForTodosJob } from './block-time-for-todos';
import { fileIntoProjectsJob } from './file-into-projects';
import { createFiling, type Filing } from './filing';
import { createGitHubSummaries, type GitHubSummaries } from './github-summaries';
import { prepareMeetingsJob } from './prepare-meetings';
import { proposeEventsJob } from './propose-events';
import { rankDashboardJob } from './rank-dashboard';
import { createJobRunner, type JobRunner } from './runner';
import { createSeriesFiling } from './series-filing';
import { spotStuckLinearJob } from './spot-stuck-linear';
import { clearAnswered, spotWaitingJob } from './spot-waiting';
import { suggestChatTodosJob } from './suggest-chat-todos';
import { dismissAnsweredInvitations, suggestInvitationRepliesJob } from './suggest-invitation-replies';
import { dismissSettledReplies, suggestTeamsRepliesJob } from './suggest-teams-replies';
import { suggestTodosJob } from './suggest-todos';
import { writeGitHubSummaryJob } from './write-github-summary';

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
  // Who the User is in an Account (their Linear or Teams user id), from Source sync, when known.
  me?: (account: string) => string | null;
  // The GitHub summary (#121): fetches the writer's detail of pull requests before Ares reads them,
  // the hour the daily summary is due from (the end-to-end tests start it at midnight), and word of
  // each one written.
  prepareWriterDetails?: (itemIds: readonly string[]) => Promise<void>;
  summaryHour?: number;
  onSummaryWritten?: (itemId: string) => void;
  log?: (message: string) => void;
};

export type Agent = {
  runner: JobRunner;
  // The User's side of Ares's filing: answering the dashed Badge, and his filing record.
  filing: Filing;
  // The User changed these Items (through the window).
  userChanged(itemIds: string[]): void;
  synced(event: SyncedEvent): void;
  // Ares did or suggested something through the gate (a suggested Todo, say).
  aresChanged(): void;
  // The machine is idle: catch-up work.
  idle(): void;
  // The User is at the machine (back after being away, or Commander started): the daily GitHub
  // summary may be due.
  active(): void;
  // Ares's GitHub summaries: what is due, and asking him for one (#121).
  githubSummaries: GitHubSummaries;
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
  // Ares set or cleared a Chat's waiting flag: open views catch up, and the Dashboard is ranked again.
  // A flagged Chat gets a suggested reply; one whose flag went loses it (#110).
  const flagsChanged = (itemIds: string[]) => {
    options.onItemsChanged?.(itemIds);
    runner.trigger({ kind: 'todos-changed', itemIds });
    dismissStale();
    runner.run(SUGGEST_TEAMS_REPLIES, itemIds);
  };
  const summaryJob = writeGitHubSummaryJob(itemStore, {
    now,
    onWritten: (itemId) => {
      options.onItemsChanged?.([itemId]);
      options.onSummaryWritten?.(itemId);
    },
  });
  const runner: JobRunner = createJobRunner({
    jobs: [
      suggestTodosJob(itemStore, { now }),
      rankDashboardJob(itemStore, { now }),
      spotStuckLinearJob(itemStore, { now, enqueue: options.enqueue ?? (() => {}), me: options.me }),
      spotWaitingJob(itemStore, { now, me: options.me, onChanged: flagsChanged }),
      fileIntoProjectsJob(itemStore, { now }),
      prepareMeetingsJob(itemStore, {
        now,
        enqueue: options.enqueue ?? (() => {}),
        onItemsChanged: options.onItemsChanged,
      }),
      suggestInvitationRepliesJob(itemStore, { now }),
      suggestChatTodosJob(itemStore, { now, me: options.me }),
      suggestTeamsRepliesJob(itemStore, { now, me: options.me }),
      blockTimeForTodosJob(itemStore, { now }),
      proposeEventsJob(itemStore, { now }),
      summaryJob,
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

  // Draft (#110) runs on request, outside the runner (it changes nothing), under an Organise action
  // of its own, so the Settings grid can switch it off.
  options.gate.registerAction({
    action: DRAFT_REPLIES,
    actionKind: 'organise',
    name: 'Draft replies',
    hint: 'Draft beside a Chat’s reply box: a reply for you to edit and send. It changes nothing',
  });

  const filing = createFiling({ itemStore, gate: options.gate });
  // Ares's filing suggestions the User or a Rule has since overruled, his suggested replies to
  // invitations the User has since answered (or that are over), and his suggested Teams replies to
  // Chats no longer waiting on the User: they no longer stand.
  const dismissStale = () => {
    try {
      filing.dismissStale();
      dismissAnsweredInvitations(itemStore, options.gate, now());
      dismissSettledReplies(itemStore, options.gate);
    } catch (error) {
      options.log?.(`Couldn’t settle Ares’s suggestions that no longer stand: ${error}`);
    }
  };

  // A recurring series filed once: its other instances follow the one Ares or the User filed.
  const series = createSeriesFiling({ itemStore, gate: options.gate, now });
  const fileSeries = () => {
    try {
      const filed = series.run();
      if (filed.length) options.onItemsChanged?.(filed);
    } catch (error) {
      options.log?.(`Couldn’t file a recurring series’ other instances: ${error}`);
    }
  };

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

  const githubSummaries = createGitHubSummaries({
    itemStore,
    runner,
    job: summaryJob,
    prepareWriterDetails: options.prepareWriterDetails,
    now,
    hour: options.summaryHour,
    log: options.log,
  });
  const summariesDue = () => void githubSummaries.due();

  // Anything the User wrote while Commander was closed (or before it last ran): once the pause is
  // up, the jobs that follow typing look at what changed since their last run.
  runner.trigger({ kind: 'typing', itemIds: [] });
  // The meetings ahead, for the jobs that run before them (meeting prep).
  runner.replan();
  // Commander starting counts as the User being here: the daily GitHub summary may be due.
  summariesDue();

  return {
    runner,
    filing,

    userChanged(itemIds) {
      lastChange = now();
      caughtUp = false;
      dismissStale();
      fileSeries();
      const blocks = itemIds.filter((id) => itemStore.get(id)?.item.kind === 'block');
      if (blocks.length) runner.trigger({ kind: 'typing', itemIds: blocks });
      const ranked = itemIds.filter((id) => RANKED_KINDS.has(itemStore.get(id)?.item.kind ?? ''));
      if (ranked.length) runner.trigger({ kind: 'todos-changed', itemIds: ranked });
    },

    aresChanged() {
      runner.trigger({ kind: 'todos-changed', itemIds: [] });
    },

    synced({ source, account, itemIds }) {
      dismissStale();
      // The User replied in a Chat Ares flagged: the flag goes at once, with no call.
      if (source === 'teams') {
        try {
          const cleared = clearAnswered(itemStore, options.me ?? (() => null), now);
          if (cleared.length) flagsChanged(cleared);
        } catch (error) {
          options.log?.(`Couldn’t clear answered Chats: ${error}`);
        }
      }
      runner.trigger({ kind: 'source-sync', source, account });
      // A calendar sync may have moved, added or cancelled meetings: the times before them follow.
      if (source === 'google-calendar' || source === 'outlook-calendar') runner.replan();
      // What a sync brought (new and changed Items) is for Ares to file.
      if (itemIds.length) runner.trigger({ kind: 'items-arrived', itemIds });
      // Once Ares has looked, a series he filed brings its other instances along.
      void runner.settled().then(fileSeries);
    },

    idle,
    active: summariesDue,
    githubSummaries,

    stop() {
      clearInterval(watch);
      runner.stop();
    },
  };
}
