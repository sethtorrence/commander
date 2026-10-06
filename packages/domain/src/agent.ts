import { z } from 'zod';
import { modelTier } from './models';

// Ares's jobs (the Agent's work in the Core): each runs on its triggers, makes one model call and
// hands what comes back to the gate as proposals. This is what the window may see of them.

// What a job's last run came to, in a word.
export const jobOutcomes = [
  // It called the model and handed the gate what came back (possibly nothing).
  'ok',
  // Nothing new to look at: no model call.
  'nothing-to-do',
  // The month's cap stopped the call; it runs again on its next trigger.
  'over-cap',
  // The model's reply didn't fit the job's schema, twice: discarded, never acted on.
  'invalid-reply',
  // The call failed (no key, the provider unavailable…); it runs again on its next trigger.
  'failed',
] as const;
export const jobOutcome = z.enum(jobOutcomes);
export type JobOutcome = z.infer<typeof jobOutcome>;

// One of Ares's jobs, as Settings → Ares lists it.
export const agentJobInfo = z.object({
  // Its id: what the usage ledger and the per-job thinking overrides know it by ('suggest-todos').
  job: z.string().min(1),
  // Its name, as the User sees it ("Suggest Todos").
  name: z.string().min(1),
  tier: modelTier,
  // Switched off in Settings → Ares, it never runs.
  enabled: z.boolean(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  lastOutcome: jobOutcome.nullable(),
  // What went wrong last, in plain words (never a prompt, reply or key).
  lastProblem: z.string().nullable(),
});
export type AgentJobInfo = z.infer<typeof agentJobInfo>;

// Whether Ares is working (a job running) or idle, for the Ares status module.
export const aresStatus = z.object({
  working: z.boolean(),
  // The names of the jobs running now ("Suggest Todos").
  running: z.array(z.string()),
});
export type AresStatus = z.infer<typeof aresStatus>;

export const agentJobsState = z.object({ jobs: z.array(agentJobInfo), status: aresStatus });
export type AgentJobsState = z.infer<typeof agentJobsState>;

// How the Usage page names the jobs it lists; an id it doesn't know shows as it is.
export const AGENT_JOB_NAMES: Record<string, string> = {
  'suggest-todos': 'Suggest Todos',
  'rank-dashboard': 'Rank the Dashboard',
  'put-updates-together': 'Put Updates together',
  'spot-stuck-linear': 'Spot stuck Linear issues',
  'prepare-meetings': 'Prepare for meetings',
  'spot-waiting-on-you': 'Spot what’s waiting on you',
  'summarise-chat': 'Summarise Chat',
  'block-time-for-todos': 'Block time for Todos',
  'propose-events': 'Propose events',
  'suggest-todos-from-teams': 'Suggest Todos from Teams',
  'draft-reply': 'Draft a reply',
  'suggest-teams-replies': 'Suggest Teams replies',
  'write-github-summary': 'Write the GitHub summary',
  'learn-facts': 'Learn facts',
  // Email (#141).
  'sort-into-buckets': 'Sort into Buckets',
  'suggest-buckets': 'Suggest new Buckets',
  // Conversations with Ares (#191).
  conversation: 'Conversations',
  // Search by meaning (#73): the local embedding model's calls.
  'embed-index': 'Embed Items for search',
  'embed-query': 'Embed searches',
  'embed-lookup': 'Embed Memory lookups',
};

export const jobDisplayName = (job: string): string => AGENT_JOB_NAMES[job] ?? job;
