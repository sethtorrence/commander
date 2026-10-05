// The job runner: runs Ares's jobs on their triggers. Each job declares its name, tier, action
// (registered with the gate every time the runner starts), triggers, and how it gathers its input
// and turns the model's output into proposals. A run makes one model call under the job's name, so
// it lands on the Usage page, and hands what comes back to the gate. Ares never writes to the
// database himself: the gate decides, and the runner only keeps its own bookkeeping (where each job
// stands and what it has looked at) through the Item store.
//
// - Triggers: a pause in the User's typing (debounced per job), a Source sync, Items arriving, the
//   machine idle (catch-up work), Todos changing (debounced per job), given times (`at`), one job's
//   own schedule (`due`, the daily GitHub summary), and on request (about given Items, when named).
// - Timed runs (`at`, #130): a job asks to run at given times (30 minutes before each meeting), each
//   with a key and a time past which it no longer matters. The runner asks again on `replan` (after a
//   calendar sync) and hourly, and looks for due times every 30 seconds, which also catches up after
//   the machine slept: a missed time runs if it still matters and is dropped otherwise. Each key runs
//   once; one whose call failed (or that waits out earlier failures) is tried again on a later tick.
// - A queue with de-duplication: a job triggered again before it starts runs once, with every
//   trigger merged; one triggered while running runs once more afterwards. At most `concurrency`
//   jobs run at once, and never two runs of the same job.
// - Quick-job contract: one call, no tools, output validated against the job's fixed zod schema (the
//   model client retries once with the problem). A reply that still doesn't fit is discarded and
//   logged, never acted on; so are proposals the job or the gate refuses.
// - Batches: a job with more material than one call should carry splits its input (`batch`); each
//   part is a prompt and a call of its own, and a failed part fails the run.
// - A job whose result is a view rather than a change to Items (ranking the Dashboard, a meeting's
//   prep) `apply`s every part's reply at once: nothing goes to the gate, and it applies at any level
//   above Off (ADR 0004's amendments). It may propose as well (the Todos a meeting asks for); those
//   go to the gate as any proposal does, under the action they name if not the job's own.
// - Prompt-injection defences (#69, ADR 0004): every prompt is built by the prompt builder
//   (prompt.ts), which refuses material holding a token or key the Core holds (nothing is sent).
//   Every reply schema carries a `steering` flag: the outside Items the model says try to steer Ares
//   get the warning mark. Every string in the reply is cleaned before the job sees it (the builder's
//   internal wording stripped, URLs the model wasn't shown removed) and checked against the schema
//   again. A proposal from a run that read outside Items says which one caused it, and is chained
//   (always Ask) unless it acts only on that Item itself; the gate checks the same again. One from a
//   run whose prompt held background (Memory's unconfirmed facts, #74) is always chained.
// - A switched-off job, or one whose action the Autonomy settings have Off, doesn't run at all.
// - A failed or over-cap call is logged and retried on the next trigger; after repeated failures (a
//   missing key and the cap aside) automatic triggers wait (1, 2, 4… minutes, at most an hour), while
//   a request always runs.
import {
  type ActionKind,
  type AgentJobInfo,
  type AresStatus,
  type AutonomySection,
  createdIn,
  decide,
  type JobOutcome,
  type ModelTier,
  type Proposal,
  type ReasoningEffort,
  type Source,
} from '@commander/domain';
import { type ModelClient, ModelError } from '@commander/models';
import { type ZodType, z } from 'zod';
import type { Gate } from '../autonomy/gate';
import type { AgentStore, InjectionWarningStore } from '../item-store';
import type { KnownSecrets } from '../safety/known-secrets';
import { cleanOutput, stripInternalWording } from '../safety/output';
import { type BuiltPrompt, buildPrompt, type PromptParts, PromptRefused } from './prompt';

export type Trigger =
  // The User changed these Items; a job hears of it once the typing pauses.
  | { kind: 'typing'; itemIds: string[] }
  | { kind: 'source-sync'; source: Source; account: string }
  | { kind: 'items-arrived'; itemIds: string[] }
  // Todos changed (made, ticked, edited, suggested); a job hears of it once they stop changing.
  | { kind: 'todos-changed'; itemIds: string[] }
  // The machine is idle: time for catch-up work.
  | { kind: 'idle' }
  // A time the job asked to run at came (or was missed while the machine slept and still matters).
  | ({ kind: 'at' } & PlannedRun)
  // Asked for by the User, about these Items when given (Prepare now on one meeting).
  | { kind: 'request'; itemIds?: string[] }
  // One job's own schedule says it has work due (the daily GitHub summary): only that job hears it,
  // and it waits out earlier failures like any automatic trigger.
  | { kind: 'due'; job: string };
export type TriggerKind = Trigger['kind'];

// One time a job asks to run at (`at`), as it plans them.
export type PlannedRun = {
  // What the time is for (an event at its start time): each key runs once.
  key: string;
  at: number;
  // Past this it no longer matters (the meeting has started): dropped if it was missed.
  until: number;
  // The Items it is for.
  itemIds: string[];
};

// The triggers a job runs on, besides a request (which every job takes).
export type JobTriggers = {
  typing?: { pauseMs: number };
  'source-sync'?: true;
  'items-arrived'?: true;
  idle?: true;
  'todos-changed'?: { pauseMs: number };
  // Given times (30 minutes before each meeting): asked for again on each re-plan (after a calendar
  // sync, and hourly).
  at?: { plan(now: number): PlannedRun[] };
};

// The triggers a job hears of only once they stop coming for its pause.
type Debounced = 'typing' | 'todos-changed';

// What a run looks at: each Item with a fingerprint of how it is now (a Block's text). Once the run
// is done they are remembered, with the proposal each led to, so they are never looked at again
// as they are; `cursor` (an activity entry) is where the job carries on from next time.
// `run`: call the model even with no Items to remember (the GitHub summary keeps what it wrote instead).
export type JobInput = { items: { itemId: string; fingerprint: string }[]; cursor?: number; run?: boolean };

export type GatherContext = {
  // Every trigger since the job last ran, merged.
  triggers: Trigger[];
  // The activity entry the job got to, or null before its first run.
  cursor: number | null;
  // Whether the job has already looked at this Item as it is now.
  seen(itemId: string, fingerprint: string): boolean;
};

// A proposal as a job makes it: the runner adds the job's action, and its Section unless the
// proposal names its own (a job working across Sections, like filing, follows each Item's). It may
// name another registered action instead (meeting prep proposes the Todos a meeting asks for to
// Suggest Todos).
export type JobProposal = Omit<Proposal, 'actionKind' | 'action' | 'section'> & {
  section?: AutonomySection | null;
  as?: Pick<Proposal, 'action' | 'actionKind' | 'section'>;
};

export type AgentJob<Input extends JobInput = JobInput, Output = unknown> = {
  // Its id: the usage ledger's job, and the key for per-job thinking overrides.
  job: string;
  // As the User sees it, in Settings and on the activity page ("Suggest Todos").
  name: string;
  tier: ModelTier;
  reasoningEffort?: ReasoningEffort;
  // `name`: the action's own name in the Settings grid, when it isn't the job's ("Reply to invitations").
  action: {
    action: string;
    actionKind: ActionKind;
    section: AutonomySection | null;
    hint?: string;
    name?: string;
  };
  // Further actions its proposals may name (`as`), registered with the gate alongside its own: Propose
  // events proposes time held for the User alone as Tidy your Sources beside its Act for you meetings.
  // The job runs while any of its actions is above Off.
  alsoActions?: AgentJob['action'][];
  triggers: JobTriggers;
  // What this run should look at, or null (or no items) when there is nothing to do: no call then.
  gather(context: GatherContext): Input | null;
  prompt(input: Input): PromptParts;
  // The fixed schema the model's JSON reply must fit.
  output: ZodType<Output>;
  // Splits the input into the parts sent in separate calls (each part its own prompt); one call
  // with the whole input when absent.
  batch?(input: Input): Input[];
  // Turns each part's validated output into proposals; anything it can't use goes in `dropped`, in
  // plain words, to be logged.
  proposals?(output: Output, input: Input): { proposals: JobProposal[]; dropped: string[] };
  // For a job whose result is a view, not a change to Items (ranking the Dashboard, a meeting's prep):
  // takes every part's validated output at once, before any proposals.
  apply?(answers: { output: Output; input: Input }[], input: Input): { dropped: string[] };
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
  // The tokens and keys the Core holds: a prompt whose material holds one is never sent.
  secrets?: KnownSecrets;
  // Where a reply's steering flag marks outside Items.
  injectionWarnings?: Pick<InjectionWarningStore, 'flag'>;
  // Items the runner itself changed (a warning mark), so open views can catch up.
  onItemsChanged?: (itemIds: string[]) => void;
  // Where problems go: job names, outcomes and plain messages only, never a prompt, reply or key.
  log?: (message: string) => void;
  onStatus?: (status: AresStatus) => void;
  // How often it looks for timed runs that are due (which also catches up after the machine slept);
  // null for no timer (tests tick by hand).
  tickMs?: number | null;
};

export type JobRunner = {
  // Something happened that jobs may run on.
  trigger(trigger: Trigger): void;
  // Runs a job now, on request (even after failures), about these Items when given.
  run(job: string, itemIds?: string[]): void;
  // Asks the timed jobs for their times again (after a calendar sync), and runs any already due.
  replan(): void;
  // Runs the timed runs that are due, and drops those that stopped mattering.
  tick(): void;
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
// How often timed runs are looked for, and how often the timed jobs are asked for their times again
// even without a calendar sync.
const TICK_MS = 30_000;
const REPLAN_MS = 60 * MINUTE;

// After the first failure the next trigger tries again; after more, automatic triggers wait.
const backoff = (failures: number) =>
  failures < 2 ? 0 : Math.min(MINUTE * 2 ** (failures - 2), MAX_BACKOFF);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Every job's reply may carry `steering`: the refs of outside blocks with text aimed at Ares or an
// AI. A malformed one counts as none rather than costing the reply.
const steering = z.object({ steering: z.array(z.string().max(20)).max(100).optional().catch(undefined) });
const withSteering = (schema: ZodType): ZodType =>
  schema instanceof z.ZodObject ? schema.extend(steering.shape) : z.intersection(schema, steering);
// The reply as the job's own schema knows it.
function withoutSteering(reply: unknown): unknown {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return reply;
  const { steering: _flag, ...rest } = reply as Record<string, unknown>;
  return rest;
}

// The value fitted to the schema, dropping list entries that don't fit (the deepest list entry each
// problem is in) until it does; null when something outside any list doesn't.
function fitting<T>(schema: ZodType<T>, value: unknown): { data: T; dropped: number } | null {
  const current = structuredClone(value);
  for (let dropped = 0; dropped <= 1000; dropped++) {
    const parsed = schema.safeParse(current);
    if (parsed.success) return { data: parsed.data, dropped };
    const path = parsed.error.issues[0]?.path ?? [];
    const at = path.findLastIndex((key) => typeof key === 'number');
    if (at < 0) return null;
    let list: unknown = current;
    for (const key of path.slice(0, at)) list = (list as Record<PropertyKey, unknown>)[key as PropertyKey];
    if (!Array.isArray(list)) return null;
    list.splice(path[at] as number, 1);
  }
  return null;
}

// The Items a proposal touches: the one it is about, and every existing Item its steps name,
// including what an Item it creates would sit in or be backed by (a Block's Daily Note and parent).
function touched(proposal: JobProposal): Set<string> {
  const ids = new Set([proposal.itemId]);
  for (const step of proposal.itemActions) {
    for (const target of [
      'itemId' in step ? step.itemId : undefined,
      'from' in step ? step.from : undefined,
      'to' in step ? step.to : undefined,
      ...(step.type === 'create' ? createdIn(step.item.detail) : []),
      ...(step.type === 'create-event' && step.event.copyOf ? [step.event.copyOf] : []),
    ]) {
      if (typeof target === 'string') ids.add(target);
    }
  }
  return ids;
}

// A proposal, checked before it goes to the gate: its reason loses the builder's wording, and from a
// run that read outside Items it names the one that caused it (the Item it acts on, if that is one,
// else the only one) and is chained unless it acts on that Item alone. From a run whose prompt held
// background (Memory's unconfirmed facts, #74) it is always chained: what Ares picked up from outside
// content is never more than background, so it can only ever lead to a Suggestion. Returns why it was
// dropped instead, when the cause can't be told.
function checked(proposal: JobProposal, prompt: BuiltPrompt): JobProposal | string {
  const reason = stripInternalWording(proposal.reason, prompt.material).trim() || 'Ares suggested this.';
  const outside = new Set(prompt.outside.map((block) => block.itemId));
  const background = prompt.background?.itemIds ?? [];
  if (!outside.size) {
    if (!prompt.background) return { ...proposal, reason };
    const causedBy = proposal.causedBy ?? (background[0] ? { itemId: background[0] } : undefined);
    return { ...proposal, reason, ...(causedBy && { causedBy }), chained: true };
  }
  let causedBy = proposal.causedBy;
  if (!causedBy?.itemId && !causedBy?.entryId) {
    const only = outside.size === 1 ? [...outside][0] : undefined;
    const itemId = outside.has(proposal.itemId) ? proposal.itemId : only;
    if (!itemId) return `it didn’t say which outside Item led to its suggestion on ${proposal.itemId}`;
    causedBy = { ...causedBy, itemId };
  }
  // With several outside Items read, any of them may have steered it: it can't be "on itself".
  const onItself =
    outside.size === 1 &&
    !prompt.background &&
    outside.has(proposal.itemId) &&
    causedBy.itemId === proposal.itemId;
  const alone = [...touched(proposal)].every((itemId) => itemId === proposal.itemId);
  return { ...proposal, reason, causedBy, chained: proposal.chained || !(onItself && alone) };
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { client, gate, store, concurrency = 2, secrets } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const jobs = new Map(options.jobs.map((job) => [job.job, job]));

  // Every start: the gate knows each action, so the Settings grid can list it.
  for (const job of jobs.values()) {
    for (const { action, actionKind, hint, name } of [job.action, ...(job.alsoActions ?? [])]) {
      gate.registerAction({ action, actionKind, name: name ?? job.name, ...(hint && { hint }) });
    }
  }

  // Jobs waiting to run, each with every trigger since it was queued, in the order they were queued.
  const queued = new Map<string, Trigger[]>();
  const running = new Set<string>();
  // Debounced triggers waiting for their pause, by job and trigger kind.
  const typing = new Map<string, { timer: ReturnType<typeof setTimeout>; itemIds: Set<string> }>();
  let waiters: (() => void)[] = [];
  let stopped = false;
  // Timed runs: each timed job's planned times, the keys already run (or dropped), when it last
  // planned, and the jobs whose last run should be tried again (its call failed).
  const planned = new Map<string, PlannedRun[]>();
  const fired = new Map<string, Set<string>>();
  let plannedAt: number | null = null;
  const retry = new Set<string>();

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
      retry.delete(name);
      void runJob(job, triggers)
        .catch((error) => log(`Ares's job “${job.name}” stopped: ${message(error)}`))
        .finally(() => {
          running.delete(name);
          // A timed run whose call failed (or that waits out earlier failures) is tried again on a
          // later tick, while it still matters.
          if (retry.delete(name)) {
            for (const trigger of triggers) if (trigger.kind === 'at') fired.get(name)?.delete(trigger.key);
          }
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

  // Whether the User's Autonomy settings have the job's action Off (every one of them, for a job with more).
  function isOff(job: AgentJob): boolean {
    return [job.action, ...(job.alsoActions ?? [])].every(
      ({ action, actionKind, section }) =>
        decide({ action, actionKind, section, confidence: 1, chained: false }, gate.settings()) === 'off',
    );
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
    if (outcome === 'failed' || outcome === 'over-cap') retry.add(job.job);
    log(`Ares's job “${job.name}”: ${outcome}. ${problem}`);
  }

  async function runJob(job: AgentJob, triggers: Trigger[]) {
    const state = store.job(job.job);
    if (!state.enabled || isOff(job)) return;
    const requested = triggers.some((trigger) => trigger.kind === 'request');
    if (!requested && state.retryAt !== null && now() < state.retryAt) {
      retry.add(job.job);
      return;
    }

    const input = job.gather({
      triggers,
      cursor: state.cursor,
      seen: (itemId, fingerprint) => store.seen(job.job, itemId, fingerprint),
    });
    if (!input?.items.length && !input?.run) {
      store.saveJob(job.job, {
        cursor: input?.cursor ?? state.cursor,
        lastRunAt: now(),
        lastOutcome: 'nothing-to-do',
        lastProblem: null,
      });
      return;
    }

    const parts = job.batch?.(input).filter((part) => part.items.length || part.run) ?? [input];
    const answers: { output: unknown; input: JobInput; prompt: BuiltPrompt }[] = [];
    for (const part of parts) {
      const answer = await ask(job, part);
      if (!answer) return;
      answers.push({ ...answer, input: part });
    }

    const { action, actionKind, section } = job.action;
    const proposalIds = new Map<string, number>();
    if (job.apply) {
      const { dropped } = job.apply(
        answers.map(({ output, input: part }) => ({ output, input: part })),
        input,
      );
      for (const reason of dropped) log(`Ares's job “${job.name}” left something out: ${reason}`);
    }
    for (const answer of answers) {
      const { proposals, dropped } = job.proposals?.(answer.output, answer.input) ?? {
        proposals: [],
        dropped: [],
      };
      for (const reason of dropped) log(`Ares's job “${job.name}” dropped a suggestion: ${reason}`);
      for (const raw of proposals) {
        const checkedProposal = checked(raw, answer.prompt);
        if (typeof checkedProposal === 'string') {
          log(`Ares's job “${job.name}” dropped a suggestion: ${checkedProposal}`);
          continue;
        }
        const { as, ...proposal } = checkedProposal;
        try {
          const outcome = gate.propose({
            ...proposal,
            ...(as ?? {
              action,
              actionKind,
              section: proposal.section === undefined ? section : proposal.section,
            }),
          });
          if (outcome.decision === 'ask') proposalIds.set(proposal.itemId, outcome.suggestion.id);
          if (outcome.decision === 'auto') proposalIds.set(proposal.itemId, outcome.done.id);
        } catch (error) {
          log(`Ares's job “${job.name}”: the gate refused a proposal: ${message(error)}`);
        }
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

  // One call for one part of a run's input: the prompt built, the model asked, its steering flag
  // heeded and its reply cleaned. Null when the call can't be made or its reply used (logged as the
  // job's outcome).
  async function ask(
    job: AgentJob,
    input: JobInput,
  ): Promise<{ output: unknown; prompt: BuiltPrompt } | null> {
    let prompt: BuiltPrompt;
    try {
      prompt = buildPrompt(job.prompt(input), { secrets });
    } catch (error) {
      if (!(error instanceof PromptRefused)) throw error;
      failed(job, 'failed', error.message, false);
      return null;
    }

    let reply: unknown;
    try {
      const answer = await client.complete({
        tier: job.tier,
        job: job.job,
        messages: prompt.messages,
        schema: withSteering(job.output),
        ...(job.reasoningEffort && { reasoningEffort: job.reasoningEffort }),
      });
      reply = answer.json;
    } catch (error) {
      const kind = error instanceof ModelError ? error.kind : null;
      const outcome =
        kind === 'over-cap' ? 'over-cap' : kind === 'invalid-reply' ? 'invalid-reply' : 'failed';
      failed(job, outcome, message(error), kind !== 'no-key' && kind !== 'over-cap');
      return null;
    }

    markSteering(job, prompt, reply);
    // Cleaned, the reply must still fit: an entry whose title was nothing but internal wording is
    // dropped, and the rest goes ahead. Nothing was wrong with the call, so it never adds to the wait.
    const cleaned = fitting(job.output, cleanOutput(withoutSteering(reply), prompt.material));
    if (!cleaned) {
      failed(
        job,
        'invalid-reply',
        'Its reply didn’t fit once Ares’s own wording and stray links were taken out',
        false,
      );
      return null;
    }
    if (cleaned.dropped)
      log(
        `Ares's job “${job.name}” dropped ${cleaned.dropped} part of its reply that didn’t fit once cleaned`,
      );
    return { output: cleaned.data, prompt };
  }

  // The reply's steering flag: each outside Item it names (by its block's ref) gets the warning mark.
  function markSteering(job: AgentJob, prompt: BuiltPrompt, reply: unknown) {
    const named = (reply as { steering?: string[] } | null)?.steering ?? [];
    const marked: string[] = [];
    for (const ref of new Set(named)) {
      const itemId = prompt.outside.find((block) => block.ref === ref)?.itemId;
      if (!itemId) continue;
      if (options.injectionWarnings?.flag(itemId)) marked.push(itemId);
    }
    if (marked.length) {
      log(`Ares's job “${job.name}” found instructions aimed at Ares in ${marked.length} outside Item(s)`);
      options.onItemsChanged?.(marked);
    }
  }

  function debounced(job: AgentJob, kind: Debounced, pauseMs: number, itemIds: string[]) {
    const key = `${job.job}\u0000${kind}`;
    const waiting = typing.get(key);
    if (waiting) clearTimeout(waiting.timer);
    const ids = new Set([...(waiting?.itemIds ?? []), ...itemIds]);
    const timer = setTimeout(() => {
      typing.delete(key);
      enqueue(job.job, { kind, itemIds: [...ids] });
    }, pauseMs);
    typing.set(key, { timer, itemIds: ids });
  }

  // Asks each timed job for its times; keys it no longer plans are forgotten. Then runs what is due.
  function replan() {
    if (stopped) return;
    plannedAt = now();
    for (const job of jobs.values()) {
      const at = job.triggers.at;
      if (!at) continue;
      let runs: PlannedRun[];
      try {
        runs = at.plan(plannedAt);
      } catch (error) {
        log(`Ares's job “${job.name}” couldn’t plan its times: ${message(error)}`);
        continue;
      }
      planned.set(job.job, runs);
      const keys = new Set(runs.map((run) => run.key));
      const done = fired.get(job.job);
      if (done) for (const key of done) if (!keys.has(key)) done.delete(key);
    }
    tick();
  }

  // Each planned time once: run when due (late, on waking, if it still matters), dropped when not.
  function tick() {
    if (stopped) return;
    if (planned.size && plannedAt !== null && now() - plannedAt >= REPLAN_MS) return replan();
    const at = now();
    for (const [name, runs] of planned) {
      const done = fired.get(name) ?? new Set<string>();
      fired.set(name, done);
      for (const run of runs) {
        if (done.has(run.key) || at < run.at) continue;
        done.add(run.key);
        if (at < run.until) enqueue(name, { kind: 'at', ...run });
      }
    }
  }

  const tickMs = options.tickMs === undefined ? TICK_MS : options.tickMs;
  const ticker = tickMs ? setInterval(tick, tickMs) : null;

  return {
    trigger(trigger) {
      if (stopped) return;
      for (const job of jobs.values()) {
        if (trigger.kind === 'request') enqueue(job.job, trigger);
        else if (trigger.kind === 'due') {
          if (trigger.job === job.job) enqueue(job.job, trigger);
        } else if (trigger.kind === 'typing') {
          const pause = job.triggers.typing;
          if (pause) debounced(job, 'typing', options.typingPauseMs ?? pause.pauseMs, trigger.itemIds);
        } else if (trigger.kind === 'todos-changed') {
          const pause = job.triggers['todos-changed'];
          if (pause) debounced(job, 'todos-changed', pause.pauseMs, trigger.itemIds);
        } else if (job.triggers[trigger.kind]) enqueue(job.job, trigger);
      }
    },

    run(name, itemIds) {
      enqueue(name, itemIds?.length ? { kind: 'request', itemIds } : { kind: 'request' });
    },

    replan,
    tick,

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
      if (ticker) clearInterval(ticker);
      for (const { timer } of typing.values()) clearTimeout(timer);
      typing.clear();
      queued.clear();
    },
  };
}
