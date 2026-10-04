import { z } from 'zod';
import { type AgentJobsState, agentJobsState } from './agent';
import {
  type AresActivity,
  type AutonomySettings,
  aresActivity,
  autonomyLevel,
  autonomySettings,
  autonomyTarget,
  type ProposalOutcome,
  type ProposalRecord,
  proposal,
  proposalQuery,
  proposalRecord,
  type RegisteredAction,
  registeredAction,
} from './autonomy';

// What the window may ask of the gate: read and change the Autonomy settings, and see, accept,
// dismiss and undo what Ares did or suggested. Validated in the main process and again in the Core.
// The window can never propose: only Ares's jobs in the Core do.
const proposalId = z.number().int().positive();

export const autonomyRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('settings') }),
  z.object({ op: z.literal('set-level'), target: autonomyTarget, level: autonomyLevel.nullable() }),
  z.object({ op: z.literal('activity'), query: proposalQuery.default({}) }),
  z.object({ op: z.literal('accept'), proposalId }),
  z.object({ op: z.literal('dismiss'), proposalId }),
  z.object({ op: z.literal('accept-all'), proposalIds: z.array(proposalId).min(1) }),
  z.object({ op: z.literal('undo'), proposalId }),
  // Ares's jobs (agent.ts): the list with whether he is working, switching one on or off in
  // Settings → Ares, and running one now.
  z.object({ op: z.literal('jobs') }),
  z.object({ op: z.literal('set-job-enabled'), job: z.string().min(1), enabled: z.boolean() }),
  z.object({ op: z.literal('run-job'), job: z.string().min(1) }),
]);
export type AutonomyRequest = z.input<typeof autonomyRequest>;
export type AutonomyOp = AutonomyRequest['op'];

// The settings, with the actions jobs have registered so the grid can list them.
export const autonomyState = z.object({ settings: autonomySettings, actions: z.array(registeredAction) });
export type AutonomyState = { settings: AutonomySettings; actions: RegisteredAction[] };

export type AutonomyResults = {
  settings: AutonomyState;
  'set-level': AutonomyState;
  activity: AresActivity[];
  accept: ProposalRecord;
  dismiss: ProposalRecord;
  'accept-all': ProposalRecord[];
  undo: AresActivity;
  jobs: AgentJobsState;
  'set-job-enabled': AgentJobsState;
  'run-job': AgentJobsState;
};

export const autonomyResult = {
  settings: autonomyState,
  'set-level': autonomyState,
  activity: z.array(aresActivity),
  accept: proposalRecord,
  dismiss: proposalRecord,
  'accept-all': z.array(proposalRecord),
  undo: aresActivity,
  jobs: agentJobsState,
  'set-job-enabled': agentJobsState,
  'run-job': agentJobsState,
} satisfies Record<AutonomyOp, z.ZodType>;

// For end-to-end tests only: the main process accepts these from the test harness, never from the
// window, and the Core answers them only when started with --test-hooks.
export const autonomyTestRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('register-action'), action: registeredAction }),
  z.object({ op: z.literal('propose'), proposal }),
]);
export type AutonomyTestRequest = z.input<typeof autonomyTestRequest>;
export type AutonomyTestResults = { 'register-action': null; propose: ProposalOutcome };
export const autonomyTestResult = {
  'register-action': z.null(),
  propose: z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('off') }),
    z.object({ decision: z.literal('ask'), suggestion: proposalRecord }),
    z.object({ decision: z.literal('auto'), done: proposalRecord }),
  ]),
} satisfies Record<AutonomyTestRequest['op'], z.ZodType>;

export type AutonomyResponse<Op extends AutonomyOp = AutonomyOp> =
  | { ok: true; result: AutonomyResults[Op] }
  | { ok: false; error: string };

// The envelopes between the main process and the Core, for both kinds of request.
export const AUTONOMY_MESSAGES = {
  window: { request: 'autonomy-request', reply: 'autonomy-reply' },
  test: { request: 'autonomy-test-request', reply: 'autonomy-test-reply' },
} as const;
