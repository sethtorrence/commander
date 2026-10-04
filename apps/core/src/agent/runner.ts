// The job runner: runs Ares's jobs on their triggers. Each job declares its name, tier, action
// (registered with the gate every time the runner starts), triggers, and how it gathers its input
// and turns the model's output into proposals. A run makes one model call under the job's name, so
// it lands on the Usage page, and hands what comes back to the gate. Ares never writes to the
// database himself: the gate decides, and the runner only keeps its own bookkeeping (where each job
// stands and what it has looked at) through the Item store.
//
// - Triggers: a pause in the User's typing (debounced per job), a Source sync, Items arriving, the
//   machine idle (catch-up work), and on request.
// - A queue with de-duplication: a job triggered again before it starts runs once, with every
//   trigger merged; one triggered while running runs once more afterwards. At most `concurrency`
//   jobs run at once, and never two runs of the same job.
// - Quick-job contract: one call, no tools, output validated against the job's fixed zod schema (the
//   model client retries once with the problem). A reply that still doesn't fit is discarded and
//   logged, never acted on; so are proposals the job or the gate refuses.
// - A switched-off job, or one whose action the Autonomy settings have Off, doesn't run at all.
// - A failed or over-cap call is logged and retried on the next trigger; after repeated failures (a
//   missing key and the cap aside) automatic triggers wait (1, 2, 4… minutes, at most an hour), while
//   a request always runs.
import {
  type ActionKind,
  type AgentJobInfo,
  type AresStatus,
  type AutonomySection,
  decide,
  type JobOutcome,
  type ModelTier,
  type Proposal,
  type ReasoningEffort,
  type Source,
} from '@commander/domain';
import { type ModelClient, ModelError } from '@commander/models';
import type { ZodType } from 'zod';
import type { Gate } from '../autonomy/gate';
import type { AgentStore } from '../item-store';
import { buildPrompt as defaultBuildPrompt, type PromptBuilder, type PromptParts } from './prompt';

export type Trigger =
  // The User changed these Items; a job hears of it once the typing pauses.
  | { kind: 'typing'; itemIds: string[] }
  | { kind: 'source-sync'; source: Source; account: string }
  | { kind: 'items-arrived'; itemIds: string[] }
  // The machine is idle: time for catch-up work.
  | { kind: 'idle' }
  | { kind: 'request' };
export type TriggerKind = Trigger['kind'];

// The triggers a job runs on, besides a request (which every job takes).
export type JobTriggers = {
  typing?: { pauseMs: number };
  'source-sync'?: true;
  'items-arrived'?: true;
  idle?: true;
};

// What a run looks at: each Item with a fingerprint of how it is now (a Block's text). Once the run
// is done they are remembered, with the proposal each led to, so they are never looked at again
// as they are; `cursor` (an activity entry) is where the job carries on from next time.
export type JobInput = { items: { itemId: string; fingerprint: string }[]; cursor?: number };

export type GatherContext = {
  // Every trigger since the job last ran, merged.
  triggers: Trigger[];
  // The activity entry the job got to, or null before its first run.
  cursor: number | null;
  // Whether the job has already looked at this Item as it is now.
  seen(itemId: string, fingerprint: string): boolean;
};

// A proposal as a job makes it: the runner adds the job's action.
export type JobProposal = Omit<Proposal, 'actionKind' | 'action' | 'section'>;

export type AgentJob<Input extends JobInput = JobInput, Output = unknown> = {
  // Its id: the usage ledger's job, and the key for per-job thinking overrides.
  job: string;
  // As the User sees it, in Settings and on the activity page ("Suggest Todos").
  name: string;
  tier: ModelTier;
  reasoningEffort?: ReasoningEffort;
  action: { action: string; actionKind: ActionKind; section: AutonomySection | null; hint?: string };
  triggers: JobTriggers;
  // What this run should look at, or null (or no items) when there is nothing to do: no call then.
  gather(context: GatherContext): Input | null;
  prompt(input: Input): PromptParts;
  // The fixed schema the model's JSON reply must fit.
  output: ZodType<Output>;
  // Turns the validated output into proposals; anything it can't use goes in `dropped`, in plain
  // words, to be logged.
  proposals(output: Output, input: Input): { proposals: JobProposal[]; dropped: string[] };
};

export type JobRunnerOptions = {
  // biome-ignore lint/suspicious/noExplicitAny: each job has its own input and output types
  jobs: AgentJob<any, any>[];
  client: ModelClient;
  gate: Pick<Gate, 'registerAction' | 'propose' | 'settings'>;
  store: AgentStore;
  now?: () => number;
  // How many jobs may run at once.
  concurrency?: number;
  // Overrides every job's typing pause (the end-to-end tests shorten it).
  typingPauseMs?: number;
  // How the prompt is put together (prompt.ts).
  buildPrompt?: PromptBuilder;
  // Where problems go: job names, outcomes and plain messages only, never a prompt, reply or key.
  log?: (message: string) => void;
  onStatus?: (status: AresStatus) => void;
};

export type JobRunner = {
  // Something happened that jobs may run on.
  trigger(trigger: Trigger): void;
  // Runs a job now, on request (even after failures).
  run(job: string): void;
  jobs(): AgentJobInfo[];
  // Switches a job on or off (Settings → Ares). Off, it never runs.
  setEnabled(job: string, enabled: boolean): AgentJobInfo[];
  status(): AresStatus;
  // Resolves once nothing is queued or running (typing pauses still waiting don't count).
  settled(): Promise<void>;
  stop(): void;
};

const MINUTE = 60_000;
const MAX_BACKOFF = 60 * MINUTE;

// After the first failure the next trigger tries again; after more, automatic triggers wait.
const backoff = (failures: number) =>
  failures < 2 ? 0 : Math.min(MINUTE * 2 ** (failures - 2), MAX_BACKOFF);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { client, gate, store, concurrency = 2, buildPrompt = defaultBuildPrompt } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const jobs = new Map(options.jobs.map((job) => [job.job, job]));

  // Every start: the gate knows each action, so the Settings grid can list it.
  for (const job of jobs.values()) {
    const { action, actionKind, hint } = job.action;
    gate.registerAction({ action, actionKind, name: job.name, ...(hint && { hint }) });
  }

  // Jobs waiting to run, each with every trigger since it was queued, in the order they were queued.
  const queued = new Map<string, Trigger[]>();
  const running = new Set<string>();
  const typing = new Map<string, { timer: ReturnType<typeof setTimeout>; itemIds: Set<string> }>();
  let waiters: (() => void)[] = [];
  let stopped = false;

  const status = (): AresStatus => ({
    working: running.size > 0,
    running: [...running].map((name) => jobs.get(name)?.name ?? name),
  });
  const reportStatus = () => options.onStatus?.(status());

  function info(job: AgentJob): AgentJobInfo {
    const state = store.job(job.job);
    return {
      job: job.job,
      name: job.name,
      tier: job.tier,
      enabled: state.enabled,
      lastRunAt: state.lastRunAt,
      lastOutcome: state.lastOutcome,
      lastProblem: state.lastProblem,
    };
  }

  function enqueue(name: string, trigger: Trigger) {
    if (stopped || !jobs.has(name)) return;
    queued.set(name, [...(queued.get(name) ?? []), trigger]);
    pump();
  }

  function pump() {
    for (const [name, triggers] of queued) {
      if (running.size >= concurrency) break;
      if (running.has(name)) continue;
      const job = jobs.get(name);
      queued.delete(name);
      if (!job) continue;
      running.add(name);
      reportStatus();
      void runJob(job, triggers)
        .catch((error) => log(`Ares's job “${job.name}” stopped: ${message(error)}`))
        .finally(() => {
          running.delete(name);
          reportStatus();
          pump();
        });
    }
    if (!queued.size && !running.size) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
    }
  }

  // Whether the User's Autonomy settings have the job's action Off.
  function isOff(job: AgentJob): boolean {
    const { action, actionKind, section } = job.action;
    return decide({ action, actionKind, section, confidence: 1, chained: false }, gate.settings()) === 'off';
  }

  // `counts`: whether the failure adds to the wait. No key (nothing was sent) and the cap (expected
  // until the month turns or the cap is raised) don't, so the first trigger after either is fixed runs.
  function failed(job: AgentJob, outcome: JobOutcome, problem: string, counts: boolean) {
    const failures = store.job(job.job).failures + (counts ? 1 : 0);
    const wait = counts ? backoff(failures) : 0;
    store.saveJob(job.job, {
      lastRunAt: now(),
      lastOutcome: outcome,
      lastProblem: problem,
      failures,
      retryAt: wait ? now() + wait : null,
    });
    log(`Ares's job “${job.name}”: ${outcome}. ${problem}`);
  }

  async function runJob(job: AgentJob, triggers: Trigger[]) {
    const state = store.job(job.job);
    if (!state.enabled || isOff(job)) return;
    const requested = triggers.some((trigger) => trigger.kind === 'request');
    if (!requested && state.retryAt !== null && now() < state.retryAt) return;

    const input = job.gather({
      triggers,
      cursor: state.cursor,
      seen: (itemId, fingerprint) => store.seen(job.job, itemId, fingerprint),
    });
    if (!input?.items.length) {
      store.saveJob(job.job, {
        cursor: input?.cursor ?? state.cursor,
        lastRunAt: now(),
        lastOutcome: 'nothing-to-do',
        lastProblem: null,
      });
      return;
    }

    let output: unknown;
    try {
      const reply = await client.complete({
        tier: job.tier,
        job: job.job,
        messages: buildPrompt(job.prompt(input)),
        schema: job.output,
        ...(job.reasoningEffort && { reasoningEffort: job.reasoningEffort }),
      });
      output = reply.json;
    } catch (error) {
      const kind = error instanceof ModelError ? error.kind : null;
      const outcome =
        kind === 'over-cap' ? 'over-cap' : kind === 'invalid-reply' ? 'invalid-reply' : 'failed';
      failed(job, outcome, message(error), kind !== 'no-key' && kind !== 'over-cap');
      return;
    }

    const { proposals, dropped } = job.proposals(output, input);
    for (const reason of dropped) log(`Ares's job “${job.name}” dropped a suggestion: ${reason}`);
    const proposalIds = new Map<string, number>();
    const { action, actionKind, section } = job.action;
    for (const proposal of proposals) {
      try {
        const outcome = gate.propose({ ...proposal, action, actionKind, section });
        if (outcome.decision === 'ask') proposalIds.set(proposal.itemId, outcome.suggestion.id);
        if (outcome.decision === 'auto') proposalIds.set(proposal.itemId, outcome.done.id);
      } catch (error) {
        log(`Ares's job “${job.name}”: the gate refused a proposal: ${message(error)}`);
      }
    }
    store.remember(
      job.job,
      input.items.map((item) => ({ ...item, proposalId: proposalIds.get(item.itemId) ?? null })),
    );
    store.saveJob(job.job, {
      cursor: input.cursor ?? state.cursor,
      lastRunAt: now(),
      lastOutcome: 'ok',
      lastProblem: null,
      failures: 0,
      retryAt: null,
    });
  }

  function typed(job: AgentJob, pauseMs: number, itemIds: string[]) {
    const waiting = typing.get(job.job);
    if (waiting) clearTimeout(waiting.timer);
    const ids = new Set([...(waiting?.itemIds ?? []), ...itemIds]);
    const timer = setTimeout(() => {
      typing.delete(job.job);
      enqueue(job.job, { kind: 'typing', itemIds: [...ids] });
    }, pauseMs);
    typing.set(job.job, { timer, itemIds: ids });
  }

  return {
    trigger(trigger) {
      if (stopped) return;
      for (const job of jobs.values()) {
        if (trigger.kind === 'request') enqueue(job.job, trigger);
        else if (trigger.kind === 'typing') {
          const pause = job.triggers.typing;
          if (pause) typed(job, options.typingPauseMs ?? pause.pauseMs, trigger.itemIds);
        } else if (job.triggers[trigger.kind]) enqueue(job.job, trigger);
      }
    },

    run(name) {
      enqueue(name, { kind: 'request' });
    },

    jobs: () => [...jobs.values()].map(info),

    setEnabled(name, enabled) {
      if (jobs.has(name)) store.saveJob(name, { enabled });
      return [...jobs.values()].map(info);
    },

    status,

    settled() {
      if (!queued.size && !running.size) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },

    stop() {
      stopped = true;
      for (const { timer } of typing.values()) clearTimeout(timer);
      typing.clear();
      queued.clear();
    },
  };
}
